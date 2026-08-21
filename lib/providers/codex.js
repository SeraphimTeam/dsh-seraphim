import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
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
  resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { ProviderFlagsStore } from "./provider-flags.js";

/**
 * Codex — a native DeepSeek Harness provider for OpenAI's Codex subscription
 * (ChatGPT Plus/Pro/Team/Enterprise) via the chatgpt.com backend.
 *
 * The wire protocol implemented here was verified live against chatgpt.com on
 * 2026-08-16 with a real ChatGPT Plus account, and cross-checked against the
 * open-source references:
 *   - @earendil-works/pi-ai provider `openai-codex` (the engine behind the
 *     dsh-codex-connect plugin, https://github.com/franksong2702/dsh-codex-connect)
 *   - The official openai/codex CLI (Rust) which uses the same endpoints.
 *
 * Upstream lifecycle:
 *
 *   PKCE browser OAuth → ChatGPT access/refresh token → SSE responses stream
 *
 * 1. Sign-in: the plugin generates a PKCE verifier/challenge and a localhost
 *    callback server on 127.0.0.1:1455, then opens
 *    `https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http://localhost:1455/auth/callback&scope=openid profile email offline_access api.connectors.read api.connectors.invoke&code_challenge=…&code_challenge_method=S256&state=…&codex_cli_simplified_flow=true&originator=codex_cli_rs`.
 *    After the browser authorizes, the callback receives `?code=…&state=…`;
 *    the plugin exchanges it at `https://auth.openai.com/oauth/token`
 *    (`grant_type=authorization_code`) for {access_token, refresh_token,
 *    expires_in (10 days)}. The account id is read from the JWT claim
 *    `https://api.openai.com/auth → chatgpt_account_id`.
 * 2. Refresh: `POST https://auth.openai.com/oauth/token` with
 *    `grant_type=refresh_token&refresh_token=…&client_id=app_EMoamEEZ73f0CkXaXp7hrann`.
 *    Access tokens live 10 days; the adapter refreshes automatically when the
 *    stored token is within 60s of expiry.
 * 3. Completions: `POST https://chatgpt.com/backend-api/codex/responses`
 *    with headers `Authorization: Bearer <access_token>`,
 *    `chatgpt-account-id: <accountId>`, `openai-beta: responses=experimental`,
 *    `accept: text/event-stream`, `originator: codex_cli_rs`, and a body mirroring the
 *    OpenAI Responses API (`model`, `store: false`, `stream: true`,
 *    `instructions`, `input`, `text: {verbosity}`, `include: [reasoning…]`,
 *    `tools`, `tool_choice`, `reasoning: {effort, summary}`). The upstream
 *    forces streaming; events are `response.output_text.delta`,
 *    `response.output_item.added/done`, `response.completed`, etc.
 * 4. Usage: `GET https://chatgpt.com/backend-api/wham/usage` exposes the
 *    account's weekly Codex quota (used_percent / window), credits and spend
 *    control — shown on the card. 401/403 there means the OAuth session must
 *    be renewed.
 * 5. Models: `GET https://chatgpt.com/backend-api/codex/models?client_version=…`
 *    returns the account's real catalog (slug, display_name, context_window,
 *    supported_reasoning_levels, service_tiers). The configured table is the
 *    fallback until the first authenticated fetch.
 */

/** Cordis plugin name used by loader diagnostics. */
const name = "llm-codex";
/** Hard dependency: the LLM provider registry. */
const inject = ["llm"];

/** The provider route this plugin owns (appears in the model picker). */
const PROVIDER = "codex";
/** Settings namespace bound to this provider's config. */
const NS = settingsNamespace("llm-codex");

/** Plugin-owned HTTP routes used by the browser card. */
const STATUS_PATH = "/plugins/codex/auth/status";
const LOGIN_PATH = "/plugins/codex/auth/login";
const CANCEL_PATH = "/plugins/codex/auth/cancel";
const LOGOUT_PATH = "/plugins/codex/auth/logout";
const ACCOUNTS_PATH = "/plugins/codex/auth/accounts";
const USAGE_PATH = "/plugins/codex/auth/usage";

/** Credential file inside the harness home (access/refresh token per account). */
const CREDENTIAL_FILE = ".codex-credentials.json";

/** Upstream endpoints (overridable for self-hosted relays / testing). */
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_AUTH_BASE_URL = "https://auth.openai.com";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/**
 * OAuth redirect URI — MUST stay `localhost` (not 127.0.0.1). The auth.openai.com
 * Hydra allow-list only registers `http://localhost:1455/auth/callback`
 * (codex-rs keeps its redirect in sync with that allow-list; 127.0.0.1 is
 * rejected with `invalid_authorize_request`). The callback listener binds
 * 127.0.0.1:1455; `localhost` resolves there, so the browser navigation lands.
 */
const DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback";
const DEFAULT_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
// Hard-patched to expose 1M context for Codex models.
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
const MAX_TIMER_DELAY_MS = 2147483647;
const LOGIN_DEADLINE_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 15000;
const USAGE_TIMEOUT_MS = 15000;
const PROBE_TIMEOUT_MS = 15000;
const CHAIN_GAP_MS = 300;
const LIVE_MODELS_TTL_MS = 10 * 60 * 1000;
const LIVE_MODELS_TIMEOUT_MS = 15000;

/** OAuth client id used by the official Codex CLI (verified live). */
const CLIENT_ID = DEFAULT_CLIENT_ID;

/** JWT claim path carrying the ChatGPT account identity. */
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** Reasoning effort ladder (the Codex catalog's `supported_reasoning_levels`). */
const EFFORT_IDS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

/**
 * Fallback model catalog (used only until the first authenticated fetch of
 * `/backend-api/codex/models`). Snapshot of the live list for a ChatGPT Plus
 * account, client 0.147.0 (2026-08-16); `id` is the harness model id,
 * `upstream` the wire slug.
 */
const MODEL_TABLE = [
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", upstream: "gpt-5.6-sol", contextWindow: 1_000_000, effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", upstream: "gpt-5.6-terra", contextWindow: 1_000_000, effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", upstream: "gpt-5.6-luna", contextWindow: 1_000_000, effortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.5", name: "GPT-5.5", upstream: "gpt-5.5", contextWindow: 1_000_000, effortLevels: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4", name: "GPT-5.4", upstream: "gpt-5.4", contextWindow: 1_000_000, effortLevels: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", upstream: "gpt-5.4-mini", contextWindow: 1_000_000, effortLevels: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", upstream: "gpt-5.3-codex-spark", contextWindow: 1_000_000, effortLevels: ["low", "medium", "high"] },
];

const DEFAULT_MODELS = MODEL_TABLE.map((entry) => ({
  id: entry.id,
  name: entry.name,
  upstream: entry.upstream,
  contextWindow: entry.contextWindow,
  ...(entry.effortLevels ? { effortLevels: entry.effortLevels } : {}),
}));

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  upstream: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  effortLevels: z.array(z.string()),
});

/** Runtime schema for the row's `config:` block. */
const Config = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  authBaseURL: z.string().default(DEFAULT_AUTH_BASE_URL),
  oauthClientId: z.string().default(DEFAULT_CLIENT_ID),
  oauthRedirectUri: z.string().default(DEFAULT_REDIRECT_URI),
  oauthScope: z.string().default(DEFAULT_SCOPE),
  clientVersion: z.string().default("0.147.0"),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
});

/* ------------------------------------------------------------------ *
 * Pure helpers (exported for tests)
 * ------------------------------------------------------------------ */

/** base64url encode without padding (PKCE challenge, JWT segments). */
function base64UrlEncode(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url decode with padding restored. */
function base64UrlDecode(text) {
  const pad = (4 - (text.length % 4)) % 4;
  return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad), "base64");
}

/** Decode a JWT payload segment into a plain object; undefined when unparsable. */
function parseJwtClaims(jwt) {
  try {
    const payload = String(jwt ?? "").split(".")[1];
    if (!payload) return undefined;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Read the ChatGPT auth claim from an access-token JWT. */
function authClaim(jwt) {
  return parseJwtClaims(jwt)?.[JWT_CLAIM_PATH];
}

/** Extract the ChatGPT account id from an access token; undefined when absent. */
function accountIdFromToken(accessToken) {
  const auth = authClaim(accessToken);
  const id = auth?.chatgpt_account_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Extract the ChatGPT plan slug from an access token (plus/pro/team/…). */
function planFromToken(accessToken) {
  const auth = authClaim(accessToken);
  const plan = auth?.chatgpt_plan_type;
  return typeof plan === "string" && plan.length > 0 ? plan : undefined;
}

/** JWT expiry (ms) from the payload `exp` claim; undefined when absent. */
function jwtExpiryMs(jwt) {
  const claims = parseJwtClaims(jwt);
  const exp = claims?.exp;
  return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
}

/** Whether a token is missing/empty or expires within the skew window. */
function tokenNeedsRefresh(account) {
  if (typeof account?.accessToken !== "string" || account.accessToken.length === 0) return true;
  const exp = account.expiresAtMs;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return true;
  return exp <= Date.now() + TOKEN_REFRESH_SKEW_MS;
}

/** Build the PKCE pair (verifier + S256 challenge). */
function createPkcePair() {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Build the auth.openai.com authorize URL for the browser. */
function buildAuthorizeUrl(options, state, challenge) {
  const url = new URL(`${options().authBaseURL}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options().oauthClientId);
  url.searchParams.set("redirect_uri", options().oauthRedirectUri);
  url.searchParams.set("scope", options().oauthScope);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");
  return url.toString();
}

/** Exchange an authorization code for tokens (verified live). */
async function exchangeCode(options, code, verifier, signal) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: options().oauthClientId,
    code,
    code_verifier: verifier,
    redirect_uri: options().oauthRedirectUri,
  });
  const response = await fetch(`${options().authBaseURL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)].filter(Boolean)),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new LlmError(`codex: token exchange failed (HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""})`, httpErrorCode(response.status, text), { status: response.status });
  }
  const data = await response.json().catch(() => undefined);
  if (typeof data?.access_token !== "string" || typeof data?.refresh_token !== "string" || typeof data?.expires_in !== "number") {
    throw new LlmError("codex: token exchange response missing access_token/refresh_token/expires_in", "INVALID_REQUEST");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAtMs: Date.now() + data.expires_in * 1000,
  };
}

/** Refresh an access token (verified live: 200, expires_in 864000). */
async function refreshAccessToken(options, refreshToken, signal) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: options().oauthClientId,
  });
  const response = await fetch(`${options().authBaseURL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)].filter(Boolean)),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 400 || response.status === 401) {
      throw new LlmError("codex: refresh token is invalid or revoked — sign in again", "AUTH", { status: response.status, accountRetryable: true });
    }
    throw new LlmError(`codex: token refresh failed (HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""})`, httpErrorCode(response.status, text), { status: response.status });
  }
  const data = await response.json().catch(() => undefined);
  if (typeof data?.access_token !== "string" || typeof data?.refresh_token !== "string" || typeof data?.expires_in !== "number") {
    throw new LlmError("codex: token refresh response missing fields", "INVALID_REQUEST");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAtMs: Date.now() + data.expires_in * 1000,
  };
}

/** Map an HTTP status + upstream body to a dsh-llm error code. */
function httpErrorCode(status, text) {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 402) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return QUOTA_EXCEEDED_CODE;
  if (status === 400) {
    if (isContextWindowExceededError(text)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

/**
 * Map an OpenAI `response.failed` error code (codex-rs source: rate_limit_exceeded,
 * context_length_exceeded, insufficient_quota, cyber_policy, misalignment_policy_violation…)
 * to a dsh-llm error code.
 */
function failedEventCode(errorCode) {
  const code = String(errorCode ?? "").toLowerCase();
  if (code.includes("insufficient_quota") || code.includes("quota") || code.includes("billing")) return QUOTA_EXCEEDED_CODE;
  if (code.includes("context_length") || code.includes("context_window") || code.includes("token_limit")) return CONTEXT_WINDOW_EXCEEDED_CODE;
  if (code.includes("rate_limit") || code.includes("throttl")) return "RATE_LIMIT";
  if (code.includes("unauthorized") || code.includes("invalid_token") || code.includes("authentication")) return "AUTH";
  if (code.includes("invalid") || code.includes("bad_request") || code.includes("unsupported")) return "INVALID_REQUEST";
  return "SERVER";
}

/** Parse a retry-after hint from a 429 body (retryAfterMs / retry-after). */
function parseRetryAfterMs(text, status, headers) {
  if (status === 429) {
    try {
      const parsed = JSON.parse(text);
      const ms = parsed?.retryAfterMs ?? parsed?.data?.retryAfterMs;
      if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) return ms;
    } catch {
      /* not json */
    }
  }
  const headerMs = headers?.get?.("retry-after-ms");
  if (headerMs !== null && headerMs !== undefined && Number.isFinite(Number(headerMs)) && Number(headerMs) > 0) {
    return Number(headerMs);
  }
  const retryAfter = headers?.get?.("retry-after");
  if (retryAfter !== null && retryAfter !== undefined && Number.isFinite(Number(retryAfter))) {
    return Number(retryAfter) * 1000;
  }
  return undefined;
}

/** Whether a 429 body means a hard usage limit (not worth retrying other accounts). */
function isUsageLimitError(text) {
  return /GoUsageLimitError|FreeUsageLimitError|usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(String(text ?? ""));
}

/* ------------------------------------------------------------------ *
 * Credential store (multi-account)
 * ------------------------------------------------------------------ */

function credentialFile() {
  return join(resolveDshHome(), CREDENTIAL_FILE);
}

/** Persist Codex OAuth accounts under the harness home. */
class CodexCredentialStore {
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
    if (Array.isArray(doc?.accounts)) {
      for (const account of doc.accounts) {
        if (typeof account?.accessToken === "string" && account.accessToken.length > 0 && typeof account?.refreshToken === "string" && account.refreshToken.length > 0) {
          list.push(account);
        }
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
      plan: accounts[0]?.plan,
      plans: accounts.map((account) => account.plan).filter(Boolean),
    };
  }

  /** Append an account (dedup by accountId), returning the account. */
  addAccount(tokens, meta = {}) {
    const accounts = this.accounts();
    const account = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accountId: tokens.accountId,
      expiresAtMs: tokens.expiresAtMs,
      ...meta,
      storedAt: Date.now(),
    };
    const index = accounts.findIndex((a) => a.accountId === account.accountId);
    if (index >= 0) accounts[index] = { ...accounts[index], ...account };
    else accounts.push(account);
    this.write({ accounts });
    return account;
  }

  /** Secret-free account metadata for the card (no tokens). */
  listMeta() {
    return this.accounts().map((account, index) => ({
      index,
      accountId: account.accountId,
      email: typeof account.email === "string" && account.email.length > 0 ? account.email : undefined,
      plan: typeof account.plan === "string" && account.plan.length > 0 ? account.plan : undefined,
      expiresAt: typeof account.expiresAtMs === "number" ? account.expiresAtMs : undefined,
      storedAt: typeof account.storedAt === "number" ? account.storedAt : undefined,
    }));
  }

  removeAccount(selector) {
    const accounts = this.accounts();
    const next = accounts.filter((account, index) => {
      if (typeof selector === "number") return index !== selector;
      return account.accountId !== selector;
    });
    if (next.length === accounts.length) return accounts.length;
    this.write({ accounts: next });
    return next.length;
  }

  /** Persist refreshed tokens + derived metadata for one account. */
  updateTokens(accountId, tokens, meta = {}) {
    const accounts = this.accounts();
    const index = accounts.findIndex((a) => a.accountId === accountId);
    if (index < 0) return;
    accounts[index] = { ...accounts[index], ...tokens, ...meta };
    this.write({ accounts });
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
 * Browser sign-in: PKCE + localhost callback server (port 1455)
 * ------------------------------------------------------------------ */

const PENDING_LOGIN = { flow: null };

/**
 * Start the browser OAuth flow. The callback server listens on 127.0.0.1:1455
 * (the fixed port the official Codex client uses, so an existing ~/.codex
 * login completes into this store too when the browser is pointed at it).
 */
async function startCodexLogin(options, store, logger) {
  if (PENDING_LOGIN.flow) return { ok: true, url: PENDING_LOGIN.flow.url };

  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(16).toString("hex");
  const flow = {
    verifier,
    state,
    url: buildAuthorizeUrl(options, state, challenge),
    deadline: Date.now() + LOGIN_DEADLINE_MS,
    cancelled: false,
    server: null,
    timer: null,
  };

  try {
    const server = createServer((req, res) => {
      handleCallback(req, res, flow, options, store, logger);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(1455, "127.0.0.1", () => resolve());
    });
    flow.server = server;
    PENDING_LOGIN.flow = flow;
    flow.timer = setTimeout(() => {
      const f = PENDING_LOGIN.flow;
      if (f === flow && !f.cancelled) {
        logger?.warn?.("codex: sign-in window expired");
        cancelCodexLogin();
      }
    }, LOGIN_DEADLINE_MS);
    flow.timer.unref?.();
    return { ok: true, url: flow.url };
  } catch (error) {
    if (flow.server) flow.server.close();
    const message = error instanceof Error ? error.message : "sign-in failed";
    logger?.error?.(`codex: sign-in setup failed: ${message}`);
    return { ok: false, message: `Codex sign-in could not start (${message})` };
  }
}

/** Handle one callback connection: validate state, exchange the code, store. */
function handleCallback(req, res, flow, options, store, logger) {
  try {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    if (url.pathname !== "/auth/callback") {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<h3>Callback route not found.</h3>");
      return;
    }
    if (url.searchParams.get("state") !== flow.state) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end("<h3>State mismatch.</h3>");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end("<h3>Missing authorization code.</h3>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<h3>OpenAI authentication completed. You can close this window.</h3>");
    // Exchange + store fire-and-forget; the card polls STATUS_PATH.
    (async () => {
      try {
        const tokens = await exchangeCode(options, code, flow.verifier);
        const accountId = accountIdFromToken(tokens.accessToken);
        if (!accountId) throw new LlmError("codex: could not extract account id from access token", "INVALID_REQUEST");
        const plan = planFromToken(tokens.accessToken);
        const email = authClaim(tokens.accessToken)?.email ?? authClaim(tokens.accessToken)?.name;
        store.addAccount({ ...tokens, accountId }, { plan, email });
        logger?.debug?.(`codex: account ${accountId} signed in`);
      } catch (error) {
        logger?.error?.(`codex: OAuth exchange failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    cancelCodexLogin();
  } catch (error) {
    try {
      res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      res.end("<h3>Internal error while processing the OAuth callback.</h3>");
    } catch {
      /* ignore */
    }
    logger?.error?.(`codex: callback error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cancelCodexLogin() {
  const f = PENDING_LOGIN.flow;
  if (f) {
    f.cancelled = true;
    if (f.timer) clearTimeout(f.timer);
    if (f.server) {
      try {
        f.server.close();
      } catch {
        /* ignore */
      }
    }
    PENDING_LOGIN.flow = null;
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

/** Fetch the account's usage snapshot (never throws; returns undefined on failure). */
async function fetchUsage(account, baseURL) {
  const headers = {
    authorization: `Bearer ${account.accessToken}`,
    "chatgpt-account-id": account.accountId,
    accept: "application/json",
    "cache-control": "no-store",
    "user-agent": "dsh-seraphim",
  };
  const response = await fetch(`${baseURL}/wham/usage`, {
    method: "GET",
    redirect: "error",
    headers,
    signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new LlmError("codex: authorization must be renewed", "AUTH", { status: response.status });
    }
    throw new LlmError(`codex: usage request failed (HTTP ${response.status})`, httpErrorCode(response.status, await response.text().catch(() => "")));
  }
  const value = await response.json().catch(() => undefined);
  return parseUsage(value);
}

/** Project the /wham/usage payload into a small secret-free object for the card. */
function parseUsage(value) {
  if (!value || typeof value !== "object") return { rateLimits: [], credits: undefined, spendControl: undefined };
  const limits = [];
  const primary = value.rate_limit;
  if (primary && typeof primary === "object") {
    const windows = [];
    for (const key of ["primary_window", "secondary_window"]) {
      const window = primary[key];
      if (window && typeof window === "object" && typeof window.used_percent === "number" && typeof window.limit_window_seconds === "number") {
        windows.push({ remainingPercent: Math.max(0, Math.min(100, 100 - window.used_percent)), windowSeconds: window.limit_window_seconds });
      }
    }
    if (windows.length > 0) limits.push({ id: "codex", name: "Codex", windows });
  }
  if (Array.isArray(value.additional_rate_limits)) {
    for (const item of value.additional_rate_limits) {
      if (!item || typeof item !== "object") continue;
      const id = typeof item.metered_feature === "string" ? item.metered_feature : undefined;
      const name = typeof item.limit_name === "string" ? item.limit_name : undefined;
      const rl = item.rate_limit;
      if (!id || !rl || typeof rl !== "object") continue;
      const windows = [];
      for (const key of ["primary_window", "secondary_window"]) {
        const window = rl[key];
        if (window && typeof window === "object" && typeof window.used_percent === "number" && typeof window.limit_window_seconds === "number") {
          windows.push({ remainingPercent: Math.max(0, Math.min(100, 100 - window.used_percent)), windowSeconds: window.limit_window_seconds });
        }
      }
      if (windows.length > 0) limits.push({ id, ...(name ? { name } : {}), windows });
    }
  }
  let credits;
  const c = value.credits;
  if (c && typeof c === "object" && typeof c.has_credits === "boolean") {
    credits = { unlimited: c.unlimited === true, ...(typeof c.balance === "string" ? { balance: c.balance } : {}) };
  }
  let spendControl;
  const s = value.spend_control;
  if (s && typeof s === "object") {
    const individual = s.individual_limit;
    if (individual && typeof individual === "object" && typeof individual.remaining_percent === "number" && typeof individual.limit === "string") {
      spendControl = {
        limit: individual.limit,
        used: typeof individual.used === "string" ? individual.used : undefined,
        remaining: typeof individual.remaining === "string" ? individual.remaining : undefined,
        remainingPercent: individual.remaining_percent,
      };
    }
  }
  return { rateLimits: limits, ...(credits === undefined ? {} : { credits }), ...(spendControl === undefined ? {} : { spendControl }) };
}

function registerCodexAuthRoutes(ctx, store, options, logger) {
  ctx.effect(() => {
    const routes = [
      ctx.webServer.register({
        kind: "exact",
        path: STATUS_PATH,
        handler: async (req, res) => {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          json(res, 200, { ...store.status(), pending: PENDING_LOGIN.flow !== null });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: LOGIN_PATH,
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          const result = await startCodexLogin(options, store, logger);
          if (!result.ok) return json(res, 502, { error: result.message });
          json(res, 200, { url: result.url });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: CANCEL_PATH,
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          cancelCodexLogin();
          json(res, 200, { ok: true });
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
            const selector = typeof body?.index === "number" ? body.index : typeof body?.accountId === "string" ? body.accountId : undefined;
            if (selector === undefined) return json(res, 400, { error: "index or accountId is required" });
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
        path: USAGE_PATH,
        handler: async (req, res) => {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          const accounts = store.accounts();
          if (accounts.length === 0) return json(res, 200, { usage: undefined });
          let lastError;
          for (const account of accounts) {
            try {
              const usage = await fetchUsage(account, options().baseURL);
              return json(res, 200, { usage });
            } catch (error) {
              lastError = error;
            }
          }
          const message = lastError instanceof Error ? lastError.message : "usage unavailable";
          json(res, 200, { usage: undefined, error: message });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: LOGOUT_PATH,
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          cancelCodexLogin();
          store.clear();
          json(res, 200, { ok: true });
        },
      }),
    ];
    return async () => {
      cancelCodexLogin();
      for (const dispose of routes) dispose();
    };
  }, "codex: web auth routes");
}

/* ------------------------------------------------------------------ *
 * Message conversion (harness blocks → OpenAI Responses input items)
 * ------------------------------------------------------------------ */

function flattenText(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}

/** Normalize an id for the wire (responses item ids must be fc_-prefixed). */
function normalizeItemId(id, prefix = "fc_") {
  const sanitized = String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64).replace(/_+$/, "");
  return sanitized.length > 0 ? `${prefix}${sanitized}` : `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

/** Harness messages (content blocks) → Responses API `input` items. */
async function convertToResponsesMessages(messages, attachments) {
  const input = [];
  for (const message of messages) {
    if (message.role === "system") continue; // handled via `instructions`
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = [];
    const flush = () => {
      if (content.length === 0) return;
      input.push({ type: "message", role, content: [...content] });
      content.length = 0;
    };
    for (const block of message.content) {
      if (block.type === "text") {
        if (block.text.length > 0) content.push({ type: role === "assistant" ? "output_text" : "input_text", text: block.text });
      } else if (block.type === "image") {
        // Responses API input_image part (data-URL); requires the durable
        // attachment service. A missing service is an explicit error, never a
        // silent pixel drop.
        if (role !== "user") continue;
        if (!attachments) throw new LlmError("codex: image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
        const stored = await attachments.readImage(block.attachment);
        content.push({
          type: "input_image",
          image_url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}`,
          detail: "auto",
        });
      } else if (block.type === "tool-call") {
        // Tool calls are top-level `input` items, NOT message content parts;
        // nesting them in `content` is rejected with HTTP 400
        // `Invalid value: 'function_call'`.
        flush();
        let args;
        try {
          args = JSON.parse(block.arguments ?? "{}");
        } catch {
          args = {};
        }
        input.push({ type: "function_call", id: normalizeItemId(block.id, "fc_"), call_id: block.id ?? "", name: block.name ?? "", arguments: JSON.stringify(args) });
      } else if (block.type === "tool-result") {
        // Responses API function_call_output.output is a string — nested
        // images flatten to text (matches the API shape).
        flush();
        input.push({ type: "function_call_output", call_id: block.toolCallId ?? "", output: flattenText(block.content) || "(no output)" });
      }
    }
    flush();
  }
  return input;
}

/** Harness tools → Responses API tool definitions. */
function convertTools(tools) {
  return (tools ?? []).map((tool) => ({
    // The Responses API requires the `type` discriminator on every tool;
    // chatgpt.com rejects entries without it with HTTP 400
    // `{"detail":"Unsupported tool type: None"}`.
    type: "function",
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? { type: "object", properties: {} },
    strict: false,
  }));
}

/* ------------------------------------------------------------------ *
 * SSE stream translation → dsh-llm events
 * ------------------------------------------------------------------ */

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

/** Parse the SSE body into OpenAI Responses events. */
async function* parseResponsesSse(stream) {
  if (!stream) throw new LlmError("codex: response did not include a stream", "STREAM_CLOSED");
  const parsed = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream());
  for await (const event of parsed) {
    if (!event || typeof event.data !== "string" || event.data.length === 0) continue;
    if (event.data === "[DONE]") return;
    let parsedEvent;
    try {
      parsedEvent = JSON.parse(event.data);
    } catch {
      continue;
    }
    if (parsedEvent && typeof parsedEvent === "object") yield parsedEvent;
  }
}

/**
 * Translate the OpenAI Responses SSE stream into dsh-llm stream events.
 * Handles text deltas, reasoning deltas, tool-call deltas, usage and finish.
 */
async function* translateResponsesSse(events, emptyResponseCode = EMPTY_RESPONSE_CODE) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = new Map();
  const order = [];
  let pendingUsage;
  let sawTerminal = false;

  function open(kind, id, name) {
    const block = { index: nextIndex++, kind, text: "", ...(id !== undefined ? { callId: id } : {}), ...(name !== undefined ? { name } : {}) };
    order.push(block);
    return block;
  }

  for await (const event of events) {
    const type = typeof event.type === "string" ? event.type : "";
    switch (type) {
      case "response.created": {
        const usage = event.response?.usage;
        if (usage && typeof usage === "object") {
          pendingUsage = {
            inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
            outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
            ...(typeof usage.output_tokens_details?.reasoning_tokens === "number" ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens } : {}),
            ...(typeof usage.input_tokens_details?.cached_tokens === "number" ? { cacheReadTokens: usage.input_tokens_details.cached_tokens } : {}),
          };
        }
        continue;
      }
      case "response.output_item.added": {
        const item = event.item;
        if (!item || typeof item !== "object") continue;
        if (item.type === "message") {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        } else if (item.type === "reasoning") {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        } else if (item.type === "function_call") {
          const block = open("tool-call", typeof item.id === "string" ? item.id : "", typeof item.name === "string" ? item.name : "");
          block.seen = true;
          toolBlocks.set(block.index, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call", name: block.name };
        }
        continue;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        if (typeof event.delta !== "string" || event.delta.length === 0) continue;
        if (!reasoningBlock) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += event.delta;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: event.delta };
        continue;
      }
      case "response.output_text.delta": {
        if (typeof event.delta !== "string" || event.delta.length === 0) continue;
        if (!textBlock) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += event.delta;
        yield { type: "text-delta", index: textBlock.index, text: event.delta };
        continue;
      }
      case "response.function_call_arguments.delta": {
        if (typeof event.delta !== "string" || event.delta.length === 0) continue;
        const block = [...toolBlocks.values()].pop();
        if (block) {
          block.text += event.delta;
          yield {
            type: "tool-call-delta",
            index: block.index,
            id: CallId(block.callId ?? ""),
            ...(block.name !== undefined ? { name: block.name } : {}),
            argumentsDelta: event.delta,
          };
        }
        continue;
      }
      case "response.output_item.done": {
        const item = event.item;
        if (item && typeof item === "object" && item.type === "function_call") {
          const block = toolBlocks.get(event.output_index);
          if (block) {
            block.text = typeof item.arguments === "string" ? item.arguments : block.text;
            block.closed = true;
            yield { type: "block-end", index: block.index, block: closeBlock(block) };
          }
        }
        continue;
      }
      case "response.content_part.done": {
        const part = event.part;
        if (part && typeof part === "object" && part.type === "output_text" && textBlock) {
          textBlock.text = typeof part.text === "string" ? part.text : textBlock.text;
        }
        continue;
      }
      case "response.completed":
      case "response.incomplete": {
        sawTerminal = true;
        const response = event.response;
        if (response && typeof response === "object") {
          const usage = response.usage;
          if (usage && typeof usage === "object") {
            const cached = usage.input_tokens_details?.cached_tokens ?? 0;
            const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
            pendingUsage = {
              inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached - cacheWrite),
              outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
              ...(typeof usage.output_tokens_details?.reasoning_tokens === "number" ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens } : {}),
              ...(cached > 0 ? { cacheReadTokens: cached } : {}),
              ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
              totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
            };
          }
        }
        // Close any blocks that never got a done event.
        const closed = [];
        for (const block of order) {
          if (block.closed) continue;
          if (block.kind === "tool-call" && !block.seen) continue;
          block.closed = true;
          closed.push({ index: block.index, block: closeBlock(block) });
        }
        for (const entry of closed) yield { type: "block-end", index: entry.index, block: entry.block };
        if (pendingUsage) yield { type: "usage", usage: pendingUsage };
        const reason = type === "incomplete" ? { kind: "length" } : toolBlocks.size > 0 ? { kind: "tool-calls" } : { kind: "stop" };
        yield { type: "finish", reason };
        return;
      }
      case "response.failed": {
        sawTerminal = true;
        const response = event.response;
        const error = response?.error;
        const message = error
          ? `${error.code ?? "unknown"}: ${error.message ?? "no message"}`
          : response?.incomplete_details?.reason
            ? `incomplete: ${response.incomplete_details.reason}`
            : "Codex response failed";
        for (const block of order) {
          if (block.closed) continue;
          block.closed = true;
          yield { type: "block-end", index: block.index, block: closeBlock(block) };
        }
        yield { type: "finish", reason: { kind: "error", failure: { message, code: failedEventCode(error?.code) } } };
        return;
      }
      case "error": {
        throw new LlmError(`codex: upstream error ${event.code ?? ""}: ${event.message ?? "unknown error"}`, "SERVER");
      }
      default:
        break;
    }
  }

  if (!sawTerminal) {
    // Stream ended without a terminal event: close whatever we have.
    const closed = [];
    for (const block of order) {
      if (block.closed) continue;
      if (block.kind === "tool-call" && !block.seen) continue;
      block.closed = true;
      closed.push({ index: block.index, block: closeBlock(block) });
    }
    for (const entry of closed) yield { type: "block-end", index: entry.index, block: entry.block };
    if (pendingUsage) yield { type: "usage", usage: pendingUsage };
    if (order.length === 0) {
      yield { type: "finish", reason: { kind: "error", failure: { message: "model returned a completed response with no content", code: emptyResponseCode } } };
    } else {
      yield { type: "finish", reason: toolBlocks.size > 0 ? { kind: "tool-calls" } : { kind: "stop" } };
    }
  }
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

function reasoningInfo(modelId, effortLevels) {
  const efforts = (Array.isArray(effortLevels) && effortLevels.length > 0 ? effortLevels : EFFORT_IDS)
    .map((id) => ({ id, name: EFFORT_LABELS[id] ?? id }));
  return { efforts };
}

function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    inputModalities: ["text", "image"],
    ...(model.effortLevels !== undefined ? { reasoning: reasoningInfo(model.id, model.effortLevels) } : {}),
    toolCalling: "supported",
  };
}

/** Map a live `/codex/models` record to a harness catalog row. */
function liveModelToEntry(model) {
  const upstream = String(model?.slug ?? "");
  const levels = Array.isArray(model?.supported_reasoning_levels)
    ? model.supported_reasoning_levels.map((level) => (typeof level?.effort === "string" ? level.effort : typeof level === "string" ? level : undefined)).filter(Boolean)
    : undefined;
  const contextWindow = typeof model?.context_window === "number" && model.context_window > 0
    ? model.context_window
    : typeof model?.max_context_window === "number" && model.max_context_window > 0
      ? model.max_context_window
      : DEFAULT_CONTEXT_WINDOW;
  return {
    id: upstream,
    name: typeof model?.display_name === "string" && model.display_name.length > 0 ? model.display_name : upstream,
    upstream,
    contextWindow,
    ...(levels !== undefined && levels.length > 0 ? { effortLevels: levels } : {}),
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

class CodexAdapter extends LlmAdapter {
  constructor(config) {
    super();
    this.config = config;
    /** Serialized upstream control-plane calls (token refresh): one at a time. */
    this.chainTail = Promise.resolve();
    /** `${accountId}` → cooldown-until timestamp (ms), for multi-account rotation. */
    this.cooldowns = new Map();
    /** `${accountId}` values whose credentials the upstream rejected (invalid token). */
    this.invalidAccounts = new Set();
    /** Live catalog cache. */
    this.liveModels = { entries: undefined, fetchedAt: 0, fetching: null };
  }

  providerInfo(provider) {
    return { id: provider, name: "Codex" };
  }

  providerRetryPolicy(_provider) {
    return this.config.options().retryPolicy;
  }

  /** Merged catalog: configured/fallback rows overridden by the live list. */
  async effectiveModels() {
    const configured = this.config.options().models;
    const live = await this.getLiveModels();
    if (!live || live.length === 0) return configured;
    const byId = new Map(configured.map((entry) => [entry.id, entry]));
    const merged = [];
    const seen = new Set();
    for (const entry of live) {
      merged.push({ ...byId.get(entry.id), ...entry, name: entry.name ?? byId.get(entry.id)?.name ?? entry.id });
      seen.add(entry.id);
    }
    for (const entry of configured) {
      if (!seen.has(entry.id)) merged.push(entry);
    }
    return merged;
  }

  /**
   * Fetch the account's real model catalog from
   * `GET {baseURL}/codex/models?client_version=…` (verified live), cached 10 min.
   * A failure falls back to the configured list.
   */
  getLiveModels() {
    const now = Date.now();
    if (this.liveModels.entries && now - this.liveModels.fetchedAt < LIVE_MODELS_TTL_MS) {
      return Promise.resolve(this.liveModels.entries);
    }
    if (this.liveModels.fetching) return this.liveModels.fetching;
    this.liveModels.fetching = (async () => {
      try {
        const accounts = await this.config.resolveAccounts();
        if (accounts.length === 0) return undefined;
        let lastError;
        for (const account of accounts) {
          try {
            const token = await this.ensureValidToken(account, undefined);
            const query = new URLSearchParams({ client_version: this.config.options().clientVersion });
            const resp = await fetch(`${this.config.options().baseURL}/codex/models?${query}`, {
              headers: {
                accept: "application/json",
                authorization: `Bearer ${token.accessToken}`,
                "chatgpt-account-id": account.accountId,
                "openai-beta": "responses=experimental",
                originator: "codex_cli_rs",
                "user-agent": "dsh-seraphim",
              },
              signal: AbortSignal.timeout(LIVE_MODELS_TIMEOUT_MS),
            });
            if (!resp.ok) {
              lastError = new LlmError(`codex: models request failed (HTTP ${resp.status})`, httpErrorCode(resp.status, await resp.text().catch(() => "")));
              continue;
            }
            const data = await resp.json().catch(() => undefined);
            const rawModels = Array.isArray(data?.models) ? data.models : [];
            const entries = rawModels
              .map((model) => liveModelToEntry(model))
              .filter((entry) => typeof entry.upstream === "string" && entry.upstream.length > 0)
              .sort((a, b) => String(a.name).localeCompare(String(b.name)));
            this.liveModels.entries = entries;
            this.liveModels.fetchedAt = Date.now();
            return entries;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError ?? new LlmError("codex: no accounts to fetch models", "AUTH");
      } catch (error) {
        this.config.optionsLogger?.warn?.(`codex: live model discovery failed (${error instanceof Error ? error.message : error}); using fallback catalog`);
        return undefined;
      } finally {
        this.liveModels.fetching = null;
      }
    })();
    return this.liveModels.fetching;
  }

  listModels(provider) {
    if (this.config.isEnabled?.() === false) return Promise.resolve([]);
    return this.effectiveModels().then((models) => models.map((model) => modelInfo(provider, model)));
  }

  resolveModel(provider, model, _signal) {
    if (this.config.isEnabled?.() === false) throw new LlmError("codex: disabled in Seraphim settings — enable it in Settings → Seraphim", "DISABLED");
    return this.effectiveModels().then((models) => {
      const configured = models.find((entry) => entry.id === model);
      return {
        ...(configured === undefined
          ? { provider, id: model, name: model, inputModalities: ["text"], ...(model.startsWith("gpt-") ? { reasoning: reasoningInfo(model) } : {}) }
          : modelInfo(provider, configured)),
        context: { contextWindow: configured?.contextWindow ?? this.config.options().defaultContextWindow },
        defaultMaxTokens: configured?.maxTokens ?? this.config.options().maxTokens,
      };
    });
  }

  queue(fn) {
    const run = this.chainTail.then(() => new Promise((resolve) => setTimeout(resolve, CHAIN_GAP_MS))).then(fn);
    this.chainTail = run.catch(() => {});
    return run;
  }

  cooldownUntil(accountId) {
    return this.cooldowns.get(accountId) ?? 0;
  }

  cooldown(accountId, ms) {
    if (ms > 0) this.cooldowns.set(accountId, Date.now() + ms);
  }

  /** Whether a failure should move on to the next account instead of surfacing. */
  retryableAccountError(error) {
    if (!(error instanceof LlmError)) return true;
    if (error.options?.accountRetryable === true) return true;
    return !["UNKNOWN_MODEL", "INVALID_REQUEST", CONTEXT_WINDOW_EXCEEDED_CODE].includes(error.code);
  }

  accountCooldownMs(error) {
    if (error instanceof LlmError && typeof error.options?.providerRetryAfterMs === "number" && error.options.providerRetryAfterMs > 0) {
      return Math.min(error.options.providerRetryAfterMs, 15 * 60 * 1000);
    }
    const code = error?.code;
    if (code === "AUTH") return 30 * 60 * 1000;
    if (code === QUOTA_EXCEEDED_CODE || code === "RATE_LIMIT") return 5 * 60 * 1000;
    return 60 * 1000;
  }

  /**
   * Return an account whose access token is valid, refreshing it when needed.
   * Throws LlmError(AUTH) when the refresh token is dead.
   */
  async ensureValidToken(account, signal) {
    if (!tokenNeedsRefresh(account)) return account;
    return this.queue(async () => {
      const fresh = await refreshAccessToken(this.config.options(), account.refreshToken, signal);
      const accountId = accountIdFromToken(fresh.accessToken) ?? account.accountId;
      const plan = planFromToken(fresh.accessToken) ?? account.plan;
      const email = authClaim(fresh.accessToken)?.email ?? account.email;
      this.config.storeTokens(accountId, fresh, { plan, email });
      return { ...account, ...fresh, accountId, plan, email };
    });
  }

  invalidateAccount(accountId) {
    // A refreshed token stays valid; only a hard AUTH error invalidates the account.
    this.invalidAccounts.add(accountId);
  }

  /** Build the /codex/responses request body. */
  async buildRequestBody(entry, options, attachments) {
    const body = {
      model: entry.upstream,
      store: false,
      stream: true,
      instructions: options.system ?? "You are a helpful assistant.",
      input: await convertToResponsesMessages(options.messages, attachments),
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content"],
      tool_choice: "auto",
      parallel_tool_calls: true,
    };
    const tools = convertTools(options.tools);
    if (tools.length > 0) body.tools = tools;
    if (options.reasoningEffort !== undefined && options.reasoningEffort !== "none") {
      body.reasoning = { effort: options.reasoningEffort, summary: "auto" };
    } else if (options.reasoningEffort === "none") {
      body.reasoning = { effort: "none", summary: "auto" };
    }
    return body;
  }

  async *stream(options) {
    if (this.config.isEnabled?.() === false) throw new LlmError("codex: disabled in Seraphim settings — enable it in Settings → Seraphim", "DISABLED");
    const connection = this.config.options();
    const models = await this.effectiveModels();
    const entry = models.find((m) => m.id === options.model);
    if (!entry) throw new LlmError(`codex: unknown model "${options.model}"`, "UNKNOWN_MODEL");
    const accounts = await this.config.resolveAccounts();
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
      for (const account of accounts) {
        if (this.invalidAccounts.has(account.accountId)) continue;
        if (this.cooldownUntil(account.accountId) > Date.now()) {
          lastError = new LlmError("codex: an account is cooling down (rate-limited); wait for the cooldown, or add another account", "RATE_LIMIT");
          continue;
        }
        let response;
        try {
          const attachments = this.config.resolveAttachments?.();
          const payload = await this.buildRequestBody(entry, options, attachments);
          response = await this.streamRequest(account, payload, connection, options, signal);
        } catch (error) {
          if (timedOut) throw error;
          if (options.signal?.aborted) throw error;
          lastError = error;
          if (this.retryableAccountError(error)) {
            this.cooldown(account.accountId, this.accountCooldownMs(error));
            continue;
          }
          throw error;
        }
        const iterator = translateResponsesSse(parseResponsesSse(response.body), EMPTY_RESPONSE_CODE)[Symbol.asyncIterator]();
        while (true) {
          const result = await iterator.next();
          if (result.done) return;
          armIdle();
          yield result.value;
        }
      }
      throw lastError ?? new LlmError("codex: all accounts failed", "SERVER");
    } catch (error) {
      if (timedOut) throw new LlmError(`codex: stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
      if (options.signal?.aborted) throw new LlmError("codex: request aborted by caller", "ABORTED", { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(`codex: API stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
    } finally {
      clearTimeout(idleTimer);
      consumer.abort();
    }
  }

  async streamRequest(account, payload, connection, options, signal) {
    const headers = {
      accept: "text/event-stream",
      "content-type": "application/json",
      "openai-beta": "responses=experimental",
      originator: "codex_cli_rs",
      "user-agent": "dsh-seraphim",
      ...attributionHeaders(),
      ...(options.sessionId !== undefined ? { "x-harness-session-id": String(options.sessionId) } : {}),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const valid = await this.ensureValidToken(account, signal);
      headers.authorization = `Bearer ${valid.accessToken}`;
      headers["chatgpt-account-id"] = valid.accountId;
      let response;
      try {
        response = await fetch(`${connection.baseURL}/codex/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new LlmError(`codex: API request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
      }
      if (response.ok) return response;
      const errText = await response.text();
      const status = response.status;
      if (status === 401 || status === 403) {
        if (attempt === 0) {
          // Force a fresh token (drop cache) and retry once.
          this.config.invalidateRefresh(account.accountId);
          await this.ensureValidToken({ ...account, expiresAtMs: 0 }, signal);
          continue;
        }
        this.invalidAccounts.add(account.accountId);
        throw new LlmError(`codex: account "${account.accountId}" was rejected (HTTP ${status}) — sign in again`, "AUTH", { status, accountRetryable: true });
      }
      if (status === 429 && isUsageLimitError(errText)) {
        throw new LlmError(`codex: usage limit reached${errText ? `: ${errText.slice(0, 160)}` : ""}`, QUOTA_EXCEEDED_CODE, { status });
      }
      const retryAfterMs = parseRetryAfterMs(errText, status, response.headers);
      throw new LlmError(
        `codex: API error (HTTP ${status})${errText ? `: ${errText.slice(0, 200)}` : ""}`,
        httpErrorCode(status, errText),
        { status, ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }) },
      );
    }
    throw new LlmError("codex: completion request failed after token refresh", "AUTH");
  }
}

/* ------------------------------------------------------------------ *
 * Config resolution + plugin apply
 * ------------------------------------------------------------------ */

function resolveModels(models) {
  const seen = new Set();
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (!model.id || !model.upstream) {
      throw new Error(`codex: catalog model "${model.id}" needs id/upstream`);
    }
    if (seen.has(model.id)) throw new Error(`codex: duplicate catalog model "${model.id}"`);
    seen.add(model.id);
    return {
      id: model.id,
      name: model.name ?? model.id,
      upstream: model.upstream,
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(Array.isArray(model.effortLevels) && model.effortLevels.length > 0 ? { effortLevels: model.effortLevels } : {}),
    };
  });
}

function resolveAdapterOptions(config = {}) {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error("codex: streamIdleTimeoutMs must be a positive finite number");
  }
  return {
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    authBaseURL: config.authBaseURL ?? DEFAULT_AUTH_BASE_URL,
    oauthClientId: config.oauthClientId ?? DEFAULT_CLIENT_ID,
    oauthRedirectUri: config.oauthRedirectUri ?? DEFAULT_REDIRECT_URI,
    oauthScope: config.oauthScope ?? DEFAULT_SCOPE,
    clientVersion: config.clientVersion ?? "0.147.0",
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, "codex: retryPolicy"),
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
      ctx.logger?.error?.("codex: keeping the last good configuration after an invalid settings section");
      ctx.logger?.error?.(error);
      return lastGood;
    }
  };
  options();

  const store = new CodexCredentialStore();

  const resolveAccounts = async () => {
    const accounts = store.accounts();
    if (accounts.length === 0) {
      throw new LlmError(
        "codex: not signed in; open Settings → Seraphim → Codex and sign in with ChatGPT",
        "AUTH",
      );
    }
    return accounts;
  };

  const storeTokens = (accountId, tokens, meta) => {
    store.updateTokens(accountId, tokens, meta);
  };

  const invalidateRefresh = (accountId) => {
    // A forced refresh uses the same refresh token; nothing to invalidate here
    // except the in-memory expiry so ensureValidToken actually re-runs.
    const account = store.accounts().find((a) => a.accountId === accountId);
    if (account) store.updateTokens(accountId, { expiresAtMs: 0 });
  };

  const flags = new ProviderFlagsStore();
  const adapter = new CodexAdapter({
    options,
    resolveAccounts,
    storeTokens,
    invalidateRefresh,
    isEnabled: () => flags.enabled(PROVIDER),
    // Durable attachment service (image uploads), resolved lazily at request
    // time like the built-in pi-ai adapter wires it.
    resolveAttachments: () => {
      try {
        return ctx.get("attachments");
      } catch {
        return undefined;
      }
    },
  });
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: "Codex", settingsNs: NS, settingsPath: [] }]);

  // Fire a boot-time live-catalog fetch so the picker is correct on first open.
  adapter.getLiveModels().catch(() => {});

  ctx.inject(["webServer"], (webCtx) => registerCodexAuthRoutes(webCtx, store, options, ctx.logger));

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {},
  });
}

export {
  ACCOUNTS_PATH,
  CANCEL_PATH,
  CLIENT_ID,
  Config,
  CodexAdapter,
  CodexCredentialStore,
  DEFAULT_MODELS,
  JWT_CLAIM_PATH,
  LOGIN_PATH,
  LOGOUT_PATH,
  NS,
  PROVIDER,
  STATUS_PATH,
  USAGE_PATH,
  accountIdFromToken,
  apply,
  authClaim,
  buildAuthorizeUrl,
  convertTools,
  convertToResponsesMessages,
  createPkcePair,
  exchangeCode,
  failedEventCode,
  httpErrorCode,
  inject,
  jwtExpiryMs,
  liveModelToEntry,
  name,
  parseJwtClaims,
  parseResponsesSse,
  parseUsage,
  planFromToken,
  refreshAccessToken,
  registerCodexAuthRoutes,
  resolveAdapterOptions,
  tokenNeedsRefresh,
  translateResponsesSse,
};
