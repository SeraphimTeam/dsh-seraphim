/**
 * Per-provider enable/disable flags for the Seraphim plugin.
 *
 * One persisted document under the harness home so the settings card, the
 * host route, and every adapter agree on which providers are usable. A
 * provider missing from the document (or with no stored value) is ENABLED —
 * the default state, so existing installs behave exactly as before.
 *
 * The adapters consult this store at call time (listModels / resolveModel /
 * stream), so toggling takes effect immediately without a backend restart:
 * an empty model list drops the provider group from the picker, and stream
 * rejects with a clear `DISABLED` error.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

/** Flag document file name inside the harness home. */
const FLAGS_FILE = ".seraphim-provider-flags.json";
const FLAGS_VERSION = 1;

/** Default file location (overridable for tests). */
function flagsFile() {
  return join(resolveDshHome(), FLAGS_FILE);
}

/**
 * Persist per-provider enabled state.
 * Document shape: `{ version: 1, providers: { "<key>": boolean } }`.
 * A missing key reads as enabled (`true`).
 *
 * The host route and every provider adapter hold their OWN instance of this
 * store, so reads are re-validated against the file after `ttlMs` instead of
 * caching forever: a toggle written by the route becomes visible to the
 * adapters within the TTL (1s default) without sharing an instance.
 */
export class ProviderFlagsStore {
  constructor(file = flagsFile(), ttlMs = 1000) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.cache = undefined;
    this.readAt = 0;
  }

  read() {
    const now = Date.now();
    if (this.cache !== undefined && now - this.readAt < this.ttlMs) return this.cache;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      const providers = parsed?.providers;
      this.cache = providers !== null && typeof providers === "object" && !Array.isArray(providers) ? providers : {};
    } catch {
      this.cache = {};
    }
    this.readAt = Date.now();
    return this.cache;
  }

  /** Whether one provider is enabled (missing key = enabled). */
  enabled(key) {
    return this.read()[key] !== false;
  }

  /** Set one provider's enabled state; persists on success, keeps memory otherwise. */
  setEnabled(key, enabled) {
    const next = { ...this.read(), [key]: enabled === true };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify({ version: FLAGS_VERSION, providers: next }, null, 2)}\n`, "utf8");
    } catch {
      /* read-only home: keep in memory */
    }
    this.cache = next;
    this.readAt = Date.now();
    return this.enabled(key);
  }

  /** Public card/route view: every known key with its enabled state. */
  view(keys) {
    return keys.map((key) => ({ key, enabled: this.enabled(key) }));
  }
}
