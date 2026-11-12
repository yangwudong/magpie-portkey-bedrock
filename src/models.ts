// The model list: the catalog, plus what the account's gateway reports.
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { accountFormOf, BASE_URL_ENV, BASE_URL_HEADER, PROVIDER_ENV, resolveTemplateHeaders } from "./account.ts";
import type { ModelConfig, PortkeyConfig } from "./config.ts";

// The minimal shape of pi's RefreshModelsContext this extension uses. Kept
// structural so it stays assignable to the real contract.
export interface GatewayModelContext {
  credential?: { type: string; key?: string; env?: Record<string, string> };
  baseUrl?: string;
  allowNetwork: boolean;
  signal: AbortSignal;
}

// Model-level headers must never carry `$VAR` templates: pi resolves them
// in getAuth() without the account's credential env in scope and throws on
// the missing variable. Templates stay at the provider level only, where
// the OAuth adapter resolves them against credential.env per request.
function modelHeaders(headers: Record<string, string>): Record<string, string> | undefined {
  const plain = Object.fromEntries(Object.entries(headers).filter(([, value]) => !value.includes("$")));
  return Object.keys(plain).length > 0 ? plain : undefined;
}

// Fields an entry leaves out take the same per-family defaults a discovered
// id gets, so a bare id means the same thing in a config file as on /models.
export function toProviderModels(models: ModelConfig[], headers: Record<string, string>): ProviderModelConfig[] {
  return models.map((model) => {
    const defaults = discoveredModelDefaults(model.id);
    return {
      id: model.id,
      name: model.name || model.id,
      reasoning: model.reasoning ?? defaults.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      input: model.input ?? defaults.input,
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cacheRead: model.cost?.cacheRead ?? 0,
        cacheWrite: model.cost?.cacheWrite ?? 0,
      },
      contextWindow: model.contextWindow ?? defaults.contextWindow,
      maxTokens: model.maxTokens ?? defaults.maxTokens,
      headers: modelHeaders(headers),
    };
  });
}

// The chat variant of the exported union; the package keeps the union member unexported.
type ChatModelConfig = Extract<ProviderModelConfig, { reasoning: unknown }>;

// The gateway's /models endpoint reports no metadata, so ids beyond the catalog
// get conservative per-family defaults derived from Bedrock's own ID scheme.
// Anthropic ids (and Nova Pro/Premier) ship 1M contexts and cache pricing;
// everything else gets the generic floor. Zero cost keeps accounting honest
// rather than inventing per-model prices.
function discoveredModelDefaults(id: string): Pick<ChatModelConfig, "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens"> {
  if (/anthropic\./.test(id) || /nova-(premier|pro)-v/.test(id)) {
    return {
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    };
  }
  return {
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
}

// Lists what the gateway actually serves (OpenAI-style GET /models) and merges
// it with the catalog: catalog entries keep their metadata, unknown ids are
// added with conservative defaults. Throws so magpie logs the reason and keeps
// the registered catalog.
export async function discoverGatewayModels(
  config: PortkeyConfig,
  context: GatewayModelContext,
  send: typeof fetch = globalThis.fetch,
): Promise<ProviderModelConfig[]> {
  const catalog = () => toProviderModels(config.models, config.headers);
  if (!context.allowNetwork || context.signal.aborted) return catalog();
  const account = accountFormOf(context.credential);
  if (!account) throw new Error("portkey-bedrock: the signed-in account carries no gateway to list models from");

  // The account's own gateway, route and key.
  const base = account.baseUrl.replace(/\/+$/, "");
  const headers = resolveTemplateHeaders(config.headers, {
    [BASE_URL_ENV]: account.baseUrl,
    [PROVIDER_ENV]: account.provider,
  });
  delete headers[BASE_URL_HEADER];
  const res = await send(`${base}/models`, {
    headers: { ...headers, authorization: `Bearer ${account.apiKey}`, "x-portkey-api-key": account.apiKey },
    signal: context.signal,
  });
  if (!res.ok) {
    // Gateways that don't expose a model list are fine: keep the catalog quietly.
    if (res.status === 403 || res.status === 404) return catalog();
    throw new Error(`portkey-bedrock: GET ${base}/models answered ${res.status}`);
  }

  const body = await res.json();
  const entries = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  if (!entries.length) throw new Error(`portkey-bedrock: GET ${base}/models returned no models`);

  const merged = catalog();
  const known = new Set(merged.map((model) => model.id));
  for (const entry of entries) {
    const id = typeof entry === "string" ? entry : entry?.id;
    if (!id || known.has(id)) continue;
    known.add(id);
    merged.push({
      id,
      name: (typeof entry === "object" && entry.name) || id,
      ...discoveredModelDefaults(id),
      headers: modelHeaders(config.headers),
    });
  }
  return merged;
}
