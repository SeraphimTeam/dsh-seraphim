import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

/** Seraphim-owned settings namespace for optional browser experiences. */
export const SERAPHIM_SETTINGS_NS = settingsNamespace("seraphim");

/**
 * Settings persisted by DSH under the Seraphim namespace.
 * Missing values resolve to the compatibility-safe native UI.
 */
export const Config = z.object({
  betterModelSelection: z.boolean().default(false),
});

export const DEFAULT_CONFIG = Object.freeze({
  betterModelSelection: false,
});
