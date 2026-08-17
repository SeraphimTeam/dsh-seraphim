import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import {
  CallId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  RetryPolicySchema,
  attributionHeaders,
  isContextWindowExceededError,
  isQuotaExceededError,
  resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { ProviderFlagsStore } from "./provider-flags.js";

/**
 * FreeBuff — a native DeepSeek Harness provider for the Codebuff free models.
 *
 * The protocol implemented here was reverse-engineered by the freebuff2api
 * workers project (https://github.com/pingmike2/freebuff2api-wokers, AGPL-3.0),
 * itself based on XxxXTeam/freebuff2api. The upstream lifecycle is:
 *
 *   session → agent-runs → chat/completions
 *
 * 1. OAuth: POST /api/auth/cli/code {fingerprintId} → loginUrl;
 *    browser authorizes; poll GET /api/auth/cli/status until user.authToken.
 * 2. Session: GET /api/v1/freebuff/session reuses an active session for the
 *    same model; POST /api/v1/freebuff/session (x-freebuff-model +
 *    x-freebuff-instance-id) creates one and may return status "queued"
 *    (polled). Sessions last ~1h; only creation spends quota (6/day/account).
 * 3. Agent-runs: POST /api/v1/agent-runs START for the model's root agent and
 *    the `context-pruner` child; run ids are cached ~10min.
 * 4. Chat: POST /api/v1/chat/completions (Bearer token, x-freebuff-instance-id)
 *    with the system prompt prefixed by the canonical Buffy marker, an
 *    `end_turn` tool-signature when tools are present, `stop: ['"cb_easp"']`,
 *    `provider: { data_collection: "deny" }`, and `codebuff_metadata`
 *    carrying instance/run ids. The upstream forces streaming.
 */

/** Cordis plugin name used by loader diagnostics. */
const name = "llm-freebuff";
/** Hard dependency: the LLM provider registry. */
const inject = ["llm"];

/** The provider route this plugin owns (appears in the model picker). */
const PROVIDER = "freebuff";
/** Settings namespace bound to this provider's config. */
const NS = settingsNamespace("llm-freebuff");

/** Plugin-owned HTTP routes used by the browser card. */
const STATUS_PATH = "/plugins/freebuff/auth/status";
const LOGIN_PATH = "/plugins/freebuff/auth/login";
const LOGOUT_PATH = "/plugins/freebuff/auth/logout";
const TOKEN_PATH = "/plugins/freebuff/auth/token";
const ACCOUNTS_PATH = "/plugins/freebuff/auth/accounts";

/** Credential file inside the harness home (authToken + account metadata). */
const CREDENTIAL_FILE = ".freebuff-credentials.json";

/** Upstream endpoint (overridable with a self-hosted relay). */
const DEFAULT_BASE_URL = "https://www.codebuff.com";
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
const MAX_TIMER_DELAY_MS = 2147483647;

/** Upstream interaction budgets (from the reference worker). */
const SESSION_TIMEOUT_MS = 10000;
const CHAIN_GAP_MS = 300;
const SESSION_POLL_MS = 1500;
const SESSION_POLL_ATTEMPTS = 8;
const SESSION_TTL_MS = 55 * 60 * 1000;
const RUN_CACHE_TTL_MS = 10 * 60 * 1000;

/** Official SDK UA used by the reference clients for free-mode recognition. */
const SDK_UA = "ai-sdk/openai-compatible/0.0.141/codebuff";

/**
 * Official free-mode marker: the system prompt must start with this exact
 * string (byte-level check on the upstream side).
 */
const BUFFY = "You are Buffy, the strategic coding assistant.";

const CONTEXT_PRUNER_AGENT = "context-pruner";

/** Model → root agent mapping (Freebuff Desktop orchestrator, from the reference repo). */
const MODEL_TABLE = [
  { id: "mimo/mimo-v2.5", name: "MiMo V2.5", session: "mimo/mimo-v2.5", agent: "base2-free-mimo", upstream: "mimo/mimo-v2.5" },
  { id: "minimax/minimax-m3", name: "MiniMax M3", session: "minimax/minimax-m3", agent: "base2-free-minimax-m3", upstream: "minimax/minimax-m3" },
  { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna", session: "openai/gpt-5.6-luna", agent: "base2-free-luna", upstream: "openai/gpt-5.6-luna" },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", session: "deepseek/deepseek-v4-pro", agent: "base2-free-deepseek", upstream: "deepseek/deepseek-v4-pro" },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", session: "deepseek/deepseek-v4-flash", agent: "base2-free-deepseek-flash", upstream: "deepseek/deepseek-v4-flash" },
  { id: "z-ai/glm-5.2", name: "GLM 5.2", session: "z-ai/glm-5.2", agent: "base2-free-glm", upstream: "z-ai/glm-5.2" },
  { id: "poolside/laguna-s-2.1", name: "Laguna S 2.1", session: "poolside/laguna-s-2.1", agent: "base2-free-laguna-s-2-1", upstream: "poolside/laguna-s-2.1" },
  { id: "openrouter/poolside/laguna-s-2.1", name: "Laguna S 2.1 (OpenRouter)", session: "openrouter/poolside/laguna-s-2.1", agent: "base2-free-laguna-s-2-1-openrouter", upstream: "openrouter/poolside/laguna-s-2.1" },
  { id: "crof/kimi-k3-eco", name: "Kimi K3 Eco", session: "crof/kimi-k3-eco", agent: "base2-free-kimi-k3-eco", upstream: "crof/kimi-k3-eco" },
  { id: "anthropic/claude-fable-5", name: "Claude Fable 5", session: "anthropic/claude-fable-5", agent: "base2-free-fable", upstream: "anthropic/claude-fable-5" },
  { id: "meta/muse-spark-1.2-contributor", name: "Muse Spark 1.2", session: "meta/muse-spark-1.2-contributor", agent: "base2-free-muse-spark", upstream: "meta/muse-spark-1.2-contributor" },
];

/**
 * The only models an account in "limited" free access can chat with. The
 * upstream signals this with `session_model_mismatch` + the message
 * "Limited free access is only available with DeepSeek V4 Flash or MiMo 2.5."
 */
const LIMITED_MODELS = new Set(["deepseek/deepseek-v4-flash", "mimo/mimo-v2.5"]);

// Order flash/mimo first: they are the models a "limited" account can always
// use, so the picker's default lands on something that works.
const DEFAULT_MODELS = MODEL_TABLE.map((entry) => ({
  id: entry.id,
  name: entry.name ?? entry.id,
  session: entry.session,
  agent: entry.agent,
  upstream: entry.upstream,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
})).sort((a, b) => {
  const aLimited = LIMITED_MODELS.has(a.id) ? 0 : 1;
  const bLimited = LIMITED_MODELS.has(b.id) ? 0 : 1;
  return aLimited - bLimited;
});

/** Per-model reasoning-effort ceilings (official clamp semantics). */
const REASONING_EFFORT_RANK = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const MODEL_EFFORTS = {
  "deepseek/deepseek-v4-flash": ["low", "high", "max"],
  "deepseek/deepseek-v4-pro": ["high", "max"],
  "openai/gpt-5.6-luna": ["low", "medium", "high", "max"],
  "meta/muse-spark-1.2-contributor": ["low", "medium", "high", "xhigh"],
};

/** Human labels for the effort ladder (picker display). */
const EFFORT_LABELS = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
  ultra: "Ultra",
};

/** dsh-llm reasoning metadata for a model id, from MODEL_EFFORTS. */
function reasoningInfo(modelId) {
  const efforts = MODEL_EFFORTS[modelId];
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
  return {
    efforts: efforts.map((id) => ({
      id,
      name: EFFORT_LABELS[id] ?? id,
      ...(id === "max"
        ? { description: "Maximum reasoning depth (slowest, most accurate)" }
        : id === "low"
          ? { description: "Minimal reasoning for fast, simple tasks" }
          : id === "high"
            ? { description: "Deep reasoning for complex work" }
            : {}),
    })),
    // No defaultEffort: matches the reference worker, which forwards only what
    // the caller picks; omitting sends nothing and upstream applies its own default.
  };
}

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  session: z.string(),
  agent: z.string(),
  upstream: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
});

/** Runtime schema for the row's `config:` block. */
const Config = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  /** Optional pre-extracted authToken (overrides the browser login store). */
  authToken: z.string().role("secret"),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
});

/* ------------------------------------------------------------------ *
 * Small pure helpers (exported for tests)
 * ------------------------------------------------------------------ */

/** Deterministic client fingerprint (enhanced-<fnv>) for codebuff_metadata. */
function stableFingerprint(value) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = "freebuff-fp-v2:" + value;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return "enhanced-" + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** Generate the official legacy fingerprint format: codebuff-cli-<8 chars>. */
function genFingerprint() {
  return "codebuff-cli-" + randomBytes(6).toString("base64url").slice(0, 8);
}

/** Inject the canonical Buffy prefix into wire messages. */
function normalizeMessages(messages) {
  const out = [];
  let hasSystem = false;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const item = { ...m };
    if (item.role === "developer") item.role = "system";
    if (item.role === "system") {
      hasSystem = true;
      item.cache_control = { type: "ephemeral" };
      if (typeof item.content === "string") {
        if (!item.content.startsWith(BUFFY)) item.content = BUFFY + item.content;
      }
    }
    out.push(item);
  }
  if (!hasSystem) out.unshift({ role: "system", content: BUFFY, cache_control: { type: "ephemeral" } });
  return out;
}

/** Clamp a reasoning effort to the model's official ceiling (never rejects). */
function clampReasoningEffort(modelId, effort) {
  const allowed = MODEL_EFFORTS[modelId];
  if (!Array.isArray(allowed) || allowed.length === 0 || effort === undefined || effort === null) return effort;
  const wanted = REASONING_EFFORT_RANK.indexOf(String(effort));
  if (wanted < 0) return effort;
  let best = null;
  let bestRank = -1;
  for (const cand of allowed) {
    const rank = REASONING_EFFORT_RANK.indexOf(cand);
    if (rank < 0 || rank > wanted) continue;
    if (rank > bestRank) {
      best = cand;
      bestRank = rank;
    }
  }
  if (best !== null) return best;
  return allowed.reduce((lo, c) => (REASONING_EFFORT_RANK.indexOf(c) < REASONING_EFFORT_RANK.indexOf(lo) ? c : lo));
}

/** The end_turn tool-signature free-mode requests must carry when tools exist. */
const END_TURN_TOOL = {
  type: "function",
  function: { name: "end_turn", description: "Signal the end of the current task.", parameters: { type: "object", properties: {} } },
};

/* ------------------------------------------------------------------ *
 * OAuth credential store
 * ------------------------------------------------------------------ */

function credentialFile() {
  return join(resolveDshHome(), CREDENTIAL_FILE);
}

/** Persist the Freebuff account document(s) under the harness home. */
class FreeBuffCredentialStore {
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

  /** Normalize the legacy single-account and current multi-account shapes into a list. */
  accounts() {
    const doc = this.read();
    const list = [];
    if (typeof doc?.authToken === "string" && doc.authToken.length > 0) {
      list.push({ authToken: doc.authToken, email: doc.email, userId: doc.userId, credits: doc.credits, storedAt: doc.storedAt });
    }
    if (Array.isArray(doc?.accounts)) {
      for (const account of doc.accounts) {
        if (typeof account?.authToken === "string" && account.authToken.length > 0) list.push(account);
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

  accessTokens() {
    return this.accounts().map((account) => account.authToken);
  }

  /** Append an account (dedup by token) instead of overwriting, so several accounts can rotate. */
  addAccount(authToken, meta = {}) {
    const accounts = this.accounts();
    const existing = accounts.find((account) => account.authToken === authToken);
    if (existing) Object.assign(existing, meta, { storedAt: Date.now() });
    else accounts.push({ authToken, ...meta, storedAt: Date.now() });
    this.write({ accounts });
  }

  /** Secret-free account metadata for the card (no authToken). */
  listMeta() {
    return this.accounts().map((account, index) => ({
      index,
      email: typeof account.email === "string" && account.email.length > 0 ? account.email : `account-${index + 1}`,
      tier: typeof account.tier === "string" ? account.tier : undefined,
      quota: Array.isArray(account.quota) ? account.quota : undefined,
      credits: typeof account.credits === "number" ? account.credits : undefined,
      storedAt: typeof account.storedAt === "number" ? account.storedAt : undefined,
    }));
  }

  /** Remove an account by list index or by email; returns the new account count. */
  removeAccount(selector) {
    const accounts = this.accounts();
    const next = accounts.filter((account, index) => {
      if (typeof selector === "number") return index !== selector;
      return account.email !== selector;
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
 * Web auth routes (registered only when the host web server exists)
 * ------------------------------------------------------------------ */

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

/** Upstream OAuth state for one in-flight authorization poll. */
const PENDING_OAUTH = { flow: null };

/**
 * Authorization-code polling flow (aligned with the reference extract tool):
 * POST /api/auth/cli/code → loginUrl; poll /api/auth/cli/status every 5s for
 * up to 5 minutes until the upstream returns user.authToken.
 *
 * The upstream geo-gates this endpoint (non-US egress gets an opaque HTTP 500),
 * so failures return a descriptive message the card surfaces alongside the
 * token-paste alternative.
 */
async function startOAuthLogin(baseURL, store, logger) {
  if (PENDING_OAUTH.flow) return { ok: true, url: PENDING_OAUTH.flow.loginUrl };
  const fingerprintId = genFingerprint();
  let resp;
  let code;
  let lastError = "network error";
  // The upstream is flaky (transient 5xx bursts); retry once before reporting.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      resp = await fetch(`${baseURL}/api/auth/cli/code`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "user-agent": SDK_UA },
        body: JSON.stringify({ fingerprintId }),
        signal: AbortSignal.timeout(30000),
      });
      code = await resp.json().catch(() => undefined);
      if (resp.ok) break;
      lastError = `HTTP ${resp.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "network error";
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!resp?.ok) {
    return {
      ok: false,
      message: `Freebuff authorization is unavailable (${lastError}) — the upstream is flaky; retry, or paste an authToken below instead`,
    };
  }
  if (!code?.loginUrl || !code?.fingerprintHash) {
    return {
      ok: false,
      message: "Freebuff authorization returned an unexpected response; paste an authToken below instead",
    };
  }
  const flow = {
    loginUrl: code.loginUrl,
    fingerprintId,
    fingerprintHash: code.fingerprintHash,
    expiresAt: code.expiresAt ?? undefined,
    deadline: Date.now() + 300000,
    cancelled: false,
    timer: null,
  };
  PENDING_OAUTH.flow = flow;

  const poll = async () => {
    const f = PENDING_OAUTH.flow;
    if (!f || f !== flow || f.cancelled || Date.now() > f.deadline) {
      PENDING_OAUTH.flow = null;
      return;
    }
    const query = new URLSearchParams({
      fingerprintId: f.fingerprintId,
      fingerprintHash: f.fingerprintHash,
      ...(f.expiresAt !== undefined ? { expiresAt: String(f.expiresAt) } : {}),
    });
    let status = 0;
    let data;
    try {
      const resp = await fetch(`${baseURL}/api/auth/cli/status?${query}`, {
        headers: { accept: "application/json", "user-agent": SDK_UA },
        signal: AbortSignal.timeout(30000),
      });
      status = resp.status;
      data = await resp.json().catch(() => undefined);
    } catch {
      /* transient; keep polling */
    }
    if (status === 200 && data?.user?.authToken) {
      const user = data.user;
      store.addAccount(user.authToken, {
        email: typeof user.email === "string" ? user.email : undefined,
        userId: typeof user.id === "string" ? user.id : typeof user.id === "number" ? user.id : undefined,
        credits: typeof user.credits === "number" ? user.credits : undefined,
      });
      probeAndStoreTier(store, baseURL, user.authToken).catch(() => {});
      PENDING_OAUTH.flow = null;
      return;
    }
    if (status === 400) {
      PENDING_OAUTH.flow = null;
      logger?.error?.("freebuff: authorization request expired");
      return;
    }
    flow.timer = setTimeout(poll, 5000);
  };
  flow.timer = setTimeout(poll, 5000);
  return { ok: true, url: flow.loginUrl };
}

function cancelOAuthLogin() {
  const f = PENDING_OAUTH.flow;
  if (f) {
    f.cancelled = true;
    if (f.timer) clearTimeout(f.timer);
    PENDING_OAUTH.flow = null;
  }
}

function registerFreeBuffAuthRoutes(ctx, store, options) {
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
          const result = await startOAuthLogin(options().baseURL, store, ctx.logger);
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
          const raw = typeof body?.authToken === "string" ? body.authToken : "";
          const tokens = raw
            .split(/[\n,;]+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 8);
          if (tokens.length === 0) return json(res, 400, { error: "authToken is required" });
          const email = typeof body?.email === "string" && body.email.length > 0 ? { email: body.email } : {};
          for (const token of tokens) {
            store.addAccount(token, email);
            probeAndStoreTier(store, options().baseURL, token).catch(() => {});
          }
          json(res, 200, store.status());
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: ACCOUNTS_PATH,
        handler: async (req, res) => {
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          if (req.method === "GET") {
            // Re-probe any account that is still missing a tier (e.g. a token
            // added before tier detection existed); fire-and-forget, no await.
            for (const account of store.accounts()) {
              if (account.tier === undefined) probeAndStoreTier(store, options().baseURL, account.authToken).catch(() => {});
            }
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
  }, "freebuff: web auth routes");
}

/* ------------------------------------------------------------------ *
 * OpenAI-compatible SSE translation (the upstream forces streaming)
 * ------------------------------------------------------------------ */

function flattenText(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function serializeAssistant(message) {
  const text = flattenText(message.content);
  const toolCalls = message.content
    .filter((block) => block.type === "tool-call")
    .map((block) => ({
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: block.arguments },
    }));
  return {
    role: "assistant",
    content: text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function serializeMessages(messages) {
  const wire = [];
  for (const message of messages) {
    if (message.role === "system") {
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      wire.push(serializeAssistant(message));
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === "tool-result");
    const text = flattenText(message.content);
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: "user", content: text });
    for (const result of toolResults) {
      wire.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || "(no output)",
      });
    }
  }
  return wire;
}

/**
 * Build the upstream chat-completions payload: harness messages with the
 * canonical Buffy prefix, free-mode tool signature, and codebuff metadata.
 */
function buildUpstreamPayload(options, entry, session, runId) {
  const payload = {
    model: entry.upstream,
    messages: normalizeMessages([
      ...(options.system !== undefined ? [{ role: "system", content: options.system }] : []),
      ...serializeMessages(options.messages),
    ]),
    stream: true,
    stream_options: { include_usage: true },
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop !== undefined ? { stop: options.stop } : { stop: ['"cb_easp"'] }),
    ...(options.reasoningEffort !== undefined
      ? { reasoning_effort: clampReasoningEffort(entry.id, options.reasoningEffort) }
      : {}),
    provider: { data_collection: "deny" },
  };
  const tools = options.tools?.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  if (tools !== undefined && tools.length > 0) {
    if (!tools.some((t) => t.function?.name === "end_turn")) tools.push(END_TURN_TOOL);
    payload.tools = tools;
  }
  payload.codebuff_metadata = {
    freebuff_instance_id: session.instanceId,
    trace_session_id: randomUUID(),
    run_id: runId,
    client_id: stableFingerprint(runId),
    cost_mode: "free",
  };
  return payload;
}

async function* parseSse(stream, onComment) {
  const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment }));
  for await (const { data } of events) {
    yield data;
    if (data === "[DONE]") return;
  }
  throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}

function mapFinishReason(reason) {
  switch (reason) {
    case "stop":
      return { kind: "stop" };
    case "tool_calls":
      return { kind: "tool-calls" };
    case "length":
      return { kind: "max-tokens" };
    default:
      return { kind: "error", failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } };
  }
}

function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

function closeBlock(block) {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "reasoning":
      return { type: "reasoning", text: block.text };
    case "tool-call":
      return { type: "tool-call", id: CallId(block.callId ?? ""), name: block.name ?? "", arguments: block.text };
  }
}

async function* translate(payloads) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = new Map();
  const order = [];
  let pendingFinish;
  let pendingUsage;
  function open(kind) {
    const block = { index: nextIndex++, kind, text: "" };
    order.push(block);
    return block;
  }
  for await (const payload of payloads) {
    if (payload === "[DONE]") {
      for (const block of order) yield { type: "block-end", index: block.index, block: closeBlock(block) };
      if (pendingUsage) yield { type: "usage", usage: pendingUsage };
      const reason = pendingFinish ?? { kind: "stop" };
      yield {
        type: "finish",
        reason:
          reason.kind === "stop" && order.length === 0
            ? { kind: "error", failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE } }
            : reason,
      };
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        if (!textBlock) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += content;
        yield { type: "text-delta", index: textBlock.index, text: content };
      }
      const reasoning = delta?.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += reasoning;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = open("tool-call");
          toolBlocks.set(call.index, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        if (call.id !== undefined) block.callId = call.id;
        if (call.function?.name !== undefined) block.name = call.function.name;
        const fragment = call.function?.arguments ?? "";
        block.text += fragment;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: CallId(block.callId ?? ""),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        };
      }
      if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }
  throw new LlmError("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}

/* ------------------------------------------------------------------ *
 * Upstream error mapping
 * ------------------------------------------------------------------ */

function parseRetryAfterMs(text, status) {
  if (status === 429) {
    try {
      const parsed = JSON.parse(text);
      const ms = parsed?.retryAfterMs ?? parsed?.data?.retryAfterMs;
      if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) return ms;
    } catch {
      /* not json */
    }
  }
  return undefined;
}

function isBanned(text) {
  return typeof text === "string" && (text.includes('"status":"banned"') || text.includes('"status": "banned"') || text.includes("has been banned"));
}

/** Parse the upstream error object from a non-2xx body, if any. */
function upstreamError(text) {
  try {
    const parsed = JSON.parse(text);
    const code = parsed?.error?.code ?? parsed?.code ?? parsed?.error;
    return { code: typeof code === "string" ? code : undefined, message: typeof parsed?.error?.message === "string" ? parsed.error.message : typeof parsed?.message === "string" ? parsed.message : undefined };
  } catch {
    return { code: undefined, message: undefined };
  }
}

/** Whether the upstream rejected the model for this account's "limited" tier. */
function isLimitedAccess(text) {
  return typeof text === "string" && text.includes("Limited free access");
}

/**
 * Parse a 429 session-create body's entitlement breakdown. When the account has
 * zero entitlement for a model (base/referral/streak all 0), that is a permanent
 * "model not available on this account" state — not a temporary rate limit that
 * should cool the whole account.
 */
function entitlementInfo(text) {
  try {
    const parsed = JSON.parse(text);
    const eb = parsed?.entitlementBreakdown;
    if (
      parsed &&
      typeof parsed.limit === "number" &&
      eb &&
      typeof eb.base === "number" &&
      typeof eb.referral === "number" &&
      typeof eb.streak === "number"
    ) {
      return {
        model: typeof parsed.model === "string" ? parsed.model : undefined,
        base: eb.base,
        referral: eb.referral,
        streak: eb.streak,
        limit: parsed.limit,
      };
    }
  } catch {
    /* not json */
  }
  return undefined;
}

/** 0-cost session probe: read accessTier / rateLimitsByModel without creating a session. */
async function probeSession(baseURL, authToken) {
  try {
    const resp = await fetch(`${baseURL}/api/v1/freebuff/session`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${authToken}`,
        "user-agent": SDK_UA,
        "x-freebuff-include-unused-rate-limits": "1",
      },
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
    // The body is useful on 200 (active), 404 (no session — still carries the
    // quota snapshot), and 4xx (banned / rate_limited states), so parse it
    // regardless of status and let callers decide.
    return await resp.json().catch(() => undefined);
  } catch {
    return undefined;
  }
}

/** Extract per-model session quota ({model, used, limit, resetAt}) from a probe. */
function quotaSummary(data) {
  const rl = data?.rateLimitsByModel;
  if (!rl || typeof rl !== "object") return undefined;
  const out = [];
  for (const [model, info] of Object.entries(rl)) {
    if (!info || typeof info !== "object") continue;
    const used = info.recentCount;
    const limit = info.limit;
    if (typeof used !== "number" || typeof limit !== "number") continue;
    if (limit <= 0) continue; // 0 = model not available on this account (e.g. qualification-only)
    out.push({
      model,
      used,
      limit,
      resetAt: typeof info.resetAt === "string" ? info.resetAt : typeof info.reset_at === "string" ? info.reset_at : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Whether a session snapshot indicates the account is in the "limited" tier. */
function detectLimitedTier(data) {
  if (!data || typeof data !== "object") return undefined;
  const tier = typeof data.accessTier === "string" ? data.accessTier.toLowerCase() : "";
  if (/limit/.test(tier)) return true;
  if (/complete|full|unlimited|premium|plus|pro/.test(tier)) return false;
  const rl = data.rateLimitsByModel;
  if (rl && typeof rl === "object") {
    const premiumIds = ["deepseek/deepseek-v4-pro", "openai/gpt-5.6-luna", "minimax/minimax-m3", "meta/muse-spark-1.2-contributor"];
    const hasPremium = premiumIds.some((id) => {
      const entry = rl[id];
      return entry && typeof entry.limit === "number" && entry.limit > 0;
    });
    if (hasPremium) return false;
    const hasStandard = ["deepseek/deepseek-v4-flash", "mimo/mimo-v2.5"].some((id) => {
      const entry = rl[id];
      return entry && typeof entry.limit === "number" && entry.limit > 0;
    });
    if (hasStandard) return true;
  }
  return undefined;
}

/** Probe the account tier + session quota and persist both (never throws). */
async function probeAndStoreTier(store, baseURL, authToken) {
  const data = await probeSession(baseURL, authToken);
  const limited = detectLimitedTier(data);
  const quota = quotaSummary(data);
  const meta = {};
  if (limited !== undefined) meta.tier = limited ? "limited" : "full";
  if (quota !== undefined) meta.quota = quota;
  if (Object.keys(meta).length > 0) store.addAccount(authToken, meta);
}

/**
 * A genuinely stale session (superseded / waiting-room / expired) is worth one
 * recreation retry. `session_model_mismatch` is NOT treated as stale: it means
 * the account cannot use that model, and recreating the session would burn a
 * quota slot for nothing.
 */
function isStaleSessionGate(status, text) {
  const { code } = upstreamError(text);
  if (status === 428 || code === "waiting_room_required") return true;
  if (code === "session_superseded" || code === "session_expired") return true;
  return status === 502 && typeof text === "string" && text.includes("session_model_mismatch");
}

function httpErrorCode(status, text) {
  const { code } = upstreamError(text);
  if (status === 401 || status === 403) {
    if (code === "banned" || isBanned(text)) return "AUTH";
    if (code === "country_blocked") return "AUTH";
    if (code === "model_locked" || code === "ip_capped") return QUOTA_EXCEEDED_CODE;
    return "AUTH";
  }
  if (status === 429) return QUOTA_EXCEEDED_CODE;
  if (status === 400) {
    if (isContextWindowExceededError(text)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    inputModalities: ["text"],
    ...(reasoningInfo(model.id) === undefined ? {} : { reasoning: reasoningInfo(model.id) }),
  };
}

class FreeBuffAdapter extends LlmAdapter {
  constructor(config) {
    super();
    this.config = config;
    this.sessionCache = new Map();
    this.runCache = new Map();
    this.chainTail = Promise.resolve();
    /** Token → cooldown-until timestamp (ms), for multi-account rotation. */
    this.cooldowns = new Map();
    /** Tokens the upstream reported banned; skipped for the process lifetime. */
    this.bannedTokens = new Set();
    /** Set true once the upstream reports an account is "limited" (flash/mimo only). */
    this.limited = false;
  }

  providerInfo(provider) {
    return { id: provider, name: "FreeBuff" };
  }

  providerRetryPolicy(_provider) {
    return this.config.options().retryPolicy;
  }

  listModels(provider) {
    if (this.config.isEnabled?.() === false) return Promise.resolve([]);
    let models = this.config.options().models;
    const accountLimited = this.config.isLimitedAccount?.();
    const limited = accountLimited === true || (accountLimited === undefined && this.limited);
    if (limited) models = models.filter((model) => LIMITED_MODELS.has(model.id));
    return Promise.resolve(models.map((model) => modelInfo(provider, model)));
  }

  resolveModel(provider, model, _signal) {
    if (this.config.isEnabled?.() === false) throw new LlmError("freebuff: disabled in Seraphim settings — enable it in Settings → Seraphim", "DISABLED");
    const connection = this.config.options();
    const configured = connection.models.find((entry) => entry.id === model);
    return Promise.resolve({
      ...(configured === undefined
        ? { provider, id: model, name: model, inputModalities: ["text"], ...(reasoningInfo(model) === undefined ? {} : { reasoning: reasoningInfo(model) }) }
        : modelInfo(provider, configured)),
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
    });
  }

  /** Serialize upstream control-plane calls: the free channel breaks under concurrency. */
  queue(fn) {
    const run = this.chainTail.then(() => new Promise((resolve) => setTimeout(resolve, CHAIN_GAP_MS))).then(fn);
    this.chainTail = run.catch(() => {});
    return run;
  }

  async up(method, path, authToken, body, extraHeaders = {}, timeoutMs = SESSION_TIMEOUT_MS, signal) {
    const headers = {
      accept: "application/json",
      "user-agent": SDK_UA,
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    };
    const resp = await fetch(`${this.config.options().baseURL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
    });
    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: resp.status, data, text };
  }

  async ensureSession(authToken, sessionModel, signal) {
    const key = `${authToken}:${sessionModel}`;
    const cached = this.sessionCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 60000) return cached;
    if (cached) this.sessionCache.delete(key);
    const cur = await this.queue(() =>
      this.up("GET", "/api/v1/freebuff/session", authToken, undefined, { "x-freebuff-include-unused-rate-limits": "1" }, SESSION_TIMEOUT_MS, signal),
    );
    if (cur.status === 200 && cur.data?.status === "active" && cur.data?.instanceId) {
      if (!cur.data.model || cur.data.model === sessionModel) {
        const s = { instanceId: cur.data.instanceId, model: sessionModel, expiresAt: Date.now() + SESSION_TTL_MS };
        this.sessionCache.set(key, s);
        return s;
      }
      await this
        .queue(() => this.up("DELETE", "/api/v1/freebuff/session", authToken, undefined, { "x-freebuff-instance-id": cur.data.instanceId }, SESSION_TIMEOUT_MS, signal))
        .catch(() => {});
    }
    return this.createSession(authToken, sessionModel, signal);
  }

  async createSession(authToken, sessionModel, signal) {
    const key = `${authToken}:${sessionModel}`;
    const instId = randomUUID();
    const r = await this.queue(() =>
      this.up(
        "POST",
        "/api/v1/freebuff/session",
        authToken,
        undefined,
        { "x-freebuff-model": sessionModel, "x-freebuff-instance-id": instId },
        SESSION_TIMEOUT_MS,
        signal,
      ),
    );
    if (r.status === 200 && r.data?.status === "active" && r.data?.instanceId) {
      const s = { instanceId: r.data.instanceId, model: sessionModel, expiresAt: Date.now() + SESSION_TTL_MS };
      this.sessionCache.set(key, s);
      return s;
    }
    if (r.status === 200 && r.data?.status === "queued" && r.data?.instanceId) {
      const inst = r.data.instanceId;
      for (let i = 0; i < SESSION_POLL_ATTEMPTS; i++) {
        await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_MS));
        const q = await this.queue(() =>
          this.up("GET", "/api/v1/freebuff/session", authToken, undefined, { "x-freebuff-instance-id": inst }, SESSION_TIMEOUT_MS, signal),
        );
        if (q.status === 200 && q.data?.status === "active") {
          const s = { instanceId: q.data.instanceId || inst, model: sessionModel, expiresAt: Date.now() + SESSION_TTL_MS };
          this.sessionCache.set(key, s);
          return s;
        }
      }
      throw new LlmError("freebuff: session stayed queued (retry later)", "RATE_LIMIT");
    }
    if (r.status === 409) throw new LlmError(`freebuff: session_model_mismatch: ${r.text || ""}`.slice(0, 300), "INVALID_REQUEST");
    if (r.status === 429) {
      const ent = entitlementInfo(r.text);
      if (ent && ent.base === 0 && ent.referral === 0 && ent.streak === 0) {
        throw new LlmError(
          `freebuff: "${ent.model ?? sessionModel}" is not available on this account (0 sessions — it requires referral/streak qualification). Use \`deepseek/deepseek-v4-flash\` or \`mimo/mimo-v2.5\`. (resets ${ent.limit === 0 ? "never without qualification" : "pacific_day"})`,
          "INVALID_REQUEST",
          { status: 429, accountRetryable: true, noCooldown: true },
        );
      }
    }
    const mapped = httpErrorCode(r.status, r.text);
    throw new LlmError(`freebuff: create session failed: ${r.status} ${(r.text || "").slice(0, 200)}`, mapped);
  }

  async invalidateSession(authToken, sessionModel, instanceId, signal) {
    this.sessionCache.delete(`${authToken}:${sessionModel}`);
    if (!instanceId) return;
    await this.queue(() =>
      this.up("DELETE", "/api/v1/freebuff/session", authToken, undefined, { "x-freebuff-instance-id": instanceId }, SESSION_TIMEOUT_MS, signal),
    ).catch(() => {});
  }

  async ensureRunChain(authToken, agentId, signal) {
    const key = `${authToken}:${agentId}`;
    const hit = this.runCache.get(key);
    if (hit && Date.now() - hit.ts < RUN_CACHE_TTL_MS) return hit.runId;
    const runId = await this.queue(async () => {
      const r = await this.up("POST", "/api/v1/agent-runs", authToken, { action: "START", agentId, ancestorRunIds: [] }, undefined, SESSION_TIMEOUT_MS, signal);
      if (r.status !== 200 || !r.data?.runId) throw new LlmError(`freebuff: start_run failed: ${r.status} ${(r.text || "").slice(0, 200)}`, "SERVER");
      await this.up(
        "POST",
        "/api/v1/agent-runs",
        authToken,
        { action: "START", agentId: CONTEXT_PRUNER_AGENT, ancestorRunIds: [r.data.runId] },
        undefined,
        SESSION_TIMEOUT_MS,
        signal,
      );
      return r.data.runId;
    });
    this.runCache.set(key, { runId, ts: Date.now() });
    return runId;
  }

  cooldownUntil(token) {
    return this.cooldowns.get(token) ?? 0;
  }

  cooldown(token, ms) {
    if (ms > 0) this.cooldowns.set(token, Date.now() + ms);
  }

  /** Whether a failure should move on to the next account instead of surfacing. */
  retryableAccountError(error) {
    if (!(error instanceof LlmError)) return true;
    if (error.options?.accountRetryable === true) return true;
    return !["UNKNOWN_MODEL", "INVALID_REQUEST", CONTEXT_WINDOW_EXCEEDED_CODE].includes(error.code);
  }

  /** Cooldown duration for an account after a retryable failure. */
  accountCooldownMs(error) {
    if (error instanceof LlmError && error.options?.noCooldown === true) return 0;
    if (error instanceof LlmError && typeof error.options?.providerRetryAfterMs === "number" && error.options.providerRetryAfterMs > 0) {
      return Math.min(error.options.providerRetryAfterMs, 15 * 60 * 1000);
    }
    const code = error?.code;
    if (code === "AUTH") return 10 * 60 * 1000;
    if (code === QUOTA_EXCEEDED_CODE || code === "RATE_LIMIT") return 5 * 60 * 1000;
    return 60 * 1000;
  }

  /** One account's chat request, including the stale-session recreation retry. */
  async chatRequest(authToken, entry, session, payload, connection, options, signal) {
    const headers = {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-freebuff-instance-id": session.instanceId,
      ...attributionHeaders(),
      ...(options.sessionId !== undefined ? { "x-harness-session-id": String(options.sessionId) } : {}),
    };
    let currentSession = session;
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await fetch(`${connection.baseURL}/api/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new LlmError(`freebuff: API request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
      }
      if (response.ok) return response;
      const errText = await response.text();
      if (isLimitedAccess(errText)) {
        this.limited = true;
        throw new LlmError(
          "freebuff: this account has limited free access — only `deepseek/deepseek-v4-flash` and `mimo/mimo-v2.5` are available; select one of those",
          "INVALID_REQUEST",
          { status: response.status, accountRetryable: true },
        );
      }
      if (isStaleSessionGate(response.status, errText) && attempt === 0) {
        await this.invalidateSession(authToken, entry.session, currentSession.instanceId, signal);
        currentSession = await this.createSession(authToken, entry.session, signal);
        headers["x-freebuff-instance-id"] = currentSession.instanceId;
        payload.codebuff_metadata.freebuff_instance_id = currentSession.instanceId;
        continue;
      }
      if (isBanned(errText)) {
        throw new LlmError("freebuff: account banned (terminal, upstream policy)", "AUTH", { status: response.status });
      }
      const retryAfterMs = parseRetryAfterMs(errText, response.status);
      throw new LlmError(
        `freebuff: API error (HTTP ${response.status})${errText ? `: ${errText.slice(0, 200)}` : ""}`,
        httpErrorCode(response.status, errText),
        { status: response.status, ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }) },
      );
    }
    throw new LlmError("freebuff: chat request failed after session retry", "SERVER");
  }

  async *stream(options) {
    if (this.config.isEnabled?.() === false) throw new LlmError("freebuff: disabled in Seraphim settings — enable it in Settings → Seraphim", "DISABLED");
    const connection = this.config.options();
    const entry = connection.models.find((m) => m.id === options.model);
    if (!entry) throw new LlmError(`freebuff: unknown model "${options.model}"`, "UNKNOWN_MODEL");
    const accountLimited = this.config.isLimitedAccount?.();
    if ((accountLimited === true || this.limited) && !LIMITED_MODELS.has(options.model)) {
      throw new LlmError(
        "freebuff: this account has limited free access — only `deepseek/deepseek-v4-flash` and `mimo/mimo-v2.5` are available",
        "INVALID_REQUEST",
      );
    }
    const tokens = await this.config.resolveAuthTokens();
    const consumer = new AbortController();
    const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
    let timedOut = false;
    let idleTimer;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        consumer.abort();
      }, connection.streamIdleTimeoutMs);
    };
    armIdle();
    let lastError;
    try {
      for (const authToken of tokens) {
        if (this.bannedTokens.has(authToken)) continue;
        if (this.cooldownUntil(authToken) > Date.now()) {
          lastError = new LlmError(
            "freebuff: an account is cooling down (rate-limited); wait for the cooldown / pacific-day reset, or add another account",
            "RATE_LIMIT",
          );
          continue;
        }
        let response;
        try {
          const session = await this.ensureSession(authToken, entry.session, signal);
          const runId = await this.ensureRunChain(authToken, entry.agent, signal);
          const payload = buildUpstreamPayload(options, entry, session, runId);
          response = await this.chatRequest(authToken, entry, session, payload, connection, options, signal);
        } catch (error) {
          if (timedOut) throw error;
          if (options.signal?.aborted) throw error;
          lastError = error;
          if (error instanceof LlmError && /banned/.test(error.message)) {
            this.bannedTokens.add(authToken);
            this.cooldown(authToken, 60 * 60 * 1000);
            continue;
          }
          if (this.retryableAccountError(error)) {
            this.cooldown(authToken, this.accountCooldownMs(error));
            continue;
          }
          throw error;
        }
        const iterator = translate(parseSse(response.body, armIdle))[Symbol.asyncIterator]();
        while (true) {
          const result = await iterator.next();
          if (result.done) return;
          armIdle();
          yield result.value;
        }
      }
      throw lastError ?? new LlmError("freebuff: all accounts failed", "SERVER");
    } catch (error) {
      if (timedOut) throw new LlmError(`freebuff: stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
      if (options.signal?.aborted) throw new LlmError("freebuff: request aborted by caller", "ABORTED", { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(`freebuff: API stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
    } finally {
      clearTimeout(idleTimer);
      consumer.abort();
    }
  }
}

/* ------------------------------------------------------------------ *
 * Config resolution + plugin apply
 * ------------------------------------------------------------------ */

function resolveModels(models) {
  const seen = new Set();
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (!model.id || !model.session || !model.agent || !model.upstream) {
      throw new Error(`freebuff: catalog model "${model.id}" needs id/session/agent/upstream`);
    }
    if (seen.has(model.id)) throw new Error(`freebuff: duplicate catalog model "${model.id}"`);
    seen.add(model.id);
    return {
      id: model.id,
      name: model.name ?? model.id,
      session: model.session,
      agent: model.agent,
      upstream: model.upstream,
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
  });
}

function resolveAdapterOptions(config) {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error("freebuff: streamIdleTimeoutMs must be a positive finite number");
  }
  return {
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, "freebuff: retryPolicy"),
  };
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
      ctx.logger?.error?.("freebuff: keeping the last good configuration after an invalid settings section");
      ctx.logger?.error?.(error);
      return lastGood;
    }
  };
  options();

  const store = new FreeBuffCredentialStore();

  // Proactively probe every stored account's tier at boot (fire-and-forget) so
  // the model picker is correct on first open, without a failed chat to learn it.
  for (const account of store.accounts()) {
    probeAndStoreTier(store, options().baseURL, account.authToken).catch(() => {});
  }

  const resolveAuthTokens = async () => {
    const cfg = current();
    const tokens = [];
    if (typeof cfg.authToken === "string" && cfg.authToken.trim().length > 0) tokens.push(cfg.authToken.trim());
    tokens.push(...store.accessTokens());
    const unique = [...new Set(tokens)];
    if (unique.length === 0) {
      throw new LlmError(
        "freebuff: not signed in; open Settings → Plugins → FreeBuff and sign in (or paste an authToken)",
        "AUTH",
      );
    }
    return unique;
  };

  const flags = new ProviderFlagsStore();
  const adapter = new FreeBuffAdapter({
    options,
    resolveAuthTokens,
    isEnabled: () => flags.enabled(PROVIDER),
    isLimitedAccount: () => {
      const accounts = store.accounts();
      const tiers = accounts.map((a) => a.tier).filter(Boolean);
      if (tiers.some((t) => t === "full")) return false;
      if (tiers.length > 0 && tiers.every((t) => t === "limited")) return true;
      return undefined;
    },
  });
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: "FreeBuff", settingsNs: NS, settingsPath: [] }]);

  ctx.inject(["webServer"], (webCtx) => registerFreeBuffAuthRoutes(webCtx, store, options));

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {},
  });
}

export {
  BUFFY,
  Config,
  FreeBuffAdapter,
  FreeBuffCredentialStore,
  apply,
  buildUpstreamPayload,
  clampReasoningEffort,
  detectLimitedTier,
  genFingerprint,
  inject,
  name,
  normalizeMessages,
  probeSession,
  quotaSummary,
  reasoningInfo,
  stableFingerprint,
};
