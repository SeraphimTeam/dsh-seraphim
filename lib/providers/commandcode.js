import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";
import {
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  RetryPolicySchema,
  attributionHeaders,
  isContextWindowExceededError,
  resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

/**
 * dsh-commandcode — a native DeepSeek Harness provider for Command Code.
 *
 * The wire protocol was reverse-engineered by the pi-commandcode-provider
 * project (MIT, https://github.com/patlux/pi-commandcode-provider) against
 * the official `command-code` CLI, and independently cross-checked by the
 * dsh-commandcode-provider port (https://github.com/Mars-Sea/dsh-commandcode-provider).
 *
 * OAuth (browser-assisted, the official CLI flow):
 *   1. A local HTTP server binds 127.0.0.1:5959 (5959-5969 range).
 *   2. The browser opens https://commandcode.ai/studio/auth/cli?callback=...&state=...
 *   3. The user authenticates; the studio POSTs { apiKey, state, userId,
 *      userName, keyName } to the localhost /callback.
 *   4. If the browser cannot reach localhost, the studio shows "Copy your
 *      API key" and the user pastes it in the card instead.
 *
 * Chat:
 *   POST {apiBase}/alpha/generate  (Bearer apiKey)
 *   body: { config, memory, taste, skills,
 *           params: { model, messages, tools, system, max_tokens,
 *                     temperature, stream, reasoning_effort? }, threadId }
 *   response: JSON-lines events text-delta | reasoning-start/delta/end |
 *             tool-call | finish | error
 *   Model catalog: GET {apiBase}/provider/v1/models -> { object:'list', data:[...] }
 */

/** Cordis plugin name used by loader diagnostics. */
const name = "llm-commandcode";
/** Hard dependency: the LLM provider registry. */
const inject = ["llm"];

/** The provider route this plugin owns (appears in the model picker). */
const PROVIDER = "commandcode";
/** Settings namespace bound to this provider's config. */
const NS = settingsNamespace("llm-commandcode");

/** Plugin-owned HTTP routes used by the browser card. */
const STATUS_PATH = "/plugins/commandcode/auth/status";
const LOGIN_PATH = "/plugins/commandcode/auth/login";
const LOGOUT_PATH = "/plugins/commandcode/auth/logout";
const TOKEN_PATH = "/plugins/commandcode/auth/token";
const ACCOUNTS_PATH = "/plugins/commandcode/auth/accounts";
const PLANS_PATH = "/plugins/commandcode/plans";

/** Credential file inside the harness home (API keys never expire). */
const CREDENTIAL_FILE = ".commandcode-credentials.json";

/** Upstream endpoint (overridable with a self-hosted relay). */
const DEFAULT_API_BASE = "https://api.commandcode.ai";
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 64000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120000;
const MAX_TIMER_DELAY_MS = 2147483647;
const DEFAULT_MODELS_TIMEOUT_MS = 10000;
const MODEL_CACHE_VERSION = 1;

/** Official CLI version reported in request headers (command-code@1.26.0). */
const COMMAND_CODE_CLI_VERSION = "1.26.0";

/** Studio page used for the browser-assisted OAuth flow. */
const STUDIO_BASE_URL = "https://commandcode.ai";
const AUTH_CALLBACK_PATH = "/callback";
const AUTH_PORT_START = 5959;
const AUTH_PORT_RANGE = 10;

/** Model cache shared with the official CLI ecosystem. */
function defaultModelsCachePath() {
  return join(homedir(), ".commandcode", "models-cache.json");
}

/* ------------------------------------------------------------------ *
 * Model metadata (from the official command-code@1.26.0 model table,
 * cross-checked with https://commandcode.ai/docs/reference/cli/models)
 * ------------------------------------------------------------------ */

/** Selectable reasoning-effort levels per model. */
const KNOWN_EFFORTS = {
  "Qwen/Qwen3.8-Max": ["low", "medium", "xhigh"],
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "deepseek/deepseek-v4-flash": ["high", "max"],
  "deepseek/deepseek-v4-pro": ["high", "max"],
  "google/gemini-3.1-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.5-flash": ["low", "medium", "high"],
  "google/gemini-3.5-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.6-flash": ["low", "medium", "high"],
  "google/gemini-3.7-flash": ["low", "medium", "high"],
  "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
  "sakana/fugu-ultra": ["high", "xhigh"],
  "xai/grok-4.5": ["low", "medium", "high"],
  "xai/grok-4.6": ["low", "medium", "high", "xhigh"],
  "zai-org/GLM-5.2": ["high", "max"],
  "zai-org/GLM-5.3": ["low", "high", "max"],
};

/** Vision-capable models (official registry "Capabilities: Vision"). */
const KNOWN_IMAGE_MODELS = new Set([
  "MiniMaxAI/MiniMax-M3",
  "Qwen/Qwen3.6-Plus",
  "Qwen/Qwen3.7-Flash",
  "Qwen/Qwen3.7-Plus",
  "Qwen/Qwen3.8-Max",
  "claude-fable-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.5-flash",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.6-flash",
  "google/gemini-3.7-flash",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "meta/muse-spark-1.1",
  "meta/muse-spark-1.2",
  "meta/muse-spark-1.2-contributor",
  "moonshotai/Kimi-K2.5",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K2.7-Code-Highspeed",
  "moonshotai/Kimi-K3",
  "sakana/fugu-ultra",
  "stepfun/Step-3.7-Flash",
  "thinkingmachines/inkling",
  "thinkingmachines/inkling-small",
  "xai/grok-4.5",
  "xiaomi/mimo-v2.5",
]);

/** Minimum plan that includes a model (Go ⊂ GOAT ⊂ Pro ⊂ Provider/Max). */
const KNOWN_PLANS = {
  "MiniMaxAI/MiniMax-M2.5": "go",
  "MiniMaxAI/MiniMax-M2.7": "go",
  "MiniMaxAI/MiniMax-M3": "go",
  "Qwen/Qwen3.6-Max-Preview": "go",
  "Qwen/Qwen3.6-Plus": "go",
  "Qwen/Qwen3.7-Flash": "go",
  "Qwen/Qwen3.7-Max": "go",
  "Qwen/Qwen3.7-Plus": "go",
  "Qwen/Qwen3.8-Max": "go",
  "deepseek/deepseek-v4-flash": "go",
  "deepseek/deepseek-v4-pro": "go",
  "gpt-5.6-luna": "go",
  "meta/muse-spark-1.2-contributor": "go",
  "moonshotai/Kimi-K2.5": "go",
  "moonshotai/Kimi-K2.6": "go",
  "moonshotai/Kimi-K2.7-Code": "go",
  "moonshotai/Kimi-K2.7-Code-Highspeed": "go",
  "moonshotai/Kimi-K3": "go",
  "nvidia/nemotron-3-ultra-550b-a55b": "go",
  "poolside/laguna-s-2.1-free": "go",
  "stepfun/Step-3.5-Flash": "go",
  "stepfun/Step-3.7-Flash": "go",
  "tencent/hy3-paid": "go",
  "thinkingmachines/inkling": "go",
  "thinkingmachines/inkling-small": "go",
  "xai/grok-4.5": "go",
  "xiaomi/mimo-v2.5": "go",
  "xiaomi/mimo-v2.5-pro": "go",
  "zai-org/GLM-5": "go",
  "zai-org/GLM-5.1": "go",
  "zai-org/GLM-5.2": "go",
  "zai-org/GLM-5.2-Fast": "go",
  "zai-org/GLM-5.3": "go",
  "google/gemini-3.7-flash": "goat",
  "meta/muse-spark-1.2": "goat",
  "xai/grok-4.6": "goat",
  "claude-haiku-4-5-20251001": "pro",
  "claude-sonnet-4-6": "pro",
  "claude-sonnet-5": "pro",
  "google/gemini-3.1-flash-lite": "pro",
  "google/gemini-3.5-flash": "pro",
  "google/gemini-3.5-flash-lite": "pro",
  "google/gemini-3.6-flash": "pro",
  "gpt-5.3-codex": "pro",
  "gpt-5.4": "pro",
  "gpt-5.4-mini": "pro",
  "gpt-5.5": "pro",
  "gpt-5.6-sol": "pro",
  "gpt-5.6-terra": "pro",
  "meta/muse-spark-1.1": "pro",
  "claude-fable-5": "provider",
  "claude-opus-4-7": "provider",
  "claude-opus-4-8": "provider",
  "claude-opus-5": "provider",
  "sakana/fugu-ultra": "provider",
};

const PLAN_LABELS = { go: "Go", goat: "GOAT", pro: "Pro", provider: "Provider", max: "Max" };
const PLAN_ORDER = { go: 0, goat: 1, pro: 2, provider: 3, max: 4 };

/** The selectable plan tiers a user can toggle in the plugin card. */
const PLAN_TIERS = ["go", "goat", "pro", "provider"];

function planLabel(modelId) {
  const plan = KNOWN_PLANS[modelId];
  return plan === undefined ? undefined : PLAN_LABELS[plan];
}

function formatContext(contextWindow) {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  if (contextWindow >= 1e6) {
    const m = contextWindow / 1e6;
    const rounded = Math.round(m * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}M`;
  }
  return `${Math.floor(contextWindow / 1e3)}K`;
}

function capabilityDescription(modelId, contextWindow) {
  const parts = [];
  const plan = planLabel(modelId);
  if (plan !== undefined) parts.push(plan);
  if (KNOWN_IMAGE_MODELS.has(modelId)) parts.push("Image");
  const ctx = formatContext(contextWindow);
  if (ctx !== undefined) parts.push(ctx);
  return parts.join(" · ");
}

/** Human labels for the effort ladder (picker display). */
const EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

/** dsh-llm reasoning metadata for a model id, from KNOWN_EFFORTS. */
function reasoningInfo(modelId) {
  const efforts = KNOWN_EFFORTS[modelId];
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
  return {
    efforts: efforts.map((id) => ({ id, name: EFFORT_LABELS[id] ?? id })),
  };
}

/** Model comparator: lowest plan tier first, then name, then id. */
function compareByPlan(a, b) {
  const pa = PLAN_ORDER[KNOWN_PLANS[a.id] ?? ""] ?? Number.MAX_SAFE_INTEGER;
  const pb = PLAN_ORDER[KNOWN_PLANS[b.id] ?? ""] ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  const nameDiff = (a.name ?? a.id).localeCompare(b.name ?? b.id);
  if (nameDiff !== 0) return nameDiff;
  return a.id.localeCompare(b.id);
}

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
});

/** Runtime schema for the row's `config:` block. */
const Config = z.object({
  apiBase: z.string().default(DEFAULT_API_BASE),
  /** Optional pre-extracted API key (overrides the browser login store). */
  apiKey: z.string().role("secret"),
  /** Credential-reference name the Models page writes (default COMMANDCODE_API_KEY). */
  apiKeyEnv: z.string().role("credential-ref").default("COMMANDCODE_API_KEY"),
  workingDir: z.string().default(""),
  modelsCachePath: z.string().default(""),
  requestTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_REQUEST_TIMEOUT_MS),
  streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default([]),
  retryPolicy: RetryPolicySchema,
});

/* ------------------------------------------------------------------ *
 * Plan-filter store (persisted; which model tiers to show in the picker)
 * ------------------------------------------------------------------ */

function planFilterFile() {
  return join(resolveDshHome(), ".commandcode-plan-filter.json");
}

/**
 * Persist the set of plan tiers the user wants visible in the model picker.
 * Default: every tier checked (all plans shown). Stored as a plain array of
 * tier ids under the harness home so the card and the adapter agree.
 */
class PlanFilterStore {
  constructor(file = planFilterFile(), tiers = PLAN_TIERS) {
    this.file = file;
    this.tiers = tiers;
    this.cache = undefined;
  }

  read() {
    if (this.cache !== undefined) return this.cache;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      const list = Array.isArray(parsed?.tiers) ? parsed.tiers.filter((t) => this.tiers.includes(t)) : this.tiers;
      this.cache = list;
    } catch {
      this.cache = [...this.tiers];
    }
    return this.cache;
  }

  /** All currently enabled tiers (array of ids). */
  enabled() {
    return this.read();
  }

  /** Set which tiers are enabled; returns the new enabled list. */
  set(tiers) {
    const next = [...new Set((Array.isArray(tiers) ? tiers : []).filter((t) => this.tiers.includes(t)))];
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify({ tiers: next }, null, 2)}\n`, "utf8");
    } catch {
      /* read-only home: keep in memory */
    }
    this.cache = next;
    return next;
  }

  /** Public card view: every tier with its enabled state. */
  view() {
    const enabled = new Set(this.enabled());
    return this.tiers.map((tier) => ({ tier, label: PLAN_LABELS[tier] ?? tier, enabled: enabled.has(tier) }));
  }

  /** Whether a model id passes the current filter (unknown plans pass). */
  allows(modelId) {
    const plan = KNOWN_PLANS[modelId];
    if (plan === undefined) return true;
    return this.enabled().includes(plan);
  }
}

/* ------------------------------------------------------------------ *
 * Credential store (Command Code API keys never expire)
 * ------------------------------------------------------------------ */

function credentialFile() {
  return join(resolveDshHome(), CREDENTIAL_FILE);
}

/** Persist Command Code API-key accounts under the harness home. */
class CommandCodeCredentialStore {
  constructor(file = credentialFile()) {
    this.file = file;
  }

  read() {
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return undefined;
    }
  }

  write(doc) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(doc, null, 2), "utf8");
  }

  accounts() {
    const doc = this.read();
    const list = [];
    if (typeof doc?.apiKey === "string" && doc.apiKey.length > 0) {
      list.push({ apiKey: doc.apiKey, email: doc.email, userId: doc.userId, storedAt: doc.storedAt });
    }
    if (Array.isArray(doc?.accounts)) {
      for (const account of doc.accounts) {
        if (typeof account?.apiKey === "string" && account.apiKey.length > 0) list.push(account);
      }
    }
    return list;
  }

  /** Secret-free status for the browser card. */
  status() {
    const accounts = this.accounts();
    const signedIn = accounts.length > 0;
    return {
      status: signedIn ? "signed-in" : "signed-out",
      signedIn,
      accountCount: accounts.length,
      email: accounts[0]?.email,
      emails: accounts.map((account) => account.email).filter(Boolean),
    };
  }

  accessKeys() {
    return this.accounts().map((account) => account.apiKey);
  }

  /** Append an account (dedup by key) so several keys can rotate. */
  addAccount(apiKey, meta = {}) {
    const accounts = this.accounts();
    const existing = accounts.find((account) => account.apiKey === apiKey);
    if (existing) Object.assign(existing, meta, { storedAt: Date.now() });
    else accounts.push({ apiKey, ...meta, storedAt: Date.now() });
    this.write({ accounts });
  }

  /** Secret-free account metadata for the card (no apiKey). */
  listMeta() {
    return this.accounts().map((account, index) => ({
      index,
      email: typeof account.email === "string" && account.email.length > 0 ? account.email : `account-${index + 1}`,
      userName: typeof account.userName === "string" ? account.userName : undefined,
      keyName: typeof account.keyName === "string" ? account.keyName : undefined,
      storedAt: typeof account.storedAt === "number" ? account.storedAt : undefined,
    }));
  }

  removeAccount(selector) {
    const accounts = this.accounts();
    const next = accounts.filter((account, index) => {
      if (typeof selector === "number") return index !== selector;
      return account.email !== selector && account.userName !== selector;
    });
    if (next.length === accounts.length) return accounts.length;
    this.write({ accounts: next });
    return next.length;
  }

  clear() {
    try {
      writeFileSync(this.file, "{}", "utf8");
    } catch {
      /* read-only home: sign-out is best effort */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Browser-assisted OAuth (localhost callback, the official CLI flow)
 * ------------------------------------------------------------------ */

const PENDING_OAUTH = { flow: null };

function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

/** Refuse cross-origin browser writes while allowing same-origin/Origin-less calls. */
function trustedRequest(req) {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Start the one-shot localhost callback server the Command Code Studio POSTs
 * the API key to. Binds 127.0.0.1:5959 (5959-5969), then any free port.
 * Resolves { server, port, stateToken, waitForCallback } where
 * waitForCallback settles with { apiKey, state, userId, userName, keyName }
 * or { error } when the browser POSTs (or denies).
 */
function startCallbackServer(stateToken) {
  return new Promise((resolve, reject) => {
    let resolveCallback;
    let rejectCallback;
    const waitForCallback = new Promise((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });

    const server = createServer((req, res) => {
      const origin = req.headers.origin || "";
      const allowedOrigins = ["http://localhost:3000", "https://staging.commandcode.ai", "https://commandcode.ai"];
      const responseOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
      const requestedHeaders = req.headers["access-control-request-headers"];

      res.setHeader("Access-Control-Allow-Origin", responseOrigin);
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        typeof requestedHeaders === "string" && requestedHeaders.length > 0 ? requestedHeaders : "Content-Type",
      );
      // Chrome's Private Network Access preflight (HTTPS page → localhost HTTP).
      res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.setHeader("Content-Type", "application/json");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url !== AUTH_CALLBACK_PATH) {
        json(res, 404, { success: false, error: "Not found" });
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, { success: false, error: "Method not allowed. Use POST." });
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
        if (body.length > 10000) req.destroy();
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.error) {
            json(res, 200, { success: true });
            const description = typeof parsed.error_description === "string" ? parsed.error_description : String(parsed.error);
            rejectCallback(new Error(description || "Authorization was denied by the user"));
            server.close(() => {});
            return;
          }
          const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey : "";
          const state = typeof parsed.state === "string" ? parsed.state : "";
          const userId = typeof parsed.userId === "string" ? parsed.userId : "";
          const userName = typeof parsed.userName === "string" ? parsed.userName : "";
          const keyName = typeof parsed.keyName === "string" ? parsed.keyName : "";
          if (!apiKey || !state || !userId || !userName || !keyName) {
            json(res, 400, { success: false, error: "Missing required fields" });
            return;
          }
          json(res, 200, { success: true });
          resolveCallback({ apiKey, state, userId, userName, keyName });
          server.close(() => {});
        } catch {
          json(res, 400, { success: false, error: "Invalid JSON" });
        }
      });
      req.on("error", () => {
        json(res, 500, { success: false, error: "Request error" });
      });
    });

    const tryListen = (startPort, range, offset) => {
      const useFallbackPort = startPort === 0 || offset >= range;
      const port = useFallbackPort ? 0 : startPort + offset;
      const onError = (err) => {
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE" && !useFallbackPort) {
          tryListen(startPort, range, offset + 1);
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        resolve({ server, port: address.port, stateToken, waitForCallback });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    };
    tryListen(AUTH_PORT_START, AUTH_PORT_RANGE, 0);
  });
}

function cancelOAuthLogin() {
  const f = PENDING_OAUTH.flow;
  if (f) {
    f.cancelled = true;
    if (f.timer) clearTimeout(f.timer);
    try {
      f.server?.close?.();
    } catch {
      /* already closed */
    }
    PENDING_OAUTH.flow = null;
  }
}

/**
 * Start the browser-assisted login: bind the callback server, build the
 * Studio auth URL, and resolve when the callback POST arrives (5 min cap).
 */
async function startOAuthLogin(store) {
  if (PENDING_OAUTH.flow) return { ok: true, url: PENDING_OAUTH.flow.url };
  const stateToken = randomBytes(32).toString("base64url");
  let serverInfo;
  try {
    serverInfo = await startCallbackServer(stateToken);
  } catch (error) {
    return {
      ok: false,
      message: `Could not start the local auth server on port ${AUTH_PORT_START}: ${error instanceof Error ? error.message : String(error)}. Paste an API key below instead.`,
    };
  }
  const callbackUrl = `http://localhost:${serverInfo.port}${AUTH_CALLBACK_PATH}`;
  const authUrl = `${STUDIO_BASE_URL}/studio/auth/cli?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(stateToken)}`;
  const flow = {
    stateToken,
    server: serverInfo.server,
    port: serverInfo.port,
    url: authUrl,
    startedAt: Date.now(),
    deadline: Date.now() + 300000,
    cancelled: false,
    timer: null,
  };
  PENDING_OAUTH.flow = flow;

  const settle = (result) => {
    if (PENDING_OAUTH.flow !== flow) return;
    PENDING_OAUTH.flow = null;
    if (flow.timer) clearTimeout(flow.timer);
    try {
      flow.server.close?.();
    } catch {
      /* already closed */
    }
    if (result.error) return;
    const callback = result.callback;
    if (callback.state !== stateToken) {
      // CSRF guard: state mismatch is a failure, do not store the key.
      return;
    }
    store.addAccount(callback.apiKey, {
      email: undefined,
      userId: callback.userId,
      userName: callback.userName,
      keyName: callback.keyName,
    });
  };

  serverInfo.waitForCallback.then(
    (callback) => settle({ callback }),
    (error) => settle({ error }),
  );

  // Absolute deadline: drop the flow (and the server) after 5 minutes.
  flow.timer = setTimeout(() => {
    const f = PENDING_OAUTH.flow;
    if (f && f === flow) {
      PENDING_OAUTH.flow = null;
      try {
        f.server.close?.();
      } catch {
        /* already closed */
      }
    }
  }, 300000);

  return { ok: true, url: authUrl, waitForCallback: serverInfo.waitForCallback };
}

/* ------------------------------------------------------------------ *
 * Web auth routes (registered only when the host web server exists)
 * ------------------------------------------------------------------ */

function registerCommandCodeAuthRoutes(ctx, store, planFilter, options) {
  ctx.effect(() => {
    const routes = [
      ctx.webServer.register({
        kind: "exact",
        path: STATUS_PATH,
        handler: async (req, res) => {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          const st = store.status();
          json(res, 200, { ...st, pending: PENDING_OAUTH.flow !== null });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: LOGIN_PATH,
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          const result = await startOAuthLogin(store);
          if (!result.ok) return json(res, 502, { error: result.message });
          json(res, 200, { url: result.url });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: TOKEN_PATH,
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          const body = await readJsonBody(req);
          const raw = typeof body?.apiKey === "string" ? body.apiKey : "";
          const keys = raw
            .split(/[\n,;]+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 8);
          if (keys.length === 0) return json(res, 400, { error: "apiKey is required" });
          const email = typeof body?.email === "string" && body.email.length > 0 ? { email: body.email } : {};
          for (const key of keys) store.addAccount(key, email);
          json(res, 200, store.status());
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: ACCOUNTS_PATH,
        handler: async (req, res) => {
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          if (req.method === "GET") {
            json(res, 200, { accounts: store.listMeta() });
            return;
          }
          if (req.method === "DELETE") {
            const body = await readJsonBody(req);
            const selector = typeof body?.index === "number" ? body.index : typeof body?.email === "string" ? body.email : undefined;
            if (selector === undefined) return json(res, 400, { error: "email or index is required" });
            const before = store.status().accountCount;
            const count = store.removeAccount(selector);
            json(res, 200, { ...store.status(), removed: count < before, accountCount: count });
            return;
          }
          json(res, 405, { error: "method not allowed" });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: PLANS_PATH,
        handler: async (req, res) => {
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          if (req.method === "GET") {
            json(res, 200, { tiers: planFilter.view() });
            return;
          }
          if (req.method === "PUT") {
            const body = await readJsonBody(req);
            const tiers = Array.isArray(body?.tiers) ? body.tiers : undefined;
            if (tiers === undefined) return json(res, 400, { error: "tiers array is required" });
            const enabled = planFilter.set(tiers);
            json(res, 200, { tiers: planFilter.view(), enabled });
            return;
          }
          json(res, 405, { error: "method not allowed" });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: LOGOUT_PATH,
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          cancelOAuthLogin();
          store.clear();
          json(res, 200, { ok: true });
        },
      }),
    ];
    return async () => {
      cancelOAuthLogin();
      for (const dispose of routes) dispose();
    };
  }, "commandcode: web auth routes");
}

/* ------------------------------------------------------------------ *
 * Model catalog (live fetch with on-disk cache fallback)
 * ------------------------------------------------------------------ */

function parseCatalogResponse(value) {
  if (!value || typeof value !== "object" || value.object !== "list" || !Array.isArray(value.data)) {
    throw new LlmError("Unexpected Command Code models response shape", "PROVIDER_PROTOCOL_ERROR");
  }
  const models = [];
  for (const entry of value.data) {
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.id === "string" ? entry.id : undefined;
    const name = typeof entry.name === "string" ? entry.name : undefined;
    const contextLength = typeof entry.context_length === "number" && Number.isFinite(entry.context_length) ? entry.context_length : undefined;
    if (!id || !name || !contextLength || contextLength <= 0) continue;
    models.push({
      id,
      name,
      contextWindow: contextLength,
      maxTokens: Math.min(contextLength, 65536),
    });
  }
  if (models.length === 0) throw new LlmError("Command Code returned an empty model catalog", "PROVIDER_PROTOCOL_ERROR");
  return models;
}

async function readModelsCache(cachePath) {
  const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || parsed.version !== MODEL_CACHE_VERSION || !Array.isArray(parsed.models)) {
    throw new Error(`Invalid model cache at ${cachePath}`);
  }
  return parsed.models;
}

async function writeModelsCache(cachePath, models) {
  mkdirSync(dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ version: MODEL_CACHE_VERSION, models }, null, 2)}\n`, "utf8");
    // rename is atomic on POSIX; on Windows replace best-effort
    try {
      const { renameSync } = await import("node:fs");
      renameSync(tmp, cachePath);
    } catch {
      writeFileSync(cachePath, `${JSON.stringify({ version: MODEL_CACHE_VERSION, models }, null, 2)}\n`, "utf8");
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* cache writes are best-effort */
  }
}

/* ------------------------------------------------------------------ *
 * Message + event translation
 * ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordOrEmpty(value) {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      /* not json */
    }
  }
  return {};
}

function projectSlugFromPath(pathName) {
  const slug = pathName
    .toLowerCase()
    .replace(/^[a-z]:/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

function blockText(block) {
  return block.type === "text" || block.type === "reasoning" ? block.text : "";
}

function toolResultText(block) {
  return block.content.map(blockText).filter(Boolean).join("\n");
}

function pairedToolCallIds(messages) {
  const callIds = new Set();
  const resultIds = new Set();
  for (const message of messages) {
    for (const block of message.content) {
      if (message.role === "assistant" && block.type === "tool-call") callIds.add(block.id);
      if (block.type === "tool-result") resultIds.add(block.toolCallId);
    }
  }
  return new Set([...callIds].filter((id) => resultIds.has(id)));
}

/** Serialize dsh messages into the Command Code wire format. */
function messagesToCC(messages) {
  const out = [];
  const paired = pairedToolCallIds(messages);
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user" && message.source.kind !== "tool") {
      const parts = [];
      for (const block of message.content) {
        if (block.type === "text") parts.push({ type: "text", text: block.text });
      }
      out.push({ role: "user", content: parts });
      continue;
    }
    if (message.role === "assistant") {
      const parts = [];
      for (const block of message.content) {
        if (block.type === "text") parts.push({ type: "text", text: block.text });
        else if (block.type === "tool-call" && paired.has(block.id)) {
          parts.push({
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: recordOrEmpty(block.arguments),
          });
        }
      }
      if (parts.length > 0) out.push({ role: "assistant", content: parts });
      continue;
    }
    if (message.role === "user" && message.source.kind === "tool") {
      const block = message.content[0];
      if (!block || block.type !== "tool-result" || !paired.has(block.toolCallId)) continue;
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: block.toolCallId,
            toolName: "",
            output: block.isError ? { type: "error-text", value: toolResultText(block) } : { type: "text", value: toolResultText(block) },
          },
        ],
      });
    }
  }
  return out;
}

function parseStreamEventLine(line) {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return undefined;
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
  if (!trimmed || trimmed === "[DONE]") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function mapFinishReason(reason) {
  if (reason === "tool-calls") return { kind: "tool-calls" };
  if (reason === "length" || reason === "max_tokens" || reason === "max-tokens" || reason === "max_output_tokens") {
    return { kind: "max-tokens" };
  }
  return { kind: "stop" };
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    description: capabilityDescription(model.id, model.contextWindow),
    inputModalities: KNOWN_IMAGE_MODELS.has(model.id) ? ["text", "image"] : ["text"],
    ...(reasoningInfo(model.id) === undefined ? {} : { reasoning: reasoningInfo(model.id) }),
  };
}

class CommandCodeAdapter extends LlmAdapter {
  constructor(config) {
    super();
    this.config = config;
    this.catalog = [];
  }

  providerInfo(provider) {
    return { id: provider, name: "Command Code" };
  }

  providerRetryPolicy(_provider) {
    return this.config.options().retryPolicy;
  }

  async loadCatalog(signal) {
    const connection = this.config.options();
    try {
      const response = await fetch(`${connection.apiBase}/provider/v1/models`, {
        headers: { accept: "application/json", ...attributionHeaders() },
        signal: signal ?? AbortSignal.timeout(DEFAULT_MODELS_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`models endpoint returned ${response.status}`);
      this.catalog = parseCatalogResponse(await response.json());
      await writeModelsCache(connection.modelsCachePath, this.catalog).catch(() => {});
    } catch (error) {
      if (signal?.aborted) throw error;
      this.catalog = await readModelsCache(connection.modelsCachePath).catch(() => this.catalog);
    }
    return this.catalog;
  }

  listModels(provider) {
    const planFilter = this.config.planFilter;
    return this.loadCatalog().then((models) =>
      models
        .filter((model) => planFilter === undefined || planFilter.allows(model.id))
        .map((model) => modelInfo(provider, model))
        .sort(compareByPlan),
    );
  }

  resolveModel(provider, model, signal) {
    const entry = this.catalog.find((m) => m.id === model) ?? undefined;
    const connection = this.config.options();
    const configured = connection.models.find((m) => m.id === model);
    const fallback = configured ?? { id: model, name: model, contextWindow: connection.defaultContextWindow, maxTokens: connection.maxTokens };
    const base = entry ?? fallback;
    return Promise.resolve({
      ...modelInfo(provider, base),
      context: { contextWindow: base.contextWindow },
      defaultMaxTokens: Math.min(base.maxTokens ?? connection.maxTokens, 64000),
    });
  }

  async *stream(options) {
    const connection = this.config.options();
    const apiKey = await this.config.resolveApiKey();
    const modelMax = this.catalog.find((m) => m.id === options.model)?.maxTokens ?? 65536;
    const maxTokens = Math.min(options.maxTokens ?? modelMax, modelMax, 64000);
    const effort = options.reasoningEffort;
    const supported = KNOWN_EFFORTS[options.model];
    const reasoningEffort = effort && effort !== "off" && supported?.includes(effort) ? effort : undefined;
    const systemText = [
      options.system ?? "",
      ...options.messages.filter((m) => m.role === "system").map((m) => m.content.map(blockText).filter(Boolean).join("\n")),
    ]
      .filter(Boolean)
      .join("\n\n");
    const body = {
      config: {
        workingDir: connection.workingDir,
        date: new Date().toISOString().split("T")[0],
        environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
        structure: [],
        isGitRepo: false,
        currentBranch: "",
        mainBranch: "",
        gitStatus: "",
        recentCommits: [],
      },
      memory: null,
      taste: null,
      skills: null,
      params: {
        model: options.model,
        messages: messagesToCC(options.messages),
        tools: (options.tools ?? []).map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
        system: systemText,
        max_tokens: maxTokens,
        temperature: options.temperature ?? 0.3,
        stream: true,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
      threadId: randomUUID(),
    };

    let response;
    try {
      response = await fetch(`${connection.apiBase}/alpha/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          "x-command-code-version": COMMAND_CODE_CLI_VERSION,
          "x-cli-environment": "production",
          "x-project-slug": projectSlugFromPath(connection.workingDir),
          "x-taste-learning": "true",
          "x-co-flag": "false",
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(connection.requestTimeoutMs)])
          : AbortSignal.timeout(connection.requestTimeoutMs),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new LlmError(
        `commandcode: API request to ${connection.apiBase}/alpha/generate failed: ${error instanceof Error ? error.message : String(error)}`,
        "TRANSPORT",
        { cause: error },
      );
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      if (isContextWindowExceededError(errText)) {
        throw new LlmError(`commandcode: context window exceeded: ${errText.slice(0, 200)}`, CONTEXT_WINDOW_EXCEEDED_CODE, { status: response.status });
      }
      if (response.status === 401 || response.status === 403) {
        throw new LlmError(
          `commandcode: API error ${response.status} — the API key is missing or invalid; open Settings → Plugins → Command Code and authorize (or paste an API key)`,
          "AUTH",
          { status: response.status },
        );
      }
      if (response.status === 429) {
        throw new LlmError(`commandcode: API error 429 (rate limit): ${errText.slice(0, 200)}`, QUOTA_EXCEEDED_CODE, { status: 429 });
      }
      throw new LlmError(`commandcode: API error (HTTP ${response.status}): ${errText.slice(0, 300)}`, "SERVER", { status: response.status });
    }
    if (!response.body) throw new LlmError("commandcode: API returned no response body", "PROVIDER_PROTOCOL_ERROR");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let idleTimer;
    let idleFired = false;
    const armIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleFired = true;
        reader.cancel().catch(() => {});
      }, connection.streamIdleTimeoutMs);
    };
    const clearIdle = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    let nextIndex = 0;
    let textIndex = -1;
    let textContent = "";
    let reasoningIndex = -1;
    let reasoningContent = "";
    let sawContent = false;
    const closeText = function* () {
      if (textIndex < 0) return;
      yield { type: "block-end", index: textIndex, block: { type: "text", text: textContent } };
      textIndex = -1;
      textContent = "";
    };
    const closeReasoning = function* () {
      if (reasoningIndex < 0) return;
      yield { type: "block-end", index: reasoningIndex, block: { type: "reasoning", text: reasoningContent } };
      reasoningIndex = -1;
      reasoningContent = "";
    };
    const handleEvent = (event) => {
      const chunks = [];
      if (!isRecord(event)) return chunks;
      switch (event.type) {
        case "text-delta": {
          chunks.push(...closeReasoning());
          if (textIndex < 0) {
            textIndex = nextIndex++;
            chunks.push({ type: "block-start", index: textIndex, blockType: "text" });
          }
          const delta = stringValue(event.text) ?? "";
          textContent += delta;
          sawContent = true;
          chunks.push({ type: "text-delta", index: textIndex, text: delta });
          break;
        }
        case "reasoning-delta": {
          chunks.push(...closeText());
          if (reasoningIndex < 0) {
            reasoningIndex = nextIndex++;
            chunks.push({ type: "block-start", index: reasoningIndex, blockType: "reasoning" });
          }
          const delta = stringValue(event.text) ?? "";
          reasoningContent += delta;
          sawContent = true;
          chunks.push({ type: "reasoning-delta", index: reasoningIndex, text: delta });
          break;
        }
        case "reasoning-start":
          chunks.push(...closeText());
          break;
        case "reasoning-end":
          chunks.push(...closeReasoning());
          break;
        case "tool-call": {
          chunks.push(...closeText(), ...closeReasoning());
          const id = stringValue(event.toolCallId) ?? randomUUID();
          const name = stringValue(event.toolName) ?? "";
          const args = JSON.stringify(recordOrEmpty(event.input ?? event.args ?? event.arguments));
          const index = nextIndex++;
          sawContent = true;
          chunks.push(
            { type: "block-start", index, blockType: "tool-call" },
            { type: "tool-call-delta", index, id: CallId(id), name, argumentsDelta: args },
            { type: "block-end", index, block: { type: "tool-call", id: CallId(id), name, arguments: args } },
          );
          break;
        }
        case "finish": {
          chunks.push(...closeText(), ...closeReasoning());
          const usage = isRecord(event.totalUsage) ? event.totalUsage : undefined;
          if (usage) {
            const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined;
            const totalInput = numberValue(usage.inputTokens) ?? 0;
            const cacheRead = numberValue(details?.cacheReadTokens) ?? 0;
            const cacheWrite = numberValue(details?.cacheWriteTokens) ?? 0;
            const tokenUsage = {
              inputTokens: numberValue(details?.noCacheTokens) ?? Math.max(0, totalInput - cacheRead - cacheWrite),
              outputTokens: numberValue(usage.outputTokens) ?? 0,
              cacheReadTokens: cacheRead,
              cacheWriteTokens: cacheWrite,
            };
            chunks.push({ type: "usage", usage: tokenUsage });
          }
          chunks.push({ type: "finish", reason: mapFinishReason(event.finishReason) });
          break;
        }
        case "error": {
          const detail = isRecord(event.error)
            ? stringValue(event.error.message) ?? JSON.stringify(event.error)
            : stringValue(event.error) ?? stringValue(event.message) ?? "Stream error";
          throw new LlmError(`commandcode: stream error: ${detail}`, "PROVIDER_STREAM_ERROR");
        }
      }
      return chunks;
    };

    try {
      let finished = false;
      for (;;) {
        let read;
        armIdle();
        try {
          read = await reader.read();
        } catch (error) {
          if (options.signal?.aborted) throw error;
          throw new LlmError(`commandcode: API stream from ${connection.apiBase} failed while reading: ${error instanceof Error ? error.message : String(error)}`, "TRANSPORT", { cause: error });
        } finally {
          clearIdle();
        }
        const { done, value } = read;
        if (done) {
          if (idleFired) {
            throw new LlmError(`commandcode: API stream from ${connection.apiBase} was idle for ${connection.streamIdleTimeoutMs}ms (no events) and was treated as a dead connection`, "TIMEOUT");
          }
          if (buffer.trim()) {
            for (const chunk of handleEvent(parseStreamEventLine(buffer))) yield chunk;
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const chunks = handleEvent(parseStreamEventLine(line));
          for (const chunk of chunks) {
            yield chunk;
            if (chunk.type === "finish") finished = true;
          }
        }
        if (finished) break;
      }
      if (!finished) {
        yield* closeText();
        yield* closeReasoning();
        if (!sawContent) {
          throw new LlmError("commandcode: model returned a completed response with no content", EMPTY_RESPONSE_CODE);
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    } finally {
      clearIdle();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

/* ------------------------------------------------------------------ *
 * Config resolution + plugin apply
 * ------------------------------------------------------------------ */

function resolveModels(models) {
  const seen = new Set();
  return (models ?? []).map((model) => {
    if (!model.id) throw new Error(`commandcode: catalog model needs an id`);
    if (seen.has(model.id)) throw new Error(`commandcode: duplicate catalog model "${model.id}"`);
    seen.add(model.id);
    return {
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
  });
}

function resolveAdapterOptions(config) {
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error("commandcode: requestTimeoutMs must be a positive finite number");
  }
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error("commandcode: streamIdleTimeoutMs must be a positive finite number");
  }
  return {
    apiBase: config.apiBase ?? DEFAULT_API_BASE,
    workingDir: config.workingDir ?? process.cwd(),
    modelsCachePath: config.modelsCachePath ?? defaultModelsCachePath(),
    requestTimeoutMs,
    streamIdleTimeoutMs,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    retryPolicy: resolveRetryPolicy(config.retryPolicy, "commandcode: retryPolicy"),
  };
}

/** Read a usable Command Code credential from the official CLI auth file. */
function resolveAuthFileApiKey() {
  const authPath = join(homedir(), ".commandcode", "auth.json");
  try {
    if (!existsSync(authPath)) return undefined;
    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    if (!isRecord(parsed)) return undefined;
    const apiKeyFromRecord = (value) => {
      if (!isRecord(value)) return undefined;
      const type = stringValue(value.type);
      if (type === "api") return stringValue(value.key);
      if (type === "oauth") return stringValue(value.access);
      return stringValue(value.key) ?? stringValue(value.access);
    };
    const direct = stringValue(parsed.apiKey) ?? stringValue(parsed.commandcode);
    if (direct) return direct;
    return apiKeyFromRecord(parsed.commandcode) ?? apiKeyFromRecord(parsed["command-code"]);
  } catch {
    return undefined;
  }
}

function apply(ctx, config) {
  let current = () => config;
  let lastRaw;
  let lastGood;
  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    try {
      const next = resolveAdapterOptions(raw);
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === undefined) throw error;
      lastRaw = raw;
      ctx.logger?.error?.("commandcode: keeping the last good configuration after an invalid settings section");
      ctx.logger?.error?.(error);
      return lastGood;
    }
  };
  options();

  const store = new CommandCodeCredentialStore();
  const planFilter = new PlanFilterStore();

  const resolveApiKey = async () => {
    const cfg = current();
    if (typeof cfg.apiKey === "string" && cfg.apiKey.trim().length > 0) return cfg.apiKey.trim();
    const keys = store.accessKeys();
    if (keys.length > 0) return keys[0];
    const authFileKey = resolveAuthFileApiKey();
    if (authFileKey) return authFileKey;
    throw new LlmError(
      "commandcode: not signed in; open Settings → Plugins → Command Code and authorize in the browser",
      "AUTH",
    );
  };

  const adapter = new CommandCodeAdapter({
    options,
    resolveApiKey,
    planFilter,
  });
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: "Command Code", settingsNs: NS, settingsPath: [] }]);

  ctx.inject(["webServer"], (webCtx) => registerCommandCodeAuthRoutes(webCtx, store, planFilter, options));

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {},
  });
}

export {
  name,
  inject,
  PROVIDER,
  NS,
  Config,
  COMMAND_CODE_CLI_VERSION,
  DEFAULT_API_BASE,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  KNOWN_EFFORTS,
  KNOWN_IMAGE_MODELS,
  KNOWN_PLANS,
  PLAN_LABELS,
  PLAN_ORDER,
  PLAN_TIERS,
  CommandCodeAdapter,
  CommandCodeCredentialStore,
  PlanFilterStore,
  apply,
  capabilityDescription,
  compareByPlan,
  formatContext,
  planLabel,
  reasoningInfo,
  resolveAdapterOptions,
  resolveAuthFileApiKey,
};
