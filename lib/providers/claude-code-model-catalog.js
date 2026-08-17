const MODEL_CATALOG_PATH = "/v1/models";
export const MODEL_CATALOG_PAGE_SIZE = 100;
export const MODEL_CATALOG_MAX_PAGES = 5;
export const MODEL_CATALOG_CACHE_MS = 5 * 60 * 1000;
export const DEFAULT_EXCLUDED_MODEL_IDS = ["claude-fable-5"];

const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 32768;

export const DEFAULT_MODELS = [
  { id: "anthropic/claude-opus-5", name: "Claude Opus 5", upstream: "claude-opus-5", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", upstream: "claude-sonnet-5", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8", upstream: "claude-opus-4-8", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7", upstream: "claude-opus-4-7", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", upstream: "claude-sonnet-4-6", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", upstream: "claude-opus-4-6", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "anthropic/claude-opus-4-5-20251101", name: "Claude Opus 4.5", upstream: "claude-opus-4-5-20251101", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", upstream: "claude-haiku-4-5-20251001", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "anthropic/claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", upstream: "claude-sonnet-4-5-20250929", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
];

function textValue(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function upstreamModelId(value) {
  const raw = typeof value === "string" ? value : value?.id ?? value?.model ?? value?.model_id;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return raw.startsWith("anthropic/") ? raw.slice("anthropic/".length) : raw;
}

export function modelEntryFromCatalog(value, configured = DEFAULT_MODELS, excludedModelIds = new Set(DEFAULT_EXCLUDED_MODEL_IDS)) {
  const upstream = upstreamModelId(value);
  if (!upstream || !/^claude-[A-Za-z0-9._-]+$/.test(upstream) || excludedModelIds.has(upstream)) return undefined;
  const configuredEntry = configured.find((entry) => entry.upstream === upstream || entry.id === `anthropic/${upstream}`);
  const displayName = typeof value === "object" && value !== null
    ? textValue(value.display_name) ?? textValue(value.displayName) ?? textValue(value.name)
    : undefined;
  const contextWindow = typeof value === "object" && value !== null
    ? numberValue(value.contextWindow ?? value.context_window ?? value.max_token_count)
    : undefined;
  const maxTokens = typeof value === "object" && value !== null
    ? numberValue(value.maxTokens ?? value.max_tokens ?? value.max_output_tokens)
    : undefined;
  return {
    id: `anthropic/${upstream}`,
    name: displayName ?? configuredEntry?.name ?? upstream,
    upstream,
    contextWindow: contextWindow ?? configuredEntry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: maxTokens ?? configuredEntry?.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

export function filterExcludedModels(models, excludedModelIds) {
  const excluded = excludedModelIds instanceof Set ? excludedModelIds : new Set(excludedModelIds ?? []);
  return models.filter((model) => !excluded.has(model.upstream));
}

export async function fetchModelCatalog({
  baseURL,
  accessToken,
  signal,
  models = DEFAULT_MODELS,
  excludedModelIds = new Set(DEFAULT_EXCLUDED_MODEL_IDS),
  headers,
  fetchImpl = globalThis.fetch,
}) {
  const records = [];
  let afterId;
  for (let page = 0; page < MODEL_CATALOG_MAX_PAGES; page++) {
    const url = new URL(`${String(baseURL).replace(/\/+$/, "")}${MODEL_CATALOG_PATH}`);
    url.searchParams.set("limit", String(MODEL_CATALOG_PAGE_SIZE));
    if (afterId) url.searchParams.set("after_id", afterId);
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: signal ?? AbortSignal.timeout(10000),
    });
    if (!response.ok) return undefined;
    let data;
    try {
      data = JSON.parse(await response.text());
    } catch {
      return undefined;
    }
    if (!Array.isArray(data?.data)) return undefined;
    records.push(...data.data);
    if (data.has_more !== true || typeof data.last_id !== "string" || data.last_id.length === 0) break;
    afterId = data.last_id;
  }
  const normalized = records.map((record) => modelEntryFromCatalog(record, models, excludedModelIds)).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}
