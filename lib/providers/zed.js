import { createServer } from "node:net";
import { generateKeyPairSync, privateDecrypt, randomUUID, constants } from "node:crypto";
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

/**
 * ZED — a native DeepSeek Harness provider for the Zed.dev cloud LLM proxy.
 *
 * The protocol implemented here was reverse-engineered from the public
 * zed2api project (https://github.com/yukmakoto/zed2api, Zig) and the
 * zed-reverse-engineer documentation
 * (https://github.com/vibe-coding-labs/zed-reverse-engineer), both built on
 * the open-source Zed editor client
 * (https://github.com/zed-industries/zed). The upstream lifecycle is:
 *
 *   RSA browser sign-in → LLM bearer token → /completions JSONL stream
 *
 * 1. Sign-in: the plugin generates an RSA-2048 keypair, opens a localhost
 *    callback server, and points the browser at
 *    `zed.dev/native_app_signin?native_app_port=…&native_app_public_key=…`.
 *    After the GitHub OAuth round-trip, zed.dev encrypts the account access
 *    token with the public key (OAEP-SHA256, PKCS1v15 fallback) and redirects
 *    to `127.0.0.1:{port}/?user_id=…&access_token=…`; the plugin decrypts it.
 * 2. LLM token: `POST {baseURL}/client/llm_tokens` with
 *    `Authorization: {user_id} {access_token}` returns a JWT
 *    (`{"token": "…"}`); it is cached until `exp` − 60s and refreshed when
 *    the stream returns `x-zed-expired-token` / `x-zed-outdated-token`.
 * 3. Completions: `POST {baseURL}/completions` (Bearer JWT) with
 *    `{thread_id, prompt_id, intent, provider, model, provider_request}`.
 *    `provider_request` carries the raw upstream body (Anthropic Messages for
 *    `anthropic`, Responses for `open_ai`, generateContent for `google`,
 *    chat/completions for `x_ai`). The response is a JSON-Lines stream of
 *    `{"Status": …}` / `{"Event": …}` lines that we translate to dsh-llm
 *    events. The upstream forces streaming.
 * 4. Plan: `GET {baseURL}/client/users/me` exposes the account plan; Zed
 *    Free has no hosted LLM access (edit predictions only), so real usage
 *    needs Zed Pro or an active 14-day Pro trial.
 */

/** Cordis plugin name used by loader diagnostics. */
const name = "llm-zed";
/** Hard dependency: the LLM provider registry. */
const inject = ["llm"];

/** The provider route this plugin owns (appears in the model picker). */
const PROVIDER = "zed";
/** Settings namespace bound to this provider's config. */
const NS = settingsNamespace("llm-zed");

/** Plugin-owned HTTP routes used by the browser card. */
const STATUS_PATH = "/plugins/zed/auth/status";
const LOGIN_PATH = "/plugins/zed/auth/login";
const LOGOUT_PATH = "/plugins/zed/auth/logout";
const CREDENTIALS_PATH = "/plugins/zed/auth/credentials";
const ACCOUNTS_PATH = "/plugins/zed/auth/accounts";

/** Credential file inside the harness home (user_id + access_token per account). */
const CREDENTIAL_FILE = ".zed-credentials.json";

/** Upstream endpoints (overridable with a self-hosted relay / ZED_SERVER_URL). */
const DEFAULT_BASE_URL = "https://cloud.zed.dev";
const DEFAULT_SIGNIN_BASE_URL = "https://zed.dev";
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
const MAX_TIMER_DELAY_MS = 2147483647;

/** x-zed-system-id used by zed2api for token creation (proven accepted). */
const SYSTEM_ID = "6b87ab66-af2c-49c7-b986-ef4c27c9e1fb";
/** x-zed-version string used by zed2api (proven accepted by cloud.zed.dev). */
const DEFAULT_ZED_VERSION = "0.222.4+stable.147.b385025df963c9e8c3f74cc4dadb1c4b29b3c6f0";

/** Upstream interaction budgets. */
const TOKEN_FETCH_TIMEOUT_MS = 15000;
const PROBE_TIMEOUT_MS = 15000;
const CHAIN_GAP_MS = 300;
/** Fallback TTL when the JWT has no decodable `exp` claim. */
const LLM_TOKEN_TTL_MS = 55 * 60 * 1000;
/** Browser sign-in window (zed.dev's native app flow has no fixed deadline; 5 min is generous). */
const LOGIN_DEADLINE_MS = 5 * 60 * 1000;

/**
 * Fallback model catalog (used only when live discovery is unavailable, e.g.
 * offline / before the first authenticated fetch). `id` is the harness model
 * id (vendor-prefixed so the picker groups naturally); `upstream` is the raw
 * cloud.zed.dev model name; `contextWindow` mirrors the live max_token_count.
 *
 * The authoritative catalog is `GET {baseURL}/models` (Zed fetches it the
 * same way) — see `ZedAdapter.fetchLiveModels`. This table is a snapshot of
 * the live list (2026-08-16) so the picker still works before sign-in or
 * when the upstream is unreachable.
 */
const MODEL_TABLE = [
  { id: "anthropic/claude-sonnet-5", upstream: "claude-sonnet-5", contextWindow: 1000000 },
  { id: "anthropic/claude-sonnet-4-6", upstream: "claude-sonnet-4-6", contextWindow: 1000000 },
  { id: "anthropic/claude-sonnet-4-5", upstream: "claude-sonnet-4-5", contextWindow: 200000 },
  { id: "anthropic/claude-haiku-4-5", upstream: "claude-haiku-4-5", contextWindow: 200000 },
  { id: "openai/gpt-5.6-sol", upstream: "gpt-5.6-sol", contextWindow: 400000 },
  { id: "openai/gpt-5.6-terra", upstream: "gpt-5.6-terra", contextWindow: 400000 },
  { id: "openai/gpt-5.6-luna", upstream: "gpt-5.6-luna", contextWindow: 400000 },
  { id: "openai/gpt-5.5", upstream: "gpt-5.5", contextWindow: 400000 },
  { id: "openai/gpt-5.4", upstream: "gpt-5.4", contextWindow: 400000 },
  { id: "openai/gpt-5.3-codex", upstream: "gpt-5.3-codex", contextWindow: 400000 },
  { id: "openai/gpt-5.2", upstream: "gpt-5.2", contextWindow: 400000 },
  { id: "openai/gpt-5-mini", upstream: "gpt-5-mini", contextWindow: 400000 },
  { id: "openai/gpt-5-nano", upstream: "gpt-5-nano", contextWindow: 400000 },
  { id: "google/gemini-3.1-pro-preview", upstream: "gemini-3.1-pro-preview", contextWindow: 200000 },
  { id: "google/gemini-3.5-flash", upstream: "gemini-3.5-flash", contextWindow: 1048576 },
  { id: "google/gemini-3-flash", upstream: "gemini-3-flash", contextWindow: 1048576 },
];

const DEFAULT_MODELS = MODEL_TABLE.map((entry) => ({
  id: entry.id,
  name: entry.id,
  upstream: entry.upstream,
  contextWindow: entry.contextWindow,
}));

/**
 * Extended-thinking budgets for Anthropic models (mapped from the picker's
 * reasoning-effort ladder). Other providers get no reasoning metadata: their
 * wire formats do not carry a portable thinking knob in the zed2api mapping.
 */
const THINKING_BUDGETS = {
  low: 1024,
  medium: 4096,
  high: 8192,
  max: 16384,
};

const EFFORT_LABELS = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/**
 * dsh-llm reasoning metadata for a model. For live models we forward the
 * account's actual `supported_effort_levels` (mapped to the picker ladder);
 * for the static fallback we only advertise thinking for anthropic/* with a
 * default budget ladder.
 */
function reasoningInfoForLevels(modelId, effortLevels) {
  const efforts = Array.isArray(effortLevels) && effortLevels.length > 0
    ? effortLevels
        .map((level) => {
          const id = typeof level?.value === "string" ? level.value : undefined;
          if (!id) return undefined;
          const name = typeof level?.name === "string" ? level.name : EFFORT_LABELS[id] ?? id;
          return { id, name, ...(id === "high" ? { description: "Deep reasoning for complex work" } : {}) };
        })
        .filter(Boolean)
    : reasoningInfo(modelId)?.efforts;
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
  return { efforts };
}

/** dsh-llm reasoning metadata for an anthropic/* model id. */
function reasoningInfo(modelId) {
  if (!modelId.startsWith("anthropic/")) return undefined;
  return {
    efforts: Object.entries(THINKING_BUDGETS).map(([id, budget]) => ({
      id,
      name: EFFORT_LABELS[id] ?? id,
      description: `Extended thinking up to ${budget.toLocaleString("en-US")} tokens`,
    })),
    // No defaultEffort: omitting sends no `thinking` field and the upstream
    // applies its own default (matches the reference clients).
  };
}

/** Derive a fallback effort ladder for a provider/upstream id when the live list lacks one. */
function fallbackEffortLevels(modelId) {
  if (!modelId.startsWith("anthropic/")) return undefined;
  return ["low", "medium", "high", "max"].map((value) => ({
    name: EFFORT_LABELS[value],
    value,
    ...(value === "high" ? { is_default: true } : {}),
  }));
}

/** Map a live cloud model record to a harness catalog row. */
function liveModelToEntry(model) {
  const upstream = String(model?.id ?? "");
  const provider = String(model?.provider ?? "").toLowerCase();
  let prefix = "anthropic";
  if (provider === "open_ai" || provider === "openai") prefix = "openai";
  else if (provider === "google") prefix = "google";
  else if (provider === "x_ai" || provider === "xai") prefix = "xai";
  const id = `${prefix}/${upstream}`;
  const contextWindow =
    typeof model?.max_token_count === "number" && model.max_token_count > 0 ? model.max_token_count : DEFAULT_CONTEXT_WINDOW;
  return {
    id,
    name: typeof model?.display_name === "string" && model.display_name.length > 0 ? model.display_name : id,
    upstream,
    contextWindow,
    maxTokens: typeof model?.max_output_tokens === "number" && model.max_output_tokens > 0 ? model.max_output_tokens : DEFAULT_MAX_TOKENS,
    effortLevels: Array.isArray(model?.supported_effort_levels) && model.supported_effort_levels.length > 0
      ? model.supported_effort_levels
      : fallbackEffortLevels(id),
    isLatest: model?.is_latest === true,
    supportsTools: model?.supports_tools === true,
    supportsThinking: model?.supports_thinking === true,
  };
}

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  upstream: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
});

/** Runtime schema for the row's `config:` block. */
const Config = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  signInBaseURL: z.string().default(DEFAULT_SIGNIN_BASE_URL),
  /** x-zed-version header (a known-good stable build string). */
  zedVersion: z.string().default(DEFAULT_ZED_VERSION),
  /** Optional pre-provisioned LLM bearer token (JWT); skips /client/llm_tokens. */
  llmToken: z.string().role("secret"),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
});

/* ------------------------------------------------------------------ *
 * Pure helpers (exported for tests)
 * ------------------------------------------------------------------ */

/** Derive the cloud.zed.dev provider slug from a harness model id. */
function providerForModel(modelId) {
  if (modelId.startsWith("anthropic/")) return "anthropic";
  if (modelId.startsWith("openai/")) return "open_ai";
  if (modelId.startsWith("google/")) return "google";
  if (modelId.startsWith("xai/")) return "x_ai";
  return "anthropic";
}

/** base64url (no padding) — zed.dev expects this exact alphabet for the public key. */
function base64UrlEncode(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url decode with padding restored (for the encrypted access_token). */
function base64UrlDecode(text) {
  const pad = (4 - (text.length % 4)) % 4;
  return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad), "base64");
}

/** JWT expiry (seconds) from the payload segment; undefined when absent/unparsable. */
function parseJwtExp(jwt) {
  return parseJwtClaim(jwt, "exp")?.ms;
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

/** Read one claim from a JWT payload, unwrapping serde tags; `ms` converts epoch-seconds. */
function parseJwtClaim(jwt, key) {
  const claims = parseJwtClaims(jwt);
  const raw = claims?.[key];
  if (raw === undefined || raw === null) return undefined;
  if (key === "exp" && typeof raw === "number" && Number.isFinite(raw)) return { value: raw, ms: raw * 1000 };
  return { value: untag(raw), ms: undefined };
}

/** Unwrap the serde `{"0": value}` / `{"known": value}` encodings zed.dev uses. */
function untag(value) {
  if (value !== null && typeof value === "object") {
    if (typeof value["0"] !== "undefined") return value["0"];
    if (typeof value.known !== "undefined") return value.known;
  }
  return value;
}

/** Extract a displayable plan slug from a users/me payload (fallback path). */
function extractPlan(usersMe) {
  const plan = usersMe?.user?.plan;
  if (!plan || typeof plan !== "object") return undefined;
  const v3 = untag(plan.plan_v3);
  if (typeof v3 === "string" && v3.length > 0) return v3;
  if (typeof plan.plan === "string" && plan.plan.length > 0) return plan.plan;
  return undefined;
}

/** Whether a plan slug means the account has hosted-LLM access (not free). */
function planHasLlmAccess(plan) {
  if (typeof plan !== "string" || plan.length === 0) return undefined;
  if (plan === "zed_free") return false;
  if (/^zed_(pro|pro_trial|student|business)/.test(plan)) return true;
  if (/token_based_zed_student/.test(plan)) return true;
  return undefined;
}

const PLAN_LABELS = {
  zed_free: "free",
  zed_pro: "pro",
  zed_pro_trial: "pro trial",
  zed_student: "student",
  zed_business: "business",
};

/* ------------------------------------------------------------------ *
 * Credential store
 * ------------------------------------------------------------------ */

function credentialFile() {
  return join(resolveDshHome(), CREDENTIAL_FILE);
}

/** Persist the ZED account documents (user_id + access_token pairs) under the harness home. */
class ZedCredentialStore {
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
    if (typeof doc?.userId === "string" && typeof doc?.accessToken === "string" && doc.accessToken.length > 0) {
      list.push({ userId: doc.userId, accessToken: doc.accessToken, ...doc });
    }
    if (Array.isArray(doc?.accounts)) {
      for (const account of doc.accounts) {
        if (typeof account?.userId === "string" && account.userId.length > 0 && typeof account?.accessToken === "string" && account.accessToken.length > 0) {
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
      login: accounts[0]?.login,
      logins: accounts.map((account) => account.login).filter(Boolean),
    };
  }

  /** Append an account (dedup by userId+accessToken) instead of overwriting, so several accounts can rotate. */
  addAccount(userId, accessToken, meta = {}) {
    const accounts = this.accounts();
    const existing = accounts.find((account) => account.userId === userId && account.accessToken === accessToken);
    if (existing) Object.assign(existing, meta, { storedAt: Date.now() });
    else accounts.push({ userId, accessToken, ...meta, storedAt: Date.now() });
    this.write({ accounts });
  }

  /** Secret-free account metadata for the card (no accessToken). */
  listMeta() {
    return this.accounts().map((account, index) => ({
      index,
      userId: account.userId,
      login: typeof account.login === "string" && account.login.length > 0 ? account.login : `user-${account.userId}`,
      plan: typeof account.plan === "string" ? account.plan : undefined,
      trialStartedAt: typeof account.trialStartedAt === "string" ? account.trialStartedAt : undefined,
      storedAt: typeof account.storedAt === "number" ? account.storedAt : undefined,
    }));
  }

  removeAccount(selector) {
    const accounts = this.accounts();
    const next = accounts.filter((account, index) => {
      if (typeof selector === "number") return index !== selector;
      return account.login !== selector && account.userId !== selector;
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
 * Browser sign-in: RSA keypair + localhost callback server
 * ------------------------------------------------------------------ */

/**
 * One in-flight native-app authorization. The card polls STATUS_PATH while
 * this exists; the callback server tears itself down on success or deadline.
 */
const PENDING_LOGIN = { flow: null };

/**
 * Start the native-app sign-in flow: generate an RSA-2048 keypair, listen on
 * 127.0.0.1:{random port}, and return the zed.dev sign-in URL. The browser
 * completes GitHub OAuth, zed.dev encrypts the access token with the public
 * key and redirects to the local port; the callback decrypts and stores it.
 */
async function startZedLogin(options, store, logger) {
  if (PENDING_LOGIN.flow) return { ok: true, url: PENDING_LOGIN.flow.url };

  let keypair;
  let server;
  try {
    keypair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "pkcs1", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const publicKeyB64 = base64UrlEncode(keypair.publicKey);

    const flow = {
      url: `${options().signInBaseURL}/native_app_signin?native_app_port=${0}&native_app_public_key=${publicKeyB64}`,
      port: 0,
      privateKey: keypair.privateKey,
      deadline: Date.now() + LOGIN_DEADLINE_MS,
      cancelled: false,
      server: null,
      timer: null,
    };

    server = createServer((socket) => {
      handleCallback(socket, flow, store, options, logger);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = server.address()?.port ?? 0;
    if (port === 0) throw new Error("callback server failed to bind");
    flow.port = port;
    flow.url = `${options().signInBaseURL}/native_app_signin?native_app_port=${port}&native_app_public_key=${publicKeyB64}`;
    flow.server = server;

    PENDING_LOGIN.flow = flow;
    flow.timer = setTimeout(() => {
      const f = PENDING_LOGIN.flow;
      if (f === flow && !f.cancelled) {
        logger?.warn?.("zed: sign-in window expired");
        cancelZedLogin();
      }
    }, LOGIN_DEADLINE_MS);
    flow.timer.unref?.();

    return { ok: true, url: flow.url };
  } catch (error) {
    if (server) server.close();
    const message = error instanceof Error ? error.message : "sign-in failed";
    logger?.error?.(`zed: sign-in setup failed: ${message}`);
    return { ok: false, message: `ZED sign-in could not start (${message})` };
  }
}

/** Serve one callback connection: decrypt credentials, store, redirect. */
function handleCallback(socket, flow, store, options, logger) {
  let buf = Buffer.alloc(0);
  let handled = false;
  const finish = () => {
    try {
      socket.end();
      socket.destroy();
    } catch {
      /* ignore */
    }
  };
  socket.on("data", (chunk) => {
    if (handled) return;
    buf = Buffer.concat([buf, chunk]);
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0 && buf.length < 65536) return;
    handled = true;

    const header = buf.subarray(0, headerEnd < 0 ? buf.length : headerEnd).toString("utf8");
    const firstLine = header.split("\r\n")[0] ?? "";
    const parts = firstLine.split(" ");
    const path = parts[1] ?? "";
    const query = path.slice(path.indexOf("?") + 1);
    const params = new URLSearchParams(query);
    const userId = params.get("user_id");
    const encryptedToken = params.get("access_token");

    if (!userId || !encryptedToken) {
      socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      finish();
      return;
    }

    let accessToken;
    try {
      const ciphertext = base64UrlDecode(encryptedToken);
      try {
        accessToken = privateDecrypt(
          { key: flow.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
          ciphertext,
        ).toString("utf8");
      } catch {
        accessToken = privateDecrypt({ key: flow.privateKey, padding: constants.RSA_PKCS1_PADDING }, ciphertext).toString("utf8");
      }
    } catch (error) {
      logger?.error?.(`zed: access_token decrypt failed: ${error instanceof Error ? error.message : error}`);
      socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      finish();
      return;
    }

    store.addAccount(userId, accessToken);
    probeAndStorePlan(store, options, userId, accessToken).catch(() => {});

    const redirect = `HTTP/1.1 302 Found\r\nLocation: ${options().signInBaseURL}/native_app_signin_succeeded\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
    socket.end(redirect);
    finish();
    clearZedLogin();
  });
  socket.on("error", () => {
    if (!handled) {
      handled = true;
      finish();
    }
  });
}

function cancelZedLogin() {
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
 * Account probing (users/me → login + plan)
 * ------------------------------------------------------------------ */

/** Build the `Authorization: {user_id} {access_token}` header value for an account. */
function authHeaderValue(userId, accessToken) {
  // zed2api stores the credential as the JSON object zed.dev hands back and
  // sends the raw JSON string; the native client sends the decrypted string.
  // Support both: if the token parses as an object carrying access_token, use
  // the JSON form (proven by zed2api), otherwise the plain form.
  const trimmed = accessToken.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && typeof parsed.access_token === "string") {
        return `${userId} ${JSON.stringify(parsed)}`;
      }
    } catch {
      /* fall through to raw */
    }
  }
  return `${userId} ${trimmed}`;
}

/** 0-cost account probe: GET /client/users/me → {login, plan, orgId}. */
async function probeAccount(baseURL, userId, accessToken) {
  try {
    const resp = await fetch(`${baseURL}/client/users/me`, {
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: authHeaderValue(userId, accessToken),
        "x-zed-system-id": SYSTEM_ID,
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!resp.ok) return { status: resp.status };
    const data = await resp.json().catch(() => undefined);
    const plan = extractPlan(data);
    const orgId = untag(data?.default_organization_id) ?? untag(data?.organizations?.[0]?.id) ?? untag(data?.organizations?.[0]);
    return {
      status: 200,
      login: typeof data?.user?.github_login === "string" ? data.user.github_login : undefined,
      plan: typeof plan === "string" ? plan : undefined,
      orgId: typeof orgId === "string" ? orgId : undefined,
      trialStartedAt: typeof data?.user?.plan?.trial_started_at === "string" ? data.user.plan.trial_started_at : undefined,
    };
  } catch {
    return { status: -1 };
  }
}

/** Probe and persist an account's plan/login (never throws). */
async function probeAndStorePlan(store, options, userId, accessToken) {
  const info = await probeAccount(options().baseURL, userId, accessToken);
  const meta = {};
  if (info.login !== undefined) meta.login = info.login;
  if (info.plan !== undefined) meta.plan = info.plan;
  if (info.orgId !== undefined) meta.orgId = info.orgId;
  if (info.trialStartedAt !== undefined) meta.trialStartedAt = info.trialStartedAt;
  if (Object.keys(meta).length > 0) store.addAccount(userId, accessToken, meta);
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

function registerZedAuthRoutes(ctx, store, options) {
  ctx.effect(() => {
    const routes = [
      ctx.webServer.register({
        kind: "exact",
        path: STATUS_PATH,
        handler: async (req, res) => {
          if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          const st = store.status();
          json(res, 200, { ...st, pending: PENDING_LOGIN.flow !== null });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: LOGIN_PATH,
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          const result = await startZedLogin(options, store, ctx.logger);
          if (!result.ok) return json(res, 502, { error: result.message });
          json(res, 200, { url: result.url });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: CREDENTIALS_PATH,
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          const body = await readJsonBody(req);
          const rawToken = typeof body?.accessToken === "string" ? body.accessToken.trim() : "";
          let userId = "";
          if (typeof body?.userId === "string" || typeof body?.userId === "number") {
            userId = String(body.userId).trim();
          }
          if (userId.length === 0 && rawToken.startsWith("{")) {
            // Accept the zed2api accounts.json credential object pasted alone:
            // {"github_user_id":123,"github_user_login":"…","access_token":"…"}
            try {
              const parsed = JSON.parse(rawToken);
              if (parsed && typeof parsed === "object" && typeof parsed.access_token === "string") {
                const uid = parsed.github_user_id ?? parsed.user_id ?? parsed.userId;
                if (uid !== undefined) userId = String(uid).trim();
              }
            } catch {
              /* treat as plain token */
            }
          }
          if (userId.length === 0 || rawToken.length === 0) {
            return json(res, 400, { error: "userId and accessToken are required (or paste the full zed2api credential JSON)" });
          }
          store.addAccount(userId, rawToken);
          probeAndStorePlan(store, options, userId, rawToken).catch(() => {});
          json(res, 200, store.status());
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: ACCOUNTS_PATH,
        handler: async (req, res) => {
          if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
          if (req.method === "GET") {
            // Re-probe any account still missing a plan (e.g. added while offline).
            for (const account of store.accounts()) {
              if (account.plan === undefined && account.probeAt === undefined) {
                probeAndStorePlan(store, options, account.userId, account.accessToken).catch(() => {});
              }
            }
            json(res, 200, { accounts: store.listMeta() });
            return;
          }
          if (req.method === "DELETE") {
            const body = await readJsonBody(req);
            const selector = typeof body?.index === "number" ? body.index : typeof body?.login === "string" ? body.login : typeof body?.userId === "string" ? body.userId : undefined;
            if (selector === undefined) return json(res, 400, { error: "index, login, or userId is required" });
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
          cancelZedLogin();
          store.clear();
          json(res, 200, { ok: true });
        },
      }),
    ];
    return async () => {
      cancelZedLogin();
      for (const dispose of routes) dispose();
    };
  }, "zed: web auth routes");
}

/* ------------------------------------------------------------------ *
 * Message conversion (harness blocks → Anthropic Messages wire format)
 * ------------------------------------------------------------------ */

function flattenText(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function serializeAssistantAnthropic(message) {
  const blocks = [];
  const text = flattenText(message.content);
  if (text.length > 0) blocks.push({ type: "text", text });
  for (const block of message.content) {
    if (block.type !== "tool-call") continue;
    let input = {};
    if (typeof block.arguments === "string" && block.arguments.length > 0) {
      try {
        input = JSON.parse(block.arguments);
      } catch {
        input = {};
      }
    }
    blocks.push({ type: "tool_use", id: block.id, name: block.name, input });
  }
  return { role: "assistant", content: blocks };
}

function serializeUserAnthropic(message) {
  const blocks = [];
  const text = flattenText(message.content);
  if (text.length > 0) blocks.push({ type: "text", text });
  for (const block of message.content) {
    if (block.type !== "tool-result") continue;
    blocks.push({
      type: "tool_result",
      tool_use_id: block.toolCallId,
      content: flattenText(block.content) || "(no output)",
    });
  }
  return { role: "user", content: blocks };
}

/** Harness messages (OpenAI-ish content blocks) → Anthropic Messages array. */
function convertToAnthropicMessages(messages) {
  const wire = [];
  for (const message of messages) {
    if (message.role === "system") continue; // handled via options.system
    if (message.role === "assistant") wire.push(serializeAssistantAnthropic(message));
    else if (message.role === "user") wire.push(serializeUserAnthropic(message));
    else {
      const text = flattenText(message.content);
      if (text.length > 0) wire.push({ role: "user", content: [{ type: "text", text }] });
    }
  }
  return wire;
}

/** Harness tools → Anthropic tool definitions. */
function convertTools(tools) {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.parameters ?? { type: "object", properties: {} },
  }));
}

/* ------------------------------------------------------------------ *
 * provider_request builders (per cloud.zed.dev provider slug)
 * ------------------------------------------------------------------ */

function buildAnthropicProviderRequest(options, entry) {
  const request = {
    model: entry.upstream,
    max_tokens: options.maxTokens ?? 32768,
    stream: true,
    ...(options.system !== undefined ? { system: options.system } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  };
  const tools = convertTools(options.tools);
  if (tools.length > 0) {
    request.tools = tools;
    request.tool_choice = { type: "auto" };
  }
  if (options.reasoningEffort !== undefined && typeof THINKING_BUDGETS[options.reasoningEffort] === "number") {
    request.thinking = { type: "enabled", budget_tokens: THINKING_BUDGETS[options.reasoningEffort] };
  } else if (options.reasoningEffort !== undefined && entry.supportsThinking === true) {
    // Live models expose their own effort ladder; map the picked effort to a
    // thinking budget proportional to the model's max output.
    const budget = Math.max(1024, Math.min(Math.round((entry.maxTokens ?? 32768) * 0.15), 16384));
    request.thinking = { type: "enabled", budget_tokens: budget };
  }
  request.messages = convertToAnthropicMessages(options.messages);
  return request;
}

/** Flatten harness messages into OpenAI Responses-format input items (text only, per zed2api). */
function buildOpenAiProviderRequest(options, entry) {
  const input = [];
  if (options.system !== undefined) {
    input.push({ type: "message", role: "system", content: [{ type: "input_text", text: options.system }] });
  }
  for (const message of options.messages) {
    if (message.role === "system") continue;
    const text = flattenText(message.content);
    const role = message.role === "assistant" ? "assistant" : "user";
    const contentType = message.role === "assistant" ? "output_text" : "input_text";
    input.push({ type: "message", role, content: [{ type: contentType, text }] });
  }
  return {
    model: entry.upstream,
    stream: true,
    input,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  };
}

function buildGoogleProviderRequest(options, entry) {
  const request = {
    model: `models/${entry.upstream}`,
    generationConfig: { candidateCount: 1, stopSequences: [], temperature: 1.0 },
  };
  if (options.system !== undefined) {
    request.systemInstruction = { parts: [{ text: options.system }] };
  }
  request.contents = [];
  for (const message of options.messages) {
    if (message.role === "system") continue;
    const text = flattenText(message.content);
    const role = message.role === "assistant" ? "model" : "user";
    request.contents.push({ parts: [{ text }], role });
  }
  return request;
}

function buildXAiProviderRequest(options, entry) {
  return {
    model: entry.upstream,
    stream: true,
    temperature: options.temperature ?? 1.0,
    messages: [
      ...(options.system !== undefined ? [{ role: "system", content: options.system }] : []),
      ...options.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: flattenText(m.content) })),
    ],
  };
}

function buildProviderRequest(options, entry) {
  const provider = providerForModel(entry.id);
  switch (provider) {
    case "open_ai":
      return buildOpenAiProviderRequest(options, entry);
    case "google":
      return buildGoogleProviderRequest(options, entry);
    case "x_ai":
      return buildXAiProviderRequest(options, entry);
    default:
      return buildAnthropicProviderRequest(options, entry);
  }
}

/** Full /completions body for cloud.zed.dev. */
function buildZedPayload(options, entry) {
  return {
    thread_id: randomUUID(),
    prompt_id: randomUUID(),
    intent: "user_prompt",
    provider: providerForModel(entry.id),
    model: entry.upstream,
    provider_request: buildProviderRequest(options, entry),
  };
}

/* ------------------------------------------------------------------ *
 * JSONL stream translation → dsh-llm events
 * ------------------------------------------------------------------ */

/** Async line reader over a web stream (handles partial chunks). */
async function* readLines(stream) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.length > 0) yield line;
    }
  }
  buf += decoder.decode();
  if (buf.trim().length > 0) yield buf.trim();
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

function statusError(line) {
  // {"Status":{"Failed":{"message":…}}} carries the upstream failure reason.
  if (line && typeof line === "object" && line.Status && typeof line.Status === "object" && line.Status.Failed) {
    const failed = line.Status.Failed;
    return new LlmError(
      `zed: upstream stream failed: ${typeof failed === "string" ? failed : JSON.stringify(failed).slice(0, 200)}`,
      "SERVER",
    );
  }
  return undefined;
}

/**
 * Translate the cloud.zed.dev JSONL stream into dsh-llm stream events.
 * Each line is either a status envelope or the raw upstream provider event.
 */
async function* translate(lines, emptyResponseCode = EMPTY_RESPONSE_CODE) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = new Map();
  const order = [];
  let pendingUsage;

  function open(kind, id, name) {
    const block = { index: nextIndex++, kind, text: "", ...(id !== undefined ? { callId: id } : {}), ...(name !== undefined ? { name } : {}) };
    order.push(block);
    return block;
  }

  for await (const line of lines) {
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch {
      continue; // tolerate non-JSON lines (e.g. keep-alive bytes)
    }
    if (!envelope || typeof envelope !== "object") continue;

    const failed = statusError(envelope);
    if (failed) throw failed;
    if (typeof envelope.Status !== "undefined") continue; // Queued/Started/StreamEnded — no content

    const event = (envelope.Event ?? envelope.event ?? envelope);
    if (typeof event !== "object" || event === null) continue;
    const type = typeof event.type === "string" ? event.type : "";

    switch (type) {
      case "message_start": {
        const usage = event.message?.usage;
        if (usage && typeof usage === "object") {
          pendingUsage = {
            inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
            outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
            ...(typeof usage.cache_read_input_tokens === "number" ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
          };
        }
        continue;
      }
      case "content_block_start": {
        const cb = event.content_block;
        if (!cb || typeof cb !== "object") continue;
        if (cb.type === "tool_use") {
          const block = open("tool-call", typeof cb.id === "string" ? cb.id : "", typeof cb.name === "string" ? cb.name : "");
          toolBlocks.set(block.index, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        } else if (cb.type === "thinking") {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        } else {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        continue;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (!delta || typeof delta !== "object") continue;
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
          if (!textBlock) {
            textBlock = open("text");
            yield { type: "block-start", index: textBlock.index, blockType: "text" };
          }
          textBlock.text += delta.text;
          yield { type: "text-delta", index: textBlock.index, text: delta.text };
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
          if (!reasoningBlock) {
            reasoningBlock = open("reasoning");
            yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
          }
          reasoningBlock.text += delta.thinking;
          yield { type: "reasoning-delta", index: reasoningBlock.index, text: delta.thinking };
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const block = [...toolBlocks.values()].pop();
          if (block) {
            block.text += delta.partial_json;
            yield {
              type: "tool-call-delta",
              index: block.index,
              id: CallId(block.callId ?? ""),
              ...(block.name !== undefined ? { name: block.name } : {}),
              argumentsDelta: delta.partial_json,
            };
          }
        }
        continue;
      }
      case "content_block_stop": {
        for (const block of order) {
          if (block.closed) continue;
          block.closed = true;
          yield { type: "block-end", index: block.index, block: closeBlock(block) };
        }
        continue;
      }
      case "message_delta": {
        const usage = event.usage;
        if (usage && typeof usage === "object") {
          pendingUsage = {
            inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : pendingUsage?.inputTokens,
            outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : pendingUsage?.outputTokens,
          };
        }
        continue;
      }
      case "message_stop": {
        for (const block of order) {
          if (block.closed) continue;
          block.closed = true;
          yield { type: "block-end", index: block.index, block: closeBlock(block) };
        }
        if (pendingUsage) yield { type: "usage", usage: pendingUsage };
        yield { type: "finish", reason: toolBlocks.size > 0 ? { kind: "tool-calls" } : { kind: "stop" } };
        return;
      }
      case "response.output_text.delta": {
        if (typeof event.delta === "string" && event.delta.length > 0) {
          if (!textBlock) {
            textBlock = open("text");
            yield { type: "block-start", index: textBlock.index, blockType: "text" };
          }
          textBlock.text += event.delta;
          yield { type: "text-delta", index: textBlock.index, text: event.delta };
        }
        continue;
      }
      default:
        break;
    }

    // OpenAI chat-completions chunk (x_ai path).
    const choice = event.choices?.[0];
    const deltaContent = choice?.delta?.content;
    if (typeof deltaContent === "string" && deltaContent.length > 0) {
      if (!textBlock) {
        textBlock = open("text");
        yield { type: "block-start", index: textBlock.index, blockType: "text" };
      }
      textBlock.text += deltaContent;
      yield { type: "text-delta", index: textBlock.index, text: deltaContent };
      continue;
    }

    // Google generateContent chunk.
    const parts = event.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part.text === "string" && part.text.length > 0) {
          if (!textBlock) {
            textBlock = open("text");
            yield { type: "block-start", index: textBlock.index, blockType: "text" };
          }
          textBlock.text += part.text;
          yield { type: "text-delta", index: textBlock.index, text: part.text };
        }
      }
    }
  }

  // Stream ended without message_stop (upstream truncation).
  for (const block of order) {
    if (block.closed) continue;
    yield { type: "block-end", index: block.index, block: closeBlock(block) };
  }
  if (pendingUsage) yield { type: "usage", usage: pendingUsage };
  if (order.length === 0) {
    yield { type: "finish", reason: { kind: "error", failure: { message: "model returned a completed response with no content", code: emptyResponseCode } } };
  } else {
    yield { type: "finish", reason: toolBlocks.size > 0 ? { kind: "tool-calls" } : { kind: "stop" } };
  }
}

/* ------------------------------------------------------------------ *
 * Upstream error mapping
 * ------------------------------------------------------------------ */

function upstreamError(text) {
  try {
    const parsed = JSON.parse(text);
    const code = parsed?.error?.code ?? parsed?.code ?? parsed?.error;
    return { code: typeof code === "string" ? code : undefined, message: typeof parsed?.error?.message === "string" ? parsed.error.message : typeof parsed?.message === "string" ? parsed.message : undefined };
  } catch {
    return { code: undefined, message: undefined };
  }
}

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

function httpErrorCode(status, text) {
  const { code } = upstreamError(text);
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

/** A 402 on cloud.zed.dev means the account has no paid LLM access at all. */
function paymentMessage(text) {
  const { code, message } = upstreamError(text);
  return `zed: account has no hosted LLM access (HTTP 402${message ? `: ${message}` : ""}${code ? ` [${code}]` : ""}) — it needs Zed Pro or an active 14-day Pro trial; free plans only include edit predictions`;
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
    ...(model.effortLevels !== undefined
      ? { reasoning: reasoningInfoForLevels(model.id, model.effortLevels) }
      : reasoningInfo(model.id) === undefined
        ? {}
        : { reasoning: reasoningInfo(model.id) }),
    ...(model.supportsTools === undefined ? {} : { toolCalling: model.supportsTools ? "supported" : "none" }),
  };
}

class ZedAdapter extends LlmAdapter {
  constructor(config) {
    super();
    this.config = config;
    /** `${userId}` → { token, expiresAt } LLM JWT cache. */
    this.tokenCache = new Map();
    /** Serialized upstream control-plane calls (token fetch): one client at a time. */
    this.chainTail = Promise.resolve();
    /** `${userId}` → cooldown-until timestamp (ms), for multi-account rotation. */
    this.cooldowns = new Map();
    /** `${userId}` values whose credentials the upstream rejected (invalid token). */
    this.invalidUsers = new Set();
    /** Live catalog cache (merged over the configured/fallback list). */
    this.liveModels = { entries: undefined, fetchedAt: 0, fetching: null };
  }

  providerInfo(provider) {
    return { id: provider, name: "ZED" };
  }

  providerRetryPolicy(_provider) {
    return this.config.options().retryPolicy;
  }

  /** Merged catalog: configured/fallback rows overridden by the live /models list. */
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
   * Fetch the account's real model catalog from `GET {baseURL}/models` (the
   * same endpoint the Zed client uses), cached for 10 minutes. Uses the first
   * available account; a failure falls back to the configured list.
   */
  getLiveModels() {
    const now = Date.now();
    if (this.liveModels.entries && now - this.liveModels.fetchedAt < 10 * 60 * 1000) {
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
            const token = await this.ensureLlmToken(account, undefined);
            const resp = await fetch(`${this.config.options().baseURL}/models`, {
              headers: {
                accept: "application/json",
                authorization: `Bearer ${token}`,
                "x-zed-version": this.config.options().zedVersion ?? DEFAULT_ZED_VERSION,
                "x-zed-client-supports-x-ai": "true",
                "x-zed-system-id": SYSTEM_ID,
              },
              signal: AbortSignal.timeout(15000),
            });
            if (!resp.ok) {
              lastError = new LlmError(`zed: models request failed (HTTP ${resp.status})`, httpErrorCode(resp.status, await resp.text().catch(() => "")));
              continue;
            }
            const data = await resp.json().catch(() => undefined);
            const rawModels = Array.isArray(data?.models) ? data.models : [];
            const entries = rawModels
              .map((model) => liveModelToEntry(model))
              .filter((entry) => typeof entry.upstream === "string" && entry.upstream.length > 0)
              .sort((a, b) => {
                if (!!a.isLatest !== !!b.isLatest) return a.isLatest ? -1 : 1;
                return String(a.name).localeCompare(String(b.name));
              });
            this.liveModels.entries = entries;
            this.liveModels.fetchedAt = Date.now();
            return entries;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError ?? new LlmError("zed: no accounts to fetch models", "AUTH");
      } catch (error) {
        this.config.optionsLogger?.warn?.(`zed: live model discovery failed (${error instanceof Error ? error.message : error}); using fallback catalog`);
        return undefined;
      } finally {
        this.liveModels.fetching = null;
      }
    })();
    return this.liveModels.fetching;
  }

  listModels(provider) {
    return this.effectiveModels().then((models) => models.map((model) => modelInfo(provider, model)));
  }

  resolveModel(provider, model, _signal) {
    return this.effectiveModels().then((models) => {
      const configured = models.find((entry) => entry.id === model);
      return {
        ...(configured === undefined
          ? { provider, id: model, name: model, inputModalities: ["text"], ...(reasoningInfo(model) === undefined ? {} : { reasoning: reasoningInfo(model) }) }
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

  cooldownUntil(userId) {
    return this.cooldowns.get(userId) ?? 0;
  }

  cooldown(userId, ms) {
    if (ms > 0) this.cooldowns.set(userId, Date.now() + ms);
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

  /** The cached LLM bearer JWT for an account, fetching it when missing/stale. */
  async ensureLlmToken(account, signal) {
    const key = account.userId;
    const cached = this.tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
    this.tokenCache.delete(key);
    return this.queue(async () => {
      const recheck = this.tokenCache.get(key);
      if (recheck && recheck.expiresAt > Date.now() + 60000) return recheck.token;
      const token = await this.fetchLlmToken(account, signal);
      const exp = parseJwtExp(token);
      this.tokenCache.set(key, { token, expiresAt: exp ?? Date.now() + LLM_TOKEN_TTL_MS });
      return token;
    });
  }

  async fetchLlmToken(account, signal) {
    const headers = {
      accept: "application/json",
      "content-type": "application/json",
      authorization: authHeaderValue(account.userId, account.accessToken),
      "x-zed-system-id": SYSTEM_ID,
    };
    // zed2api sends an empty body; the official client sends the organization
    // id. Try the empty form first, then fall back to the probed org id.
    const bodies = [{}, ...(typeof account.orgId === "string" && account.orgId.length > 0 ? [{ organization_id: account.orgId }] : [])];
    let lastStatus = 0;
    let lastText = "";
    for (const body of bodies) {
      let resp;
      try {
        resp = await fetch(`${this.config.options().baseURL}/client/llm_tokens`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS)].filter(Boolean)),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new LlmError(`zed: llm_tokens request failed`, "TRANSPORT", { cause: error });
      }
      const text = await resp.text();
      lastStatus = resp.status;
      lastText = text;
      if (!resp.ok) continue;
      try {
        const data = JSON.parse(text);
        const token = typeof data?.token === "string" ? data.token : untag(data?.token);
        if (typeof token === "string" && token.length > 0) {
          // The JWT carries the plan claim (verified live: token_based_zed_student).
          // Persist it so the card shows the right plan without users/me.
          const plan = parseJwtClaim(token, "plan")?.value;
          const username = parseJwtClaim(token, "username")?.value ?? parseJwtClaim(token, "github_user_login")?.value;
          if (typeof plan === "string" && plan.length > 0 && this.config.storePlan) {
            try {
              await this.config.storePlan(account.userId, { plan, ...(typeof username === "string" && username.length > 0 ? { login: username } : {}) });
            } catch {
              /* best effort */
            }
          }
          return token;
        }
      } catch {
        /* fall through */
      }
      lastStatus = -1;
      lastText = text.slice(0, 200);
    }
    const mapped = httpErrorCode(lastStatus || 502, lastText);
    throw new LlmError(`zed: failed to create LLM token (HTTP ${lastStatus || "?"}${lastText ? `: ${lastText.slice(0, 160)}` : ""})`, mapped, { status: lastStatus });
  }

  invalidateToken(userId) {
    this.tokenCache.delete(userId);
  }

  async streamRequest(account, entry, payload, connection, options, signal) {
    const headers = {
      authorization: undefined, // set per attempt
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-zed-version": connection.zedVersion ?? DEFAULT_ZED_VERSION,
      "x-zed-client-supports-status-messages": "true",
      "x-zed-client-supports-stream-ended-request-completion-status": "true",
      "x-zed-system-id": SYSTEM_ID,
      ...attributionHeaders(),
      ...(options.sessionId !== undefined ? { "x-harness-session-id": String(options.sessionId) } : {}),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.ensureLlmToken(account, signal);
      headers.authorization = `Bearer ${token}`;
      let response;
      try {
        response = await fetch(`${connection.baseURL}/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new LlmError(`zed: API request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
      }
      if (response.ok) {
        // The server flags a stale token before the body; refresh once and retry.
        if (attempt === 0 && (response.headers.get("x-zed-expired-token") !== null || response.headers.get("x-zed-outdated-token") !== null)) {
          this.invalidateToken(account.userId);
          try {
            await response.body?.cancel();
          } catch {
            /* ignore */
          }
          continue;
        }
        return response;
      }
      const errText = await response.text();
      const status = response.status;
      if (status === 401 || status === 403) {
        // Could be a stale bearer token or invalid account credentials.
        if (attempt === 0) {
          this.invalidateToken(account.userId);
          continue;
        }
        this.invalidUsers.add(account.userId);
        throw new LlmError(`zed: account "${account.userId}" was rejected (HTTP ${status}) — its access token is invalid or revoked; remove it and sign in again`, "AUTH", { status, accountRetryable: true });
      }
      if (status === 402) throw new LlmError(paymentMessage(errText), QUOTA_EXCEEDED_CODE, { status });
      const retryAfterMs = parseRetryAfterMs(errText, status);
      throw new LlmError(
        `zed: API error (HTTP ${status})${errText ? `: ${errText.slice(0, 200)}` : ""}`,
        httpErrorCode(status, errText),
        { status, ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }) },
      );
    }
    throw new LlmError("zed: completion request failed after token refresh", "AUTH");
  }

  async *stream(options) {
    const connection = this.config.options();
    const models = await this.effectiveModels();
    const entry = models.find((m) => m.id === options.model);
    if (!entry) throw new LlmError(`zed: unknown model "${options.model}"`, "UNKNOWN_MODEL");
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
        if (this.invalidUsers.has(account.userId)) continue;
        if (this.cooldownUntil(account.userId) > Date.now()) {
          lastError = new LlmError("zed: an account is cooling down (rate-limited); wait for the cooldown, or add another account", "RATE_LIMIT");
          continue;
        }
        let response;
        try {
          const payload = buildZedPayload(options, entry);
          response = await this.streamRequest(account, entry, payload, connection, options, signal);
        } catch (error) {
          if (timedOut) throw error;
          if (options.signal?.aborted) throw error;
          lastError = error;
          if (this.retryableAccountError(error)) {
            this.cooldown(account.userId, this.accountCooldownMs(error));
            continue;
          }
          throw error;
        }
        const iterator = translate(readLines(response.body), EMPTY_RESPONSE_CODE)[Symbol.asyncIterator]();
        while (true) {
          const result = await iterator.next();
          if (result.done) return;
          armIdle();
          yield result.value;
        }
      }
      throw lastError ?? new LlmError("zed: all accounts failed", "SERVER");
    } catch (error) {
      if (timedOut) throw new LlmError(`zed: stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
      if (options.signal?.aborted) throw new LlmError("zed: request aborted by caller", "ABORTED", { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(`zed: API stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
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
    if (!model.id || !model.upstream) {
      throw new Error(`zed: catalog model "${model.id}" needs id/upstream`);
    }
    if (seen.has(model.id)) throw new Error(`zed: duplicate catalog model "${model.id}"`);
    seen.add(model.id);
    return {
      id: model.id,
      name: model.name ?? model.id,
      upstream: model.upstream,
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(model.effortLevels !== undefined ? { effortLevels: model.effortLevels } : {}),
      ...(model.isLatest !== undefined ? { isLatest: model.isLatest } : {}),
      ...(model.supportsTools !== undefined ? { supportsTools: model.supportsTools } : {}),
      ...(model.supportsThinking !== undefined ? { supportsThinking: model.supportsThinking } : {}),
    };
  });
}

function resolveAdapterOptions(config) {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error("zed: streamIdleTimeoutMs must be a positive finite number");
  }
  return {
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    signInBaseURL: config.signInBaseURL ?? DEFAULT_SIGNIN_BASE_URL,
    zedVersion: config.zedVersion ?? DEFAULT_ZED_VERSION,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, "zed: retryPolicy"),
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
      ctx.logger?.error?.("zed: keeping the last good configuration after an invalid settings section");
      ctx.logger?.error?.(error);
      return lastGood;
    }
  };
  options();

  const store = new ZedCredentialStore();

  // Proactively probe every stored account at boot (fire-and-forget) so the
  // card shows the right plan/login on first open.
  for (const account of store.accounts()) {
    if (account.plan === undefined) probeAndStorePlan(store, options, account.userId, account.accessToken).catch(() => {});
  }

  const resolveAccounts = async () => {
    const accounts = store.accounts();
    if (accounts.length === 0) {
      throw new LlmError(
        "zed: not signed in; open Settings → Plugins → ZED and sign in with GitHub (or paste your user_id + access_token)",
        "AUTH",
      );
    }
    return accounts;
  };

  const storePlan = async (userId, meta) => {
    const account = store.accounts().find((a) => a.userId === userId);
    if (!account) return;
    if (meta.plan !== undefined) store.addAccount(userId, account.accessToken, { ...meta });
  };

  const adapter = new ZedAdapter({ options, resolveAccounts, storePlan });
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: "ZED", settingsNs: NS, settingsPath: [] }]);

  // Fire a boot-time live-catalog + plan probe so the picker is correct on
  // first open (never throws; falls back to the configured list).
  adapter.getLiveModels().catch(() => {});

  ctx.inject(["webServer"], (webCtx) => registerZedAuthRoutes(webCtx, store, options));

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {},
  });
}

export {
  Config,
  PROVIDER,
  SYSTEM_ID,
  ZedAdapter,
  ZedCredentialStore,
  apply,
  authHeaderValue,
  base64UrlDecode,
  base64UrlEncode,
  buildProviderRequest,
  buildZedPayload,
  convertToAnthropicMessages,
  extractPlan,
  fallbackEffortLevels,
  httpErrorCode,
  inject,
  liveModelToEntry,
  name,
  parseJwtClaim,
  parseJwtClaims,
  parseJwtExp,
  planHasLlmAccess,
  providerForModel,
  reasoningInfo,
  reasoningInfoForLevels,
  translate,
  untag,
};
