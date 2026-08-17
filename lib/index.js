/**
 * Merged Seraphim plugin. The host row supplies a `providers` map; each
 * provider module owns its own routes, settings, adapters, and defaults.
 * Provider modules are exported as namespaces for tooling compatibility.
 */

import * as claudeCode from "./providers/claude-code.js";
import * as freebuff from "./providers/freebuff.js";
import * as commandcode from "./providers/commandcode.js";
import * as zed from "./providers/zed.js";
import * as codex from "./providers/codex.js";
import { installSettingsSection } from "@deepseek-ai/dsh-settings";
import { ProviderFlagsStore } from "./providers/provider-flags.js";
import { Config as SeraphimConfig, SERAPHIM_SETTINGS_NS } from "./providers/seraphim-config.js";

/** Cordis plugin name used by loader diagnostics. */
const name = "llm-seraphim";
/** Hard dependency: the LLM provider registry (each provider needs it). */
const inject = ["llm"];

/** Provider route to provider module. */
const PROVIDERS = {
  "claude-code": claudeCode,
  freebuff,
  commandcode,
  zed,
  codex,
};

/** Provider key → per-provider display label (used in diagnostics). */
const PROVIDER_LABELS = {
  "claude-code": "Claude Code",
  freebuff: "FreeBuff",
  commandcode: "Command Code",
  zed: "ZED",
  codex: "Codex",
};

/** Host-owned route the Seraphim card uses to read/write provider on/off flags. */
const PROVIDER_FLAGS_PATH = "/plugins/seraphim/providers";
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

/** Wire the per-provider on/off flags route (GET view, PUT { enabled: {key: bool} }). */
function registerProviderFlagsRoutes(ctx, flags) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "exact",
      path: PROVIDER_FLAGS_PATH,
      handler: async (req, res) => {
        if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
        if (req.method === "GET") {
          json(res, 200, { providers: flags.view(Object.keys(PROVIDERS)) });
          return;
        }
        if (req.method === "PUT") {
          const body = await readJsonBody(req);
          const enabledMap = body?.enabled;
          if (enabledMap === null || typeof enabledMap !== "object" || Array.isArray(enabledMap)) {
            return json(res, 400, { error: "enabled map is required" });
          }
          for (const [key, value] of Object.entries(enabledMap)) {
            if (!(key in PROVIDERS)) continue;
            flags.setEnabled(key, value === true);
          }
          json(res, 200, { providers: flags.view(Object.keys(PROVIDERS)) });
          return;
        }
        json(res, 405, { error: "method not allowed" });
      },
    });
    return () => dispose();
  }, "seraphim: provider flags route");
}

/** Apply each configured provider independently. */
function apply(ctx, config) {
  const providers = config?.providers ?? {};
  const flags = new ProviderFlagsStore();
  ctx.llm.registerConfigurableProviders([{
    provider: "seraphim",
    displayName: "Seraphim",
    settingsNs: SERAPHIM_SETTINGS_NS,
    settingsPath: [],
  }]);
  installSettingsSection(ctx, SERAPHIM_SETTINGS_NS, SeraphimConfig, {
    betterModelSelection: config?.betterModelSelection === true,
  }, {
    setSource: () => {},
    onChange: () => {},
  });
  for (const [key, module] of Object.entries(PROVIDERS)) {
    const slice = providers[key];
    if (slice === void 0 || slice === null || typeof slice !== "object") {
      ctx.logger?.warn?.(`seraphim: no config slice for "${key}" — skipping ${PROVIDER_LABELS[key] ?? key}`);
      continue;
    }
    try {
      module.apply(ctx, slice);
      ctx.logger?.debug?.(`seraphim: provider "${key}" applied`);
    } catch (error) {
      ctx.logger?.error?.(`seraphim: provider "${key}" failed to apply: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  ctx.inject(["webServer"], (webCtx) => registerProviderFlagsRoutes(webCtx, flags));
}

export {
  PROVIDERS,
  PROVIDER_LABELS,
  PROVIDER_FLAGS_PATH,
  ProviderFlagsStore,
  apply,
  inject,
  name,
  registerProviderFlagsRoutes,
  // re-export every provider module so imports stay compatible
  claudeCode,
  freebuff,
  commandcode,
  zed,
  codex,
};
