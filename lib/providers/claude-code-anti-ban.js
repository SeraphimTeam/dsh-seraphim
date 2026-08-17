/**
 * Anti-ban engine for the Claude Code OAuth provider.
 *
 * Inspired by the claude-oauth-proxy reference (kobie3717/claude-oauth-proxy)
 * and adapted to run inside the DSH adapter rather than as a separate proxy.
 * Makes outbound requests statistically indistinguishable from a real
 * Claude Code CLI session: human timing, session burst patterns, header
 * fingerprint rotation, per-minute/hour/day rate governance, circuit
 * breaker, model pinning, and serial concurrency.
 *
 * Everything here is pure state; no secrets, no network.
 */

import { randomBytes } from "node:crypto";

/** Known-good Claude Code CLI versions, newest first. */
const KNOWN_CLI_VERSIONS = ["2.1.233", "2.1.229", "2.1.162", "2.1.150", "2.1.92"];

/** Stainless SDK versions paired with the CLI versions above. */
const KNOWN_STAINLESS_VERSIONS = ["0.112.1", "0.94.0", "0.90.0", "0.80.0"];

/** OS / arch combos that match real desktop Claude Code installs. */
const KNOWN_PLATFORMS = [
  { os: "Windows", arch: "x64", runtime: "node", runtimeVersion: "v24.3.0" },
  { os: "Windows", arch: "x64", runtime: "node", runtimeVersion: "v22.22.2" },
  { os: "MacOS", arch: "arm64", runtime: "node", runtimeVersion: "v24.14.0" },
  { os: "Linux", arch: "x64", runtime: "node", runtimeVersion: "v22.14.0" },
];

/** Window sizes for the rate governor, matching human capacity. */
const WINDOWS = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/** Default per-window caps (a busy human developer). */
const DEFAULT_LIMITS = { minute: 8, hour: 100, day: 600 };

/** Quiet hours (UTC hours, inclusive start, exclusive end). */
const DEFAULT_QUIET_HOURS = { start: 21, end: 4 };

/** Human timing bounds (ms). */
const DEFAULT_TIMING = {
  min: 500,
  max: 2800,
  logNormalMu: 7.0,
  logNormalSigma: 0.6,
  thinkingChance: 0.22,
  thinkingExtra: [1500, 7000],
  coffeeChance: 0.035,
  coffeeExtra: [15000, 60000],
  tabSwitchChance: 0.08,
  tabSwitchExtra: [5000, 20000],
  firstRequestDelay: [1200, 5000],
  postErrorDelay: [3000, 12000],
};

/** Session simulation defaults. */
const DEFAULT_SESSIONS = {
  burstSize: [3, 10],
  burstPause: [6000, 45000],
  microPauseChance: 0.35,
  microPause: [1000, 4000],
};

/** Circuit breaker defaults. */
const DEFAULT_CIRCUIT = {
  errorThreshold: 3,
  tripDuration: [60000, 300000],
  maxTrips: 5,
  longCooldown: 1800000,
};

/** Personas: distinct "team members" with unique timing/platform/style. */
const DEFAULT_PERSONAS = [
  {
    name: "lead-dev",
    platform: { os: "Windows", arch: "x64", runtime: "node", runtimeVersion: "v24.3.0" },
    preferredModels: ["claude-opus-4-6", "claude-sonnet-4-20250514"],
    versionBias: "latest",
    timing: {
      logNormalMu: 6.8,
      logNormalSigma: 0.5,
      thinkingChance: 0.15,
      coffeeChance: 0.03,
    },
    rates: { minute: 8, hour: 100, day: 500 },
    sessions: { burstSize: [4, 10] },
  },
  {
    name: "backend-dev",
    platform: { os: "Linux", arch: "x64", runtime: "node", runtimeVersion: "v22.14.0" },
    preferredModels: ["claude-sonnet-4-20250514"],
    versionBias: "recent",
    timing: {
      logNormalMu: 7.2,
      logNormalSigma: 0.7,
      thinkingChance: 0.28,
      coffeeChance: 0.05,
    },
    rates: { minute: 6, hour: 70, day: 350 },
    sessions: { burstSize: [2, 6] },
  },
  {
    name: "frontend-dev",
    platform: { os: "MacOS", arch: "arm64", runtime: "node", runtimeVersion: "v24.14.0" },
    preferredModels: ["claude-sonnet-4-20250514"],
    versionBias: "behind",
    timing: {
      logNormalMu: 7.5,
      logNormalSigma: 0.8,
      thinkingChance: 0.35,
      coffeeChance: 0.06,
    },
    rates: { minute: 5, hour: 50, day: 200 },
    sessions: { burstSize: [2, 5] },
  },
];

// ─────────────────────────────────────────────────────────────────────
// RNG / helpers
// ─────────────────────────────────────────────────────────────────────

/** Deterministic PRNG seeded from an opaque string (session-replayable). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(input) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function randomInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randomFloat(rng, min, max) {
  return rng() * (max - min) + min;
}

function pick(rng, items) {
  return items[Math.floor(rng() * items.length)];
}

/** UUID v4 (matches the real CLI's x-claude-code-session-id format). */
function uuidV4() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomHex(rng, len) {
  let s = "";
  const chars = "0123456789abcdef";
  for (let i = 0; i < len; i++) s += chars[Math.floor(rng() * 16)];
  return s;
}

function weightedPick(rng, items, valueKey = "v") {
  const total = items.reduce((sum, item) => sum + (item.weight ?? 1), 0);
  let r = rng() * total;
  for (const item of items) {
    r -= item.weight ?? 1;
    if (r <= 0) return item[valueKey];
  }
  return items[0][valueKey];
}

/** Log-normal distributed delay via Box-Muller. */
function logNormalDelay(rng, mu, sigma, min, max) {
  const u1 = rng();
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1 || 1e-9)) * Math.cos(2 * Math.PI * u2);
  const delay = Math.exp(mu + sigma * z);
  return Math.max(min, Math.min(delay, max));
}

// ─────────────────────────────────────────────────────────────────────
// Fingerprint rotation
// ─────────────────────────────────────────────────────────────────────

/** Pick a plausible (version, platform, stainless) fingerprint. */
export function rotateFingerprint(sessionKey = "", overrides = {}) {
  const rng = mulberry32(hashSeed(sessionKey + ":" + Date.now()));
  const cliVersion = overrides.clientVersion ?? pick(rng, KNOWN_CLI_VERSIONS);
  const platform = overrides.platform ?? pick(rng, KNOWN_PLATFORMS);
  const stainless = overrides.stainless ?? pick(rng, KNOWN_STAINLESS_VERSIONS);
  return {
    cliVersion,
    os: platform.os,
    arch: platform.arch,
    runtime: platform.runtime,
    runtimeVersion: platform.runtimeVersion,
    stainless,
    sessionId: uuidV4(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Persona state
// ─────────────────────────────────────────────────────────────────────

function versionForBias(rng, bias, versions) {
  if (versions.length === 0) return undefined;
  if (bias === "latest") return versions[0];
  if (bias === "behind") {
    const start = Math.min(2, versions.length - 1);
    return versions[randomInt(rng, start, versions.length - 1)];
  }
  return weightedPick(rng, versions.map((v) => ({ v })), "v");
}

function createPersonaState(rng, persona, config) {
  return {
    persona,
    rng,
    requestTimestamps: [],
    hourlyCount: 0,
    hourlyReset: Date.now() + WINDOWS.hour,
    dailyCount: 0,
    dailyReset: Date.now() + WINDOWS.day,

    currentBurstCount: 0,
    currentBurstTarget: randomInt(rng, ...(persona.sessions?.burstSize ?? config.sessions.burstSize)),
    inBreak: false,
    breakUntil: 0,

    currentVersion: versionForBias(rng, persona.versionBias ?? "recent", config.identity.versions),
    currentPlatform: persona.platform,
    sessionId: uuidV4(),
    pinnedModel: null,
    lastModel: null,

    consecutiveErrors: 0,
    circuitOpen: false,
    circuitOpenUntil: 0,
    tripCount: 0,
    totalErrors: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// AntiBanEngine - main stateful engine
// ─────────────────────────────────────────────────────────────────────

export class AntiBanEngine {
  constructor(options = {}) {
    const config = {
      timing: { ...DEFAULT_TIMING, ...(options.timing ?? {}) },
      sessions: { ...DEFAULT_SESSIONS, ...(options.sessions ?? {}) },
      circuit: { ...DEFAULT_CIRCUIT, ...(options.circuit ?? {}) },
      quietHours: options.quietHours ?? DEFAULT_QUIET_HOURS,
      identity: {
        versions: options.versions ?? KNOWN_CLI_VERSIONS.map((v) => ({ v })),
        platforms: options.platforms ?? KNOWN_PLATFORMS,
        stainless: options.stainless ?? KNOWN_STAINLESS_VERSIONS,
      },
      maxConcurrent: options.maxConcurrent ?? 1,
    };
    this.config = config;
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.personas = (options.personas ?? DEFAULT_PERSONAS).map((p) =>
      createPersonaState(Math.random, p, config),
    );
    this.state = this.personas[0];
    this.activeRequests = 0;
    this.requestQueue = [];
  }

  // ── Persona selection ──

  selectPersona() {
    const hourUTC = new Date().getUTCHours();
    const day = new Date().getUTCDay();
    const isWeekend = day === 0 || day === 6;
    const available = [];
    for (let i = 0; i < this.personas.length; i++) {
      const ps = this.personas[i];
      if (ps.inBreak && Date.now() < ps.breakUntil) continue;
      if (ps.circuitOpen && Date.now() < ps.circuitOpenUntil) continue;
      available.push(i);
    }
    if (available.length === 0) return 0;
    return available[Math.floor(Math.random() * available.length)];
  }

  // ── Timing ──

  getHumanDelay() {
    const state = this.state;
    const rng = state.rng;
    const timing = { ...this.config.timing, ...(state.persona.timing ?? {}) };

    if (state.consecutiveErrors > 0) {
      return randomInt(rng, ...this.config.timing.postErrorDelay);
    }
    if (state.currentBurstCount === 0 && state.requestTimestamps.length === 0) {
      return randomInt(rng, ...this.config.timing.firstRequestDelay);
    }

    const base = logNormalDelay(
      rng,
      timing.logNormalMu,
      timing.logNormalSigma,
      this.config.timing.min,
      this.config.timing.max,
    );

    if (rng() < timing.tabSwitchChance) return base + randomInt(rng, ...timing.tabSwitchExtra);
    if (rng() < timing.coffeeChance) return base + randomInt(rng, ...timing.coffeeExtra);
    if (rng() < timing.thinkingChance) return base + randomInt(rng, ...timing.thinkingExtra);
    if (rng() < this.config.sessions.microPauseChance) {
      return base + randomInt(rng, ...this.config.sessions.microPause);
    }
    return base;
  }

  maybeSessionRotation() {
    const state = this.state;
    const now = Date.now();
    if (state.inBreak) {
      if (now < state.breakUntil) return state.breakUntil - now;
      state.inBreak = false;
    }
    state.currentBurstCount++;
    if (state.currentBurstCount >= state.currentBurstTarget) {
      state.currentBurstCount = 0;
      state.currentBurstTarget = randomInt(state.rng, ...(state.persona.sessions?.burstSize ?? this.config.sessions.burstSize));
      state.sessionId = uuidV4();
      state.pinnedModel = null;
      // Occasionally bump the version (auto-update behavior).
      if (state.rng() < 0.06) {
        state.currentVersion = versionForBias(state.rng, state.persona.versionBias ?? "recent", this.config.identity.versions);
      }
      return randomInt(state.rng, ...this.config.sessions.burstPause);
    }
    return 0;
  }

  // ── Rate limiting ──

  checkRateLimit() {
    const state = this.state;
    const now = Date.now();
    state.requestTimestamps = state.requestTimestamps.filter((t) => now - t < WINDOWS.minute);
    const rates = { ...this.limits, ...(state.persona?.rates ?? {}) };
    const multiplier = state.consecutiveErrors > 0 ? 0.5 : 1;
    const perMinute = Math.floor(rates.minute * multiplier);
    if (state.requestTimestamps.length >= perMinute) {
      return { ok: false, waitMs: state.requestTimestamps[0] + WINDOWS.minute - now + randomInt(state.rng, 500, 3000), reason: "per-minute" };
    }
    if (now > state.hourlyReset) { state.hourlyCount = 0; state.hourlyReset = now + WINDOWS.hour; }
    if (now > state.dailyReset) { state.dailyCount = 0; state.dailyReset = now + WINDOWS.day; }
    if (state.hourlyCount >= rates.hour) {
      return { ok: false, waitMs: state.hourlyReset - now + randomInt(state.rng, 1000, 5000), reason: "hourly" };
    }
    if (state.dailyCount >= rates.day) {
      return { ok: false, waitMs: state.dailyReset - now, reason: "daily" };
    }
    return { ok: true, waitMs: 0 };
  }

  recordRequest() {
    const state = this.state;
    state.requestTimestamps.push(Date.now());
    state.hourlyCount++;
    state.dailyCount++;
    state.lastRequestTime = Date.now();
  }

  // ── Circuit breaker ──

  recordError(statusCode) {
    const state = this.state;
    state.consecutiveErrors++;
    state.totalErrors++;
    if (state.consecutiveErrors >= this.config.circuit.errorThreshold) {
      state.circuitOpen = true;
      state.tripCount++;
      const cooldown =
        state.tripCount >= this.config.circuit.maxTrips
          ? this.config.circuit.longCooldown
          : randomInt(state.rng, ...this.config.circuit.tripDuration);
      state.circuitOpenUntil = Date.now() + cooldown;
    }
  }

  recordSuccess() {
    const state = this.state;
    state.consecutiveErrors = 0;
    if (state.circuitOpen && Date.now() > state.circuitOpenUntil) state.circuitOpen = false;
  }

  checkCircuitBreaker() {
    const state = this.state;
    if (!state.circuitOpen) return { ok: true };
    if (Date.now() > state.circuitOpenUntil) return { ok: true, halfOpen: true };
    return { ok: false, waitMs: state.circuitOpenUntil - Date.now(), reason: "circuit-breaker" };
  }

  // ── Concurrency (serial like a real CLI) ──

  async waitForSlot() {
    if (this.activeRequests < this.config.maxConcurrent) {
      this.activeRequests++;
      return;
    }
    await new Promise((resolve) => this.requestQueue.push(resolve));
    this.activeRequests++;
  }

  releaseSlot() {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (this.requestQueue.length > 0) {
      const next = this.requestQueue.shift();
      this.activeRequests++;
      next();
    }
  }

  // ── Main gate ──

  /**
   * Run the full anti-ban gate before a request.
   * Returns { proceed: true, headers } or { proceed: false, waitMs, reason }.
   */
  async antiBanGate() {
    this.state = this.personas[this.selectPersona()];

    const cb = this.checkCircuitBreaker();
    if (!cb.ok) return { proceed: false, waitMs: cb.waitMs, reason: cb.reason };

    const rate = this.checkRateLimit();
    if (!rate.ok) return { proceed: false, waitMs: rate.waitMs, reason: rate.reason };

    await this.waitForSlot();

    const sessionDelay = this.maybeSessionRotation();
    if (sessionDelay > 0) await sleep(Math.min(sessionDelay, 30000));

    const delay = this.getHumanDelay();
    if (delay > 0) await sleep(delay);

    this.recordRequest();
    return { proceed: true };
  }

  /** Call after the upstream response completes. */
  finish(gate) {
    if (gate) this.releaseSlot();
  }

  /** Get the current fingerprint (stable per session). */
  currentFingerprint(overrides = {}) {
    const state = this.state;
    return {
      cliVersion: overrides.clientVersion ?? state.currentVersion,
      os: state.currentPlatform.os,
      arch: state.currentPlatform.arch,
      runtime: state.currentPlatform.runtime,
      runtimeVersion: state.currentPlatform.runtimeVersion,
      stainless: pick(state.rng, this.config.identity.stainless),
      sessionId: state.sessionId,
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────
// Claude Code tool definitions (subset matching the real CLI)
// ─────────────────────────────────────────────────────────────────────

export function claudeCodeTools() {
  return [
    {
      name: "Bash",
      description: "Executes a bash command in the user's shell environment. Each command runs in its own shell process. Use for: running scripts, installing packages, searching files, compiling code, running tests, git operations, system administration.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to execute. Can be a single command or a pipeline." },
          timeout: { type: "number", description: "Optional timeout in seconds (default: 120)" },
        },
        required: ["command"],
      },
    },
    {
      name: "Read",
      description: "Reads the contents of a file at the specified path. Use for reading source code, configuration files, logs, or any text content. Supports partial reads with offset and limit.",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute or relative path to the file to read" },
          offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
          limit: { type: "number", description: "Maximum number of lines to read" },
        },
        required: ["file_path"],
      },
    },
    {
      name: "Write",
      description: "Creates or overwrites a file with the specified content. Use for creating new files or completely replacing file contents. Automatically creates parent directories if they don't exist.",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file to write" },
          content: { type: "string", description: "The complete content to write to the file" },
        },
        required: ["file_path", "content"],
      },
    },
    {
      name: "Edit",
      description: "Makes a targeted edit to a file by replacing an exact string match with new content. The old_string must match exactly (including whitespace and indentation). Use for precise, surgical edits to existing files.",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file to edit" },
          old_string: { type: "string", description: "The exact string to find and replace (must match exactly)" },
          new_string: { type: "string", description: "The replacement string" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
    {
      name: "Glob",
      description: "Finds files matching a glob pattern in the file system. Use for discovering files by extension, name pattern, or directory structure.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern (e.g., '**/*.ts', 'src/**/*.test.js')" },
          path: { type: "string", description: "Base directory to search from" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "Grep",
      description: "Searches for a regex pattern in files. Returns matching lines with file paths and line numbers. Use for finding code references, patterns, or text across files.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "File or directory to search in" },
          include: { type: "string", description: "File glob pattern to include (e.g., '*.ts')" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "WebSearch",
      description: "Search the web for current information.",
      input_schema: { type: "object", properties: {} },
    },
  ];
}
