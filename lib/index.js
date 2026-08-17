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

/** The host passes raw config so each provider can validate its own slice. */

/** Provider key → per-provider display label (used in diagnostics). */
const PROVIDER_LABELS = {
  "claude-code": "Claude Code",
  freebuff: "FreeBuff",
  commandcode: "Command Code",
  zed: "ZED",
  codex: "Codex",
};

/** Apply each configured provider independently. */
function apply(ctx, config) {
  const providers = config?.providers ?? {};
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
}

export {
  PROVIDERS,
  PROVIDER_LABELS,
  apply,
  inject,
  name,
  // re-export every provider module so imports stay compatible
  claudeCode,
  freebuff,
  commandcode,
  zed,
  codex,
};
