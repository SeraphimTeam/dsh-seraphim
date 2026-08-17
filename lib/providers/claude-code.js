import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
import {
  DEFAULT_EXCLUDED_MODEL_IDS,
  DEFAULT_MODELS,
  MODEL_CATALOG_CACHE_MS,
  fetchModelCatalog,
  filterExcludedModels,
} from "./claude-code-model-catalog.js";
import {
  AntiBanEngine,
  claudeCodeTools,
  rotateFingerprint,
} from "./claude-code-anti-ban.js";

/**
 * Claude Code subscription models as a native DeepSeek Harness provider.
 *
 * The transport follows Claude Code's subscription OAuth contract: PKCE login
 * against claude.com, token exchange at platform.claude.com, and Anthropic
 * Messages streaming with the oauth beta and Claude Code attribution headers.
 * Harness remains the owner of the agent loop, tools, approvals, and sessions.
 */

const name = "llm-claude-code";
const inject = ["llm"];
const PROVIDER = "claude-code";
const NS = settingsNamespace("llm-claude-code");

const STATUS_PATH = "/plugins/claude-code/auth/status";
const LOGIN_PATH = "/plugins/claude-code/auth/login";
const IMPORT_PATH = "/plugins/claude-code/auth/import";
const CANCEL_PATH = "/plugins/claude-code/auth/cancel";
const LOGOUT_PATH = "/plugins/claude-code/auth/logout";
const ACCOUNTS_PATH = "/plugins/claude-code/auth/accounts";
const USAGE_PATH = "/plugins/claude-code/auth/usage";

const CREDENTIAL_FILE = ".claude-code-oauth.json";
const DEFAULT_CLAUDE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const DEFAULT_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const DEFAULT_OAUTH_SUCCESS_URL = "https://platform.claude.com/oauth/code/success?app=claude-code";
const DEFAULT_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const DEFAULT_CLIENT_VERSION = "2.1.162";
const DEFAULT_SYSTEM_PROMPT = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_CODE_IDENTITY_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14";
const OAUTH_SCOPES = ["user:inference", "user:profile"];
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
const MAX_TIMER_DELAY_MS = 2147483647;
const LOGIN_DEADLINE_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;

const THINKING_BUDGETS = {
  low: 1024,
  medium: 4096,
  high: 8192,
  max: 16384,
};

const EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
};

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  upstream: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
});

const Config = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  oauthAuthorizeURL: z.string().default(DEFAULT_OAUTH_AUTHORIZE_URL),
  oauthTokenURL: z.string().default(DEFAULT_OAUTH_TOKEN_URL),
  oauthSuccessURL: z.string().default(DEFAULT_OAUTH_SUCCESS_URL),
  oauthClientId: z.string().default(DEFAULT_OAUTH_CLIENT_ID),
  claudeCredentialsPath: z.string(),
  clientVersion: z.string().default(DEFAULT_CLIENT_VERSION),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  excludedModelIds: z.array(z.string()).default(DEFAULT_EXCLUDED_MODEL_IDS),
  streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  antiBan: z.object({
    enabled: z.boolean(),
    rotatePerRequest: z.boolean(),
    entrypoint: z.string(),
    clientVersion: z.string(),
    quietHours: z.object({
      start: z.number().min(0).max(23),
      end: z.number().min(0).max(23),
    }),
  }),
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textValue(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeExpiresAt(value) {
  const number = numberValue(value);
  if (number === undefined || number <= 0) return undefined;
  return number < 100000000000 ? number * 1000 : number;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function createPkcePair() {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function safeErrorText(value, fallback = "upstream request failed") {
  if (isRecord(value)) {
    const nested = value.error;
    const message = textValue(value.message) ?? (isRecord(nested) ? textValue(nested.message) : undefined);
    if (message) return message.slice(0, 240);
  }
  return fallback;
}

async function readResponseJson(response) {
  return response.json().catch(() => undefined);
}

/** Read a JSON request body from a Node IncomingMessage (streamed chunks). */
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

async function readResponseText(response) {
  return response.text().catch(() => "");
}

function signalFor(...signals) {
  const active = signals.filter((signal) => signal instanceof AbortSignal);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function credentialFile() {
  return join(resolveDshHome(), CREDENTIAL_FILE);
}

function atomicWriteJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    /* Windows may not expose POSIX modes. */
  }
  try {
    renameSync(temp, file);
  } catch {
    try {
      unlinkSync(file);
    } catch {
      /* target may not exist */
    }
    renameSync(temp, file);
  }
}

function normalizeScopes(value) {
  if (Array.isArray(value)) return value.filter((scope) => typeof scope === "string" && scope.length > 0);
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}

function normalizeAccount(raw, sourceOverride) {
  if (!isRecord(raw)) return undefined;
  const accessToken = textValue(raw.accessToken) ?? textValue(raw.access_token);
  const refreshToken = textValue(raw.refreshToken) ?? textValue(raw.refresh_token);
  if (!accessToken) return undefined;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(normalizeExpiresAt(raw.expiresAt ?? raw.expires_at) !== undefined ? { expiresAt: normalizeExpiresAt(raw.expiresAt ?? raw.expires_at) } : {}),
    scopes: normalizeScopes(raw.scopes ?? raw.scope),
    ...(textValue(raw.subscriptionType) ? { subscriptionType: raw.subscriptionType } : {}),
    ...(textValue(raw.rateLimitTier) ? { rateLimitTier: raw.rateLimitTier } : {}),
    ...(textValue(raw.source) || sourceOverride ? { source: sourceOverride ?? raw.source } : {}),
    ...(numberValue(raw.storedAt) !== undefined ? { storedAt: raw.storedAt } : {}),
  };
}

function accountFromClaudeDocument(document) {
  return normalizeAccount(document?.claudeAiOauth, "import");
}

/** Plugin-owned Claude OAuth credentials. It never writes the Claude Code file. */
class ClaudeCodeCredentialStore {
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

  writeAccounts(accounts) {
    atomicWriteJson(this.file, { version: 2, accounts });
  }

  /** Normalize the legacy single-account and current multi-account shapes into a list. */
  accounts() {
    const document = this.read();
    const list = [];
    if (document?.account) {
      const account = normalizeAccount(document.account, document.account?.source);
      if (account) list.push(account);
    } else {
      const legacy = normalizeAccount(document, undefined);
      if (legacy) list.push(legacy);
    }
    if (Array.isArray(document?.accounts)) {
      for (const entry of document.accounts) {
        const account = normalizeAccount(entry, entry?.source);
        if (account) list.push(account);
      }
    }
    return list;
  }

  /** First account (back-compat for resolvers and status). */
  account() {
    return this.accounts()[0];
  }

  /** Append an account (dedup by refresh/access token) instead of overwriting, so several accounts can rotate. */
  addAccount(account, source) {
    const normalized = normalizeAccount(account, source ?? account?.source ?? "oauth");
    if (!normalized) throw new Error("Claude Code credentials are missing an access token");
    const stored = { ...normalized, storedAt: Date.now() };
    const accounts = this.accounts();
    const existingIndex = accounts.findIndex(
      (entry) =>
        (entry.refreshToken && stored.refreshToken && entry.refreshToken === stored.refreshToken) ||
        entry.accessToken === stored.accessToken,
    );
    if (existingIndex >= 0) accounts[existingIndex] = stored;
    else accounts.push(stored);
    this.writeAccounts(accounts);
    return stored;
  }

  /** Alias kept for refresh/import callers (append-or-update semantics). */
  save(account) {
    return this.addAccount(account, account?.source);
  }

  updateMetadata(metadata) {
    const accounts = this.accounts();
    const target = accounts.find((entry) => entry.accessToken === metadata?.accessToken) ?? accounts[0];
    if (!target) return undefined;
    Object.assign(target, metadata, { storedAt: Date.now() });
    this.writeAccounts(accounts);
    return target;
  }

  importClaudeCode(file = DEFAULT_CLAUDE_CREDENTIALS_PATH) {
    const source = JSON.parse(readFileSync(file, "utf8"));
    const account = accountFromClaudeDocument(source);
    if (!account) throw new Error("Claude Code credential file has no usable claudeAiOauth access token");
    return this.addAccount(account, "import");
  }

  /** Secret-free account metadata for the card (no tokens). */
  listMeta() {
    return this.accounts().map((account, index) => ({
      index,
      source: account.source,
      subscriptionType: account.subscriptionType,
      rateLimitTier: account.rateLimitTier,
      scopes: account.scopes,
      expiresAt: account.expiresAt,
      storedAt: account.storedAt,
    }));
  }

  /** Remove an account by list index or by access token; returns the new account count. */
  removeAccount(selector) {
    const accounts = this.accounts();
    const next = accounts.filter((account, index) => {
      if (typeof selector === "number") return index !== selector;
      return account.accessToken !== selector;
    });
    if (next.length === accounts.length) return accounts.length;
    this.writeAccounts(next);
    return next.length;
  }

  status(extra = {}) {
    const accounts = this.accounts();
    const first = accounts[0];
    const expired = first?.expiresAt !== undefined && first.expiresAt <= Date.now();
    return {
      status: extra.error ? "error" : extra.pending ? "pending" : !first ? "signed_out" : expired ? "expired" : "signed_in",
      signedIn: Boolean(first),
      accountCount: accounts.length,
      pending: extra.pending === true,
      ...(first?.expiresAt !== undefined ? { expiresAt: first.expiresAt } : {}),
      ...(first?.subscriptionType ? { subscriptionType: first.subscriptionType } : {}),
      ...(first?.rateLimitTier ? { rateLimitTier: first.rateLimitTier } : {}),
      ...(first?.scopes?.length ? { scopes: first.scopes } : {}),
      ...(first?.source ? { source: first.source } : {}),
      ...(extra.error ? { error: String(extra.error).slice(0, 240) } : {}),
    };
  }

  clear() {
    try {
      atomicWriteJson(this.file, {});
    } catch {
      /* Sign-out is best effort when the home is read-only. */
    }
  }
}

function buildAuthorizeUrl(options, port, state, pkce) {
  const redirectUri = `http://localhost:${port}/callback`;
  const url = new URL(options.oauthAuthorizeURL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", options.oauthClientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return { url: url.toString(), redirectUri };
}

function normalizedTokenResponse(value, source = "oauth") {
  if (!isRecord(value)) throw new Error("OAuth token response was not an object");
  const account = normalizeAccount({
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_at: value.expires_at ?? (numberValue(value.expires_in) !== undefined ? Date.now() + value.expires_in * 1000 : undefined),
    scope: value.scope ?? OAUTH_SCOPES,
    subscriptionType: value.subscriptionType,
    rateLimitTier: value.rateLimitTier,
    source,
  }, source);
  if (!account) throw new Error("OAuth token response did not contain an access token");
  return account;
}

async function exchangeCode(options, code, state, verifier, redirectUri, signal) {
  const response = await fetch(options.oauthTokenURL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "anthropic-beta": OAUTH_BETA,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: options.oauthClientId,
      code_verifier: verifier,
      state,
    }),
    signal,
  });
  const data = await readResponseJson(response);
  if (!response.ok) throw new Error(`OAuth code exchange failed (HTTP ${response.status})`);
  return normalizedTokenResponse(data, "oauth");
}

async function refreshToken(options, account, signal) {
  if (!account.refreshToken) throw new LlmError("claude-code: the access token expired and no refresh token is stored", "AUTH");
  const response = await fetch(options.oauthTokenURL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "anthropic-beta": OAUTH_BETA,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
      client_id: options.oauthClientId,
    }),
    signal,
  });
  const data = await readResponseJson(response);
  if (!response.ok) throw new LlmError(`claude-code: OAuth refresh failed (HTTP ${response.status})`, "AUTH", { status: response.status });
  const next = normalizedTokenResponse(data, account.source ?? "oauth");
  return {
    ...account,
    ...next,
    refreshToken: next.refreshToken ?? account.refreshToken,
    subscriptionType: next.subscriptionType ?? account.subscriptionType,
    rateLimitTier: next.rateLimitTier ?? account.rateLimitTier,
  };
}

async function fetchProfileMetadata(baseURL, accessToken) {
  try {
    const response = await fetch(`${String(baseURL).replace(/\/+$/, "")}/api/oauth/profile`, {
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return undefined;
    const data = await readResponseJson(response);
    const organization = isRecord(data?.organization) ? data.organization : data;
    if (!isRecord(organization)) return undefined;
    return {
      ...(textValue(organization.organization_type) ? { subscriptionType: organization.organization_type } : {}),
      ...(textValue(organization.rate_limit_tier) ? { rateLimitTier: organization.rate_limit_tier } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Fetch the subscription usage snapshot for one OAuth account (never throws).
 * `GET /api/oauth/usage` returns plan-window utilization percentages:
 *   five_hour  -> the rolling 5-hour Claude Code window (utilization %, resets_at)
 *   seven_day  -> the weekly window (utilization %, resets_at)
 * The card renders these as "5h" / "weekly" bars like the official Claude Code
 * usage panel. Never includes tokens.
 */
async function fetchUsageSnapshot(baseURL, accessToken) {
  try {
    const response = await fetch(`${String(baseURL).replace(/\/+$/, "")}/api/oauth/usage`, {
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return undefined;
    const data = await readResponseJson(response);
    if (!isRecord(data)) return undefined;
    const pick = (key) => {
      const value = isRecord(data[key]) ? data[key] : undefined;
      if (!value) return undefined;
      return {
        ...(typeof value.utilization === "number" ? { utilization: value.utilization } : {}),
        ...(typeof value.resets_at === "string" ? { resetsAt: value.resets_at } : {}),
      };
    };
    return {
      fiveHour: pick("five_hour"),
      sevenDay: pick("seven_day"),
    };
  } catch {
    return undefined;
  }
}

const PENDING_LOGIN = { flow: null };
let LAST_AUTH_ERROR;

function closePendingLogin(flow) {
  if (!flow || PENDING_LOGIN.flow !== flow) return;
  if (flow.timer) clearTimeout(flow.timer);
  flow.cancelled = true;
  try {
    flow.server?.close();
  } catch {
    /* server may already be closed */
  }
  PENDING_LOGIN.flow = null;
}

function cancelClaudeCodeLogin() {
  closePendingLogin(PENDING_LOGIN.flow);
}

async function startClaudeCodeLogin(options, store, logger, onCredentialsChanged = () => {}) {
  if (PENDING_LOGIN.flow) return { ok: true, pending: true, url: PENDING_LOGIN.flow.url };
  const pkce = createPkcePair();
  const state = base64UrlEncode(randomBytes(24));
  const flow = {
    pkce,
    state,
    server: null,
    timer: null,
    port: 0,
    redirectUri: "",
    url: "",
    deadline: Date.now() + LOGIN_DEADLINE_MS,
    cancelled: false,
  };
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (requestUrl.pathname !== "/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    if (flow.cancelled || Date.now() > flow.deadline) {
      response.writeHead(410, { "content-type": "text/plain; charset=utf-8" });
      response.end("Authorization expired");
      closePendingLogin(flow);
      return;
    }
    const callbackState = requestUrl.searchParams.get("state");
    const code = requestUrl.searchParams.get("code");
    const oauthError = requestUrl.searchParams.get("error");
    if (callbackState !== flow.state) {
      LAST_AUTH_ERROR = "Claude Code authorization state did not match";
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Authorization state did not match");
      closePendingLogin(flow);
      return;
    }
    if (!code) {
      LAST_AUTH_ERROR = oauthError ? `Claude Code authorization failed: ${oauthError}` : "Claude Code authorization returned no code";
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end(LAST_AUTH_ERROR);
      closePendingLogin(flow);
      return;
    }
    try {
      const account = await exchangeCode(options, code, flow.state, flow.pkce.verifier, flow.redirectUri);
      store.save(account);
      const metadata = await fetchProfileMetadata(options.baseURL, account.accessToken);
      if (metadata) store.updateMetadata(metadata);
      onCredentialsChanged();
      LAST_AUTH_ERROR = undefined;
      response.writeHead(302, { location: options.oauthSuccessURL, "cache-control": "no-store" });
      response.end();
      closePendingLogin(flow);
    } catch (error) {
      LAST_AUTH_ERROR = error instanceof Error ? error.message : "Claude Code authorization failed";
      logger?.error?.(`claude-code: ${LAST_AUTH_ERROR}`);
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Claude Code authorization failed. Return to DSH and try again.");
      closePendingLogin(flow);
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    if (!port) throw new Error("Claude Code callback server failed to bind");
    const auth = buildAuthorizeUrl(options, port, state, pkce);
    flow.port = port;
    flow.redirectUri = auth.redirectUri;
    flow.url = auth.url;
    flow.server = server;
    PENDING_LOGIN.flow = flow;
    flow.timer = setTimeout(() => {
      LAST_AUTH_ERROR = "Claude Code authorization window expired";
      closePendingLogin(flow);
    }, LOGIN_DEADLINE_MS);
    flow.timer.unref?.();
    return { ok: true, pending: true, url: flow.url };
  } catch (error) {
    try {
      server.close();
    } catch {
      /* ignore close failure */
    }
    throw new Error(error instanceof Error ? error.message : "Claude Code login failed");
  }
}

function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

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

function registerClaudeCodeAuthRoutes(ctx, store, options, logger, onCredentialsChanged = () => {}) {
  return ctx.effect(() => {
    const routes = [
      ctx.webServer.register({
        kind: "exact",
        path: STATUS_PATH,
        handler: async (req, res) => {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          return json(res, 200, store.status({ pending: Boolean(PENDING_LOGIN.flow), error: LAST_AUTH_ERROR }));
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: LOGIN_PATH,
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          try {
            const result = await startClaudeCodeLogin(options(), store, logger, onCredentialsChanged);
            return json(res, 200, result);
          } catch (error) {
            LAST_AUTH_ERROR = error instanceof Error ? error.message : "Claude Code login failed";
            return json(res, 500, { ok: false, error: LAST_AUTH_ERROR });
          }
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: IMPORT_PATH,
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          try {
            const account = store.importClaudeCode(options().claudeCredentialsPath ?? DEFAULT_CLAUDE_CREDENTIALS_PATH);
            const metadata = await fetchProfileMetadata(options().baseURL, account.accessToken);
            if (metadata) store.updateMetadata(metadata);
            onCredentialsChanged();
            LAST_AUTH_ERROR = undefined;
            return json(res, 200, { ok: true, status: store.status({ pending: Boolean(PENDING_LOGIN.flow) }) });
          } catch (error) {
            LAST_AUTH_ERROR = error instanceof Error ? error.message : "Claude Code login import failed";
            return json(res, 400, { ok: false, error: LAST_AUTH_ERROR });
          }
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: CANCEL_PATH,
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          cancelClaudeCodeLogin();
          return json(res, 200, { ok: true, status: store.status() });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: LOGOUT_PATH,
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          cancelClaudeCodeLogin();
          store.clear();
          onCredentialsChanged();
          LAST_AUTH_ERROR = undefined;
          return json(res, 200, { ok: true, status: store.status() });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: ACCOUNTS_PATH,
        handler: async (req, res) => {
          if (req.method === "GET") {
            return json(res, 200, { accounts: store.listMeta() });
          }
          if (req.method === "DELETE") {
            if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
            try {
              const body = await readJsonBody(req);
              const selector = typeof body?.index === "number" ? body.index : body?.accessToken;
              if (selector === undefined) return json(res, 400, { error: "missing account index" });
              const count = store.removeAccount(selector);
              onCredentialsChanged();
              LAST_AUTH_ERROR = undefined;
              return json(res, 200, { ok: true, accountCount: count, status: store.status() });
            } catch (error) {
              LAST_AUTH_ERROR = error instanceof Error ? error.message : "Claude Code account removal failed";
              return json(res, 400, { ok: false, error: LAST_AUTH_ERROR });
            }
          }
          return json(res, 405, { error: "method not allowed" });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: USAGE_PATH,
        handler: async (req, res) => {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          try {
            const accounts = store.accounts();
            const usage = [];
            for (const account of accounts) {
              // Backfill subscription metadata when it is missing (e.g. an
              // account signed in before profile enrichment existed).
              let meta = { subscriptionType: account.subscriptionType, rateLimitTier: account.rateLimitTier };
              if (!meta.subscriptionType || !meta.rateLimitTier) {
                const fetched = await fetchProfileMetadata(options().baseURL, account.accessToken);
                if (fetched) {
                  meta = { ...meta, ...fetched };
                  store.updateMetadata({ ...fetched, accessToken: account.accessToken });
                }
              }
              const snapshot = await fetchUsageSnapshot(options().baseURL, account.accessToken);
              usage.push({
                index: usage.length,
                ...(meta.subscriptionType ? { subscriptionType: meta.subscriptionType } : {}),
                ...(meta.rateLimitTier ? { rateLimitTier: meta.rateLimitTier } : {}),
                ...(snapshot ? { usage: snapshot } : {}),
              });
            }
            return json(res, 200, { usage });
          } catch (error) {
            return json(res, 500, { usage: [], error: error instanceof Error ? error.message : "usage unavailable" });
          }
        },
      }),
    ];
    return async () => {
      cancelClaudeCodeLogin();
      for (const dispose of routes) dispose();
    };
  }, "claude-code: web auth routes");
}

function flattenText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function serializeAssistantAnthropic(message) {
  const blocks = [];
  const text = flattenText(message.content);
  if (text.length > 0) blocks.push({ type: "text", text });
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type !== "tool-call") continue;
    let input = {};
    if (typeof block.arguments === "string" && block.arguments.length > 0) {
      try {
        input = JSON.parse(block.arguments);
      } catch {
        input = {};
      }
    } else if (isRecord(block.arguments)) {
      input = block.arguments;
    }
    blocks.push({ type: "tool_use", id: block.id ?? block.toolCallId ?? randomUUID(), name: block.name ?? "tool", input });
  }
  return { role: "assistant", content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }] };
}

function serializeUserAnthropic(message) {
  const blocks = [];
  const text = flattenText(message.content);
  if (text.length > 0) blocks.push({ type: "text", text });
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type !== "tool-result") continue;
    blocks.push({
      type: "tool_result",
      tool_use_id: block.toolCallId ?? block.id ?? "",
      content: flattenText(block.content) || "(no output)",
      ...(block.isError === true ? { is_error: true } : {}),
    });
  }
  return { role: "user", content: blocks.length > 0 ? blocks : [{ type: "text", text }] };
}

function convertToAnthropicMessages(messages = []) {
  const wire = [];
  for (const message of messages) {
    if (!message || message.role === "system") continue;
    if (message.role === "assistant") wire.push(serializeAssistantAnthropic(message));
    else if (message.role === "user") wire.push(serializeUserAnthropic(message));
    else wire.push({ role: "user", content: [{ type: "text", text: flattenText(message.content) }] });
  }
  return wire;
}

function convertTools(tools) {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.parameters ?? tool.input_schema ?? { type: "object", properties: {} },
  }));
}

function reasoningInfo(modelId) {
  if (!String(modelId).startsWith("anthropic/")) return undefined;
  return {
    efforts: Object.entries(THINKING_BUDGETS).map(([id, budget]) => ({
      id,
      name: EFFORT_LABELS[id] ?? id,
      description: `Extended thinking up to ${budget.toLocaleString("en-US")} tokens`,
    })),
  };
}

/**
 * Normalize the top-level `system` field into the format the Claude
 * subscription route accepts.
 *
 * Verified against the live route (2026-08-16):
 * 1. The route 429s any request without a non-empty `system`; empty strings,
 *    arrays, and missing values all fall back to the agent line.
 * 2. Large system prompts must be sent as exactly TWO cache_control blocks:
 *    a short Claude Code identity prefix, then the full original text.
 *    Chunking into 4+ blocks is rejected with HTTP 429, and a single plain
 *    large string is also rejected.
 */
function normalizeSystem(system) {
  let text;
  if (typeof system === "string") {
    text = system.trim();
  } else if (Array.isArray(system)) {
    text = system
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .join("\n")
      .trim();
  }
  if (!text) return DEFAULT_SYSTEM_PROMPT;
  // Short prompts stay a plain string (matches the working live path).
  if (text.length <= 4096) return text;
  // Long prompts: prefix block + full text block, both cache_control.
  return [
    { type: "text", text: CLAUDE_CODE_IDENTITY_PREFIX, cache_control: { type: "ephemeral" } },
    { type: "text", text, cache_control: { type: "ephemeral" } },
  ];
}

function buildAnthropicPayload(options, entry) {
  const effort = options.reasoningEffort;
  const thinkingBudget = typeof effort === "string" ? THINKING_BUDGETS[effort] : undefined;
  const requestedMaxTokens = options.maxTokens ?? entry.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxTokens = thinkingBudget === undefined ? requestedMaxTokens : Math.max(requestedMaxTokens, thinkingBudget + 1024);
  const system = normalizeSystem(options.system);
  const request = {
    model: entry.upstream,
    max_tokens: maxTokens,
    stream: true,
    messages: convertToAnthropicMessages(options.messages),
    system,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.topP !== undefined ? { top_p: options.topP } : {}),
  };
  const tools = convertTools(options.tools);
  if (tools.length > 0) {
    request.tools = tools;
    request.tool_choice = { type: "auto" };
  }
  if (thinkingBudget !== undefined) request.thinking = { type: "enabled", budget_tokens: thinkingBudget };
  return request;
}

function buildAnthropicHeaders(token, options, overrides = {}) {
  const fingerprint = options.fingerprint ?? {};
  const clientVersion = fingerprint.cliVersion ?? options.clientVersion;
  return {
    ...attributionHeaders(),
    accept: overrides.accept ?? "text/event-stream",
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": OAUTH_BETA,
    "anthropic-dangerous-direct-browser-access": "true",
    "user-agent": `claude-cli/${clientVersion} (external, sdk-cli)`,
    "x-app": "cli",
    ...(fingerprint.sessionId ? { "x-claude-code-session-id": fingerprint.sessionId } : {}),
    ...(fingerprint.arch ? { "x-stainless-arch": fingerprint.arch } : {}),
    ...(fingerprint.os ? { "x-stainless-os": fingerprint.os } : {}),
    ...(fingerprint.runtime ? { "x-stainless-runtime": fingerprint.runtime } : {}),
    ...(fingerprint.runtimeVersion ? { "x-stainless-runtime-version": fingerprint.runtimeVersion } : {}),
    ...(fingerprint.stainless ? { "x-stainless-package-version": fingerprint.stainless } : {}),
    ...(fingerprint.stainless ? { "x-stainless-retry-count": "0", "x-stainless-timeout": "600" } : {}),
    ...(options.antiBan?.entrypoint
      ? { "x-anthropic-billing-header": `cc_version=${clientVersion}; cc_entrypoint=${options.antiBan.entrypoint}; cch=00000;` }
      : { "x-anthropic-billing-header": `cc_version=${clientVersion}; cc_entrypoint=dsh-claude-code; cch=00000;` }),
  };
}

async function* parseAnthropicSse(stream) {
  if (!stream) throw new LlmError("claude-code: response did not include a stream", "STREAM_CLOSED");
  const parsed = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream());
  for await (const event of parsed) {
    if (!event || typeof event.data !== "string" || event.data.length === 0) continue;
    if (event.data === "[DONE]") return;
    yield event;
  }
}

function closeBlock(block) {
  if (block.kind === "text") return { type: "text", text: block.text };
  if (block.kind === "reasoning") return { type: "reasoning", text: block.text };
  if (block.kind === "tool-call") return { type: "tool-call", id: CallId(block.callId ?? ""), name: block.name ?? "", arguments: block.text };
  return { type: "text", text: block.text };
}

function finishReason(stopReason, hasTools) {
  if (stopReason === "tool_use" || hasTools) return { kind: "tool-calls" };
  if (stopReason === "max_tokens") return { kind: "max-tokens" };
  if (stopReason === "end_turn" || stopReason === "stop_sequence" || stopReason === undefined) return { kind: "stop" };
  return { kind: "stop" };
}

function usageFrom(value, previous) {
  if (!isRecord(value)) return previous;
  const inputTokens = numberValue(value.input_tokens);
  const outputTokens = numberValue(value.output_tokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : previous?.inputTokens !== undefined ? { inputTokens: previous.inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : previous?.outputTokens !== undefined ? { outputTokens: previous.outputTokens } : {}),
    ...(numberValue(value.cache_read_input_tokens) !== undefined ? { cacheReadTokens: value.cache_read_input_tokens } : {}),
    ...(numberValue(value.cache_creation_input_tokens) !== undefined ? { cacheCreationTokens: value.cache_creation_input_tokens } : {}),
  };
}

/** Translate Anthropic Messages SSE events into dsh-llm stream events. */
async function* translateAnthropicSse(events, emptyResponseCode = EMPTY_RESPONSE_CODE) {
  const blocks = new Map();
  const order = [];
  let nextIndex = 0;
  let usage;
  let stopReason;
  let sawMessageStop = false;
  let currentIndex;

  const openBlock = (index, kind, id, blockName) => {
    const block = {
      index: nextIndex++,
      upstreamIndex: index,
      kind,
      text: "",
      ...(id ? { callId: id } : {}),
      ...(blockName ? { name: blockName } : {}),
      closed: false,
    };
    blocks.set(index, block);
    order.push(block);
    return block;
  };

  const getBlock = (index, fallbackKind = "text") => {
    const key = Number.isInteger(index) ? index : currentIndex;
    let block = blocks.get(key);
    if (!block) {
      block = openBlock(key ?? order.length, fallbackKind);
    }
    return block;
  };

  for await (const record of events) {
    const raw = typeof record === "string" ? record : record?.data;
    if (!raw) continue;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new LlmError(`claude-code: malformed SSE payload: ${raw.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }
    if (!isRecord(event)) continue;
    const type = typeof event.type === "string" ? event.type : typeof record?.event === "string" ? record.event : "";
    if (type === "error") {
      throw new LlmError(`claude-code: upstream stream failed: ${safeErrorText(event.error, "upstream stream error")}`, "SERVER");
    }
    switch (type) {
      case "message_start":
        usage = usageFrom(event.message?.usage, usage);
        break;
      case "content_block_start": {
        currentIndex = numberValue(event.index) ?? order.length;
        const content = event.content_block;
        const kind = content?.type === "tool_use" ? "tool-call" : content?.type === "thinking" ? "reasoning" : "text";
        const block = openBlock(currentIndex, kind, content?.id, content?.name);
        yield { type: "block-start", index: block.index, blockType: kind };
        break;
      }
      case "content_block_delta": {
        currentIndex = numberValue(event.index) ?? currentIndex;
        const delta = event.delta;
        if (!isRecord(delta)) break;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          const block = getBlock(currentIndex, "text");
          if (block.kind !== "text") block.kind = "text";
          block.text += delta.text;
          yield { type: "text-delta", index: block.index, text: delta.text };
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          const block = getBlock(currentIndex, "reasoning");
          if (block.kind !== "reasoning") block.kind = "reasoning";
          block.text += delta.thinking;
          yield { type: "reasoning-delta", index: block.index, text: delta.thinking };
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const block = getBlock(currentIndex, "tool-call");
          if (block.kind !== "tool-call") block.kind = "tool-call";
          block.text += delta.partial_json;
          yield {
            type: "tool-call-delta",
            index: block.index,
            id: CallId(block.callId ?? ""),
            ...(block.name ? { name: block.name } : {}),
            argumentsDelta: delta.partial_json,
          };
        }
        break;
      }
      case "content_block_stop": {
        const block = blocks.get(numberValue(event.index) ?? currentIndex);
        if (block && !block.closed) {
          block.closed = true;
          yield { type: "block-end", index: block.index, block: closeBlock(block) };
        }
        break;
      }
      case "message_delta":
        usage = usageFrom(event.usage, usage);
        stopReason = event.delta?.stop_reason ?? stopReason;
        break;
      case "message_stop":
        sawMessageStop = true;
        for (const block of order) {
          if (block.closed) continue;
          block.closed = true;
          yield { type: "block-end", index: block.index, block: closeBlock(block) };
        }
        if (usage && Object.keys(usage).length > 0) yield { type: "usage", usage };
        if (order.length === 0) {
          yield {
            type: "finish",
            reason: emptyFinishReason(stopReason, emptyResponseCode),
          };
        } else {
          yield { type: "finish", reason: finishReason(stopReason, order.some((block) => block.kind === "tool-call")) };
        }
        return;
      default:
        break;
    }
  }

  for (const block of order) {
    if (block.closed) continue;
    block.closed = true;
    yield { type: "block-end", index: block.index, block: closeBlock(block) };
  }
  if (usage && Object.keys(usage).length > 0) yield { type: "usage", usage };
  if (order.length === 0) {
    yield {
      type: "finish",
      reason: emptyFinishReason(stopReason, emptyResponseCode),
    };
  } else {
    yield { type: "finish", reason: finishReason(stopReason, order.some((block) => block.kind === "tool-call")) };
  }
  if (!sawMessageStop && order.length > 0) return;
}

/**
 * Build the finish reason for an empty completion. When the upstream model
 * returns `stop_reason: refusal` with no content (Anthropic safety block),
 * surface a clear message instead of the generic "no content" text.
 */
function emptyFinishReason(stopReason, emptyResponseCode) {
  if (stopReason === "refusal") {
    return {
      kind: "error",
      failure: {
        message: "claude-code: Anthropic safety block - the model refused this request (the DSH system prompt content triggers Anthropic's content policy). Use a neutral persona or an API-key route.",
        code: "SAFETY_BLOCK",
      },
    };
  }
  return {
    kind: "error",
    failure: { message: "model returned a completed response with no content", code: emptyResponseCode },
  };
}

function parseRetryAfterMs(response) {
  const value = response?.headers?.get?.("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function httpErrorCode(status, text) {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 402) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) return isContextWindowExceededError(text) ? CONTEXT_WINDOW_EXCEEDED_CODE : "INVALID_REQUEST";
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

function requestErrorMessage(status, parsed, text, response) {
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(response);
    const upstream = parsed?.error?.message ?? safeErrorText(parsed, text);
    const generic = !upstream || /too many requests|^error$/i.test(upstream.trim());
    const reason = generic ? `Claude Code subscription rate limit reached` : upstream;
    return `${reason}${retryAfterMs === undefined ? "" : `; retry after ${Math.ceil(retryAfterMs / 1000)}s`}`;
  }
  return safeErrorText(parsed, text.trim().slice(0, 200) || `HTTP ${status}`);
}

function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    inputModalities: ["text"],
    reasoning: reasoningInfo(model.id),
    toolCalling: "supported",
  };
}

class ClaudeCodeAdapter extends LlmAdapter {
  constructor(config) {
    super();
    this.config = config;
    this.refreshPromises = new Map();
    this.accountCursor = 0;
    this.modelCache = { entries: undefined, fetchedAt: 0, fetching: null };
    this.antiBanEngine = new AntiBanEngine();
    this.currentFingerprint = undefined;
  }

  providerInfo(provider) {
    return { id: provider, name: "Claude Code" };
  }

  providerRetryPolicy() {
    return this.config.options().retryPolicy;
  }

  async effectiveModels() {
    const options = this.config.options();
    const fallback = filterExcludedModels(options.models, options.excludedModelIds);
    const now = Date.now();
    if (this.modelCache.entries && now - this.modelCache.fetchedAt < MODEL_CATALOG_CACHE_MS) return this.modelCache.entries;
    if (!this.modelCache.fetching) {
      this.modelCache.fetching = (async () => {
        try {
          const token = await this.ensureAccessToken();
          return (await fetchModelCatalog({
            baseURL: options.baseURL,
            accessToken: token,
            models: options.models,
            excludedModelIds: options.excludedModelIds,
            headers: buildAnthropicHeaders(token, options, { accept: "application/json" }),
          })) ?? fallback;
        } catch {
          return fallback;
        }
      })()
        .then((entries) => {
          this.modelCache.entries = entries;
          this.modelCache.fetchedAt = Date.now();
          return entries;
        })
        .finally(() => {
          this.modelCache.fetching = null;
        });
    }
    return this.modelCache.fetching;
  }

  invalidateModelCache() {
    this.modelCache.entries = undefined;
    this.modelCache.fetchedAt = 0;
  }

  async listModels(provider) {
    return (await this.effectiveModels()).map((model) => modelInfo(provider, model));
  }

  async resolveModel(provider, model) {
    const options = this.config.options();
    const entry = (await this.effectiveModels()).find((candidate) => candidate.id === model);
    return {
      ...(entry ? modelInfo(provider, entry) : { provider, id: model, name: model, inputModalities: ["text"] }),
      context: { contextWindow: entry?.contextWindow ?? options.defaultContextWindow },
      defaultMaxTokens: entry?.maxTokens ?? options.maxTokens,
    };
  }

  async resolveAccount() {
    const accounts = this.config.store?.accounts?.() ?? [];
    const account = accounts.length > 0 ? accounts[this.accountCursor % accounts.length] : undefined;
    if (!account) throw new LlmError("claude-code: not signed in; open Settings → Plugins → Claude Code and sign in or import an existing login", "AUTH");
    this.accountCursor = (this.accountCursor + 1) % accounts.length;
    return account;
  }

  async ensureAccessToken(signal, force = false, preferredAccount) {
    const account = preferredAccount ?? (await this.resolveAccount());
    if (!force && (!account.expiresAt || account.expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS)) return account.accessToken;
    if (!account.refreshToken) throw new LlmError("claude-code: the stored access token is expired and no refresh token is available", "AUTH");
    const tokenKey = account.accessToken;
    if (!this.refreshPromises) this.refreshPromises = new Map();
    if (!this.refreshPromises.has(tokenKey)) {
      this.refreshPromises.set(
        tokenKey,
        refreshToken(this.config.options(), account, signal)
          .then((next) => {
            this.config.store.save(next);
            return next.accessToken;
          })
          .finally(() => {
            this.refreshPromises.delete(tokenKey);
          }),
      );
    }
    return this.refreshPromises.get(tokenKey);
  }

  async request(entry, options, signal) {
    const accounts = this.config.store?.accounts?.() ?? [];
    if (accounts.length === 0) {
      const token = await this.ensureAccessToken(signal);
      return this.requestWithToken(entry, options, signal, token);
    }
    let lastResponse;
    let lastError;
    const attempted = new Set();
    for (let round = 0; round < accounts.length; round++) {
      const account = await this.resolveAccount();
      if (attempted.has(account.accessToken)) continue;
      attempted.add(account.accessToken);
      try {
        const token = await this.ensureAccessToken(signal, false, account);
        const response = await this.requestWithToken(entry, options, signal, token);
        lastResponse = response;
        if (response.ok) return response;
        const status = response.status;
        if (status === 401 || status === 403) {
          lastError = new LlmError(`claude-code: account rejected (HTTP ${status})`, "AUTH", { status });
          continue; // try the next account
        }
        // Not an auth failure: surface it directly (rate limit, server, etc.)
        return response;
      } catch (error) {
        lastError = error;
        if (error instanceof LlmError && (error.code === "AUTH" || error.code === "TRANSPORT")) continue;
        throw error;
      }
    }
    if (lastResponse && !lastResponse.ok) {
      const text = await readResponseText(lastResponse);
      let parsedError;
      try {
        parsedError = JSON.parse(text || "{}");
      } catch {
        parsedError = undefined;
      }
      const message = requestErrorMessage(lastResponse.status, parsedError, text, lastResponse);
      throw new LlmError(
        `claude-code: API error (HTTP ${lastResponse.status}): ${message}`,
        httpErrorCode(lastResponse.status, text),
        { status: lastResponse.status, ...(parseRetryAfterMs(lastResponse) !== undefined ? { providerRetryAfterMs: parseRetryAfterMs(lastResponse) } : {}) },
      );
    }
    throw lastError ?? new LlmError(`claude-code: all accounts failed (HTTP ${lastResponse?.status ?? 401})`, "AUTH", { status: lastResponse?.status ?? 401 });
  }

  /** Single-account request with one access token (anti-ban gating included). */
  async requestWithToken(entry, options, signal, token) {
    const antiBan = options.antiBan;
    let gate;
    if (antiBan?.enabled === true) {
      gate = await this.antiBanEngine.antiBanGate();
      if (!gate.proceed) {
        if (gate.waitMs > 0) await sleep(Math.min(gate.waitMs, 60_000));
        else throw new LlmError(`claude-code: anti-ban gate blocked request (${gate.reason})`, "THROTTLED");
      }
      this.currentFingerprint = this.antiBanEngine.currentFingerprint({
        clientVersion: antiBan.clientVersion ?? options.clientVersion,
      });
    }
    const requestOptions = {
      ...options,
      ...(antiBan?.enabled === true ? { fingerprint: this.currentFingerprint } : {}),
      ...(antiBan?.entrypoint ? { antiBan: { entrypoint: antiBan.entrypoint } } : {}),
    };
    const body = JSON.stringify(buildAnthropicPayload(options.request, entry));
    let response;
    try {
      response = await fetch(`${String(options.baseURL).replace(/\/+$/, "")}/v1/messages?beta=true`, {
        method: "POST",
        headers: buildAnthropicHeaders(token, requestOptions),
        body,
        signal,
      }).catch((error) => {
        if (signal?.aborted) throw error;
        throw new LlmError(`claude-code: API request to ${options.baseURL} failed`, "TRANSPORT", { cause: error });
      });
    } finally {
      if (gate) this.antiBanEngine.finish(gate);
    }
    if (response.ok) {
      if (gate) this.antiBanEngine.recordSuccess();
      return response;
    }
    if (gate) this.antiBanEngine.recordError(response.status);
    const text = await readResponseText(response);
    // Capture ground truth: dump every request body + status so a single
    // DSH message reveals exactly what reaches Anthropic.
    try {
      const dir = process.env.SERAPHIM_DEBUG_PATH ?? "seraphim-debug";
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "last-body.json"), body, "utf8");
      writeFileSync(join(dir, "last-response.json"), JSON.stringify({ status: response.status, body: text.slice(0, 2000) }), "utf8");
    } catch { /* debug write is best-effort */ }
    if (response.status === 429) {
      try {
        const dir = process.env.SERAPHIM_DEBUG_PATH ?? "seraphim-debug";
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `body-${Date.now()}.json`), body, "utf8");
        writeFileSync(join(dir, `response-${Date.now()}.txt`), text.slice(0, 2000), "utf8");
      } catch { /* debug write is best-effort */ }
    }
    return response;
  }

  async *stream(request) {
    const options = this.config.options();
    const models = await this.effectiveModels();
    const entry = models.find((model) => model.id === request.model);
    if (!entry) throw new LlmError(`claude-code: unknown model "${request.model}"`, "UNKNOWN_MODEL");
    const consumer = new AbortController();
    const signal = signalFor(request.signal, consumer.signal);
    let timedOut = false;
    let idleTimer;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        consumer.abort();
      }, options.streamIdleTimeoutMs);
      idleTimer.unref?.();
    };
    armIdle();
    try {
      const response = await this.request(entry, { ...options, request }, signal);
      const iterator = translateAnthropicSse(parseAnthropicSse(response.body), EMPTY_RESPONSE_CODE)[Symbol.asyncIterator]();
      while (true) {
        const result = await iterator.next();
        if (result.done) return;
        armIdle();
        yield result.value;
      }
    } catch (error) {
      if (timedOut) throw new LlmError(`claude-code: stream idle timeout after ${options.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
      if (request.signal?.aborted) throw new LlmError("claude-code: request aborted by caller", "ABORTED", { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(`claude-code: API stream from ${options.baseURL} failed`, "TRANSPORT", { cause: error });
    } finally {
      clearTimeout(idleTimer);
      consumer.abort();
    }
  }
}

function resolveModels(models) {
  const seen = new Set();
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (!model?.id || !model?.upstream) throw new Error(`claude-code: catalog model "${model?.id ?? ""}" needs id/upstream`);
    if (seen.has(model.id)) throw new Error(`claude-code: duplicate catalog model "${model.id}"`);
    seen.add(model.id);
    return {
      id: model.id,
      name: model.name ?? model.id,
      upstream: model.upstream,
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
  });
}

function resolveAdapterOptions(config = {}) {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error("claude-code: streamIdleTimeoutMs must be a positive finite number");
  }
  return {
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    oauthAuthorizeURL: config.oauthAuthorizeURL ?? DEFAULT_OAUTH_AUTHORIZE_URL,
    oauthTokenURL: config.oauthTokenURL ?? DEFAULT_OAUTH_TOKEN_URL,
    oauthSuccessURL: config.oauthSuccessURL ?? DEFAULT_OAUTH_SUCCESS_URL,
    oauthClientId: config.oauthClientId ?? DEFAULT_OAUTH_CLIENT_ID,
    claudeCredentialsPath: config.claudeCredentialsPath ?? DEFAULT_CLAUDE_CREDENTIALS_PATH,
    clientVersion: config.clientVersion ?? DEFAULT_CLIENT_VERSION,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    excludedModelIds: new Set(Array.isArray(config.excludedModelIds) ? config.excludedModelIds.filter((id) => typeof id === "string" && id.length > 0) : DEFAULT_EXCLUDED_MODEL_IDS),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, "claude-code: retryPolicy"),
    antiBan: resolveAntiBan(config.antiBan),
  };
}

function resolveAntiBan(config = {}) {
  const enabled = config.enabled === true;
  return {
    enabled,
    rotatePerRequest: config.rotatePerRequest === true,
    entrypoint: config.entrypoint ?? "sdk-cli",
    ...(config.clientVersion ? { clientVersion: String(config.clientVersion) } : {}),
    ...(enabled ? { quietHours: { start: config.quietHours?.start ?? 21, end: config.quietHours?.end ?? 4 } } : {}),
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
      ctx.logger?.error?.("claude-code: keeping the last good configuration after an invalid settings section");
      ctx.logger?.error?.(error);
      return lastGood;
    }
  };
  options();
  const store = new ClaudeCodeCredentialStore();
  const adapter = new ClaudeCodeAdapter({
    options,
    store,
    resolveAccount: () => store.account(),
  });  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: "Claude Code", settingsNs: NS, settingsPath: [] }]);
  ctx.inject(["webServer"], (webCtx) => registerClaudeCodeAuthRoutes(webCtx, store, options, ctx.logger, () => adapter.invalidateModelCache()));
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
  Config,
  ClaudeCodeAdapter,
  ClaudeCodeCredentialStore,
  DEFAULT_CLAUDE_CREDENTIALS_PATH,
  DEFAULT_MODELS,
  IMPORT_PATH,
  LOGIN_PATH,
  LOGOUT_PATH,
  NS,
  OAUTH_BETA,
  OAUTH_SCOPES,
  PROVIDER,
  STATUS_PATH,
  apply,
  buildAnthropicHeaders,
  buildAnthropicPayload,
  buildAuthorizeUrl,
  convertToAnthropicMessages,
  convertTools,
  createPkcePair,
  exchangeCode,
  fetchUsageSnapshot,
  httpErrorCode,
  inject,
  name,
  normalizeAccount,
  normalizedTokenResponse,
  reasoningInfo,
  refreshToken,
  registerClaudeCodeAuthRoutes,
  requestErrorMessage,
  resolveAdapterOptions,
  translateAnthropicSse,
  USAGE_PATH,
};
