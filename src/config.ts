// The optional shared config and the bundled model catalog.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { BASE_URL_ENV, BASE_URL_HEADER, PROVIDER_ENV } from "./account.ts";
import { formatError } from "./errors.ts";

// The package root: models.json ships there, and earlier versions kept the
// config beside index.ts.
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
// Optional and advanced: settings shared by every account (see readConfig).
// Kept in magpie's config folder, outside the installed package, so plugin
// updates never take it away. The file beside index.ts, where earlier
// versions read it, is still read when the new one does not exist.
// PORTKEY_BEDROCK_CONFIG points elsewhere (tests use it to stay off the
// user's own file).
export const CONFIG_PATH = process.env.PORTKEY_BEDROCK_CONFIG ||
  join(homedir(), ".config", "magpie", "portkey-bedrock", "config.json");
const LEGACY_CONFIG_PATH = join(PACKAGE_DIR, "config.local.json");

export function defaultConfigPath(path = CONFIG_PATH, legacy = LEGACY_CONFIG_PATH): string {
  return !existsSync(path) && existsSync(legacy) ? legacy : path;
}
const MODELS_PATH = join(PACKAGE_DIR, "models.json");

export interface ModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface PortkeyConfig {
  headers: Record<string, string>;
  models: ModelConfig[];
}

function readModels(value: unknown, configPath: string): ModelConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${configPath}: models must be a non-empty array`);
  }

  return value.map((entry, index) => {
    if (typeof entry === "string" && entry.length > 0) return { id: entry };
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const model = entry as Record<string, unknown>;
      if (typeof model.id === "string" && model.id.length > 0) {
        checkModelFields(model, `${configPath}: models[${index}] (${model.id})`);
        return model as unknown as ModelConfig;
      }
    }
    throw new Error(`${configPath}: models[${index}] must be a model ID or an object with an id`);
  });
}

const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const COST_FIELDS = new Set(["input", "output", "cacheRead", "cacheWrite"]);
const MODEL_FIELDS = new Set(["id", "name", "reasoning", "thinkingLevelMap", "input", "contextWindow", "maxTokens", "cost"]);

// Hand-written entries: a misspelt field or a wrong type would otherwise be
// dropped silently or fail mid-request, so each is checked and named.
function checkModelFields(model: Record<string, unknown>, where: string): void {
  const fail = (what: string) => { throw new Error(`${where}: ${what}`); };
  const positive = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
  for (const key of Object.keys(model)) {
    if (!MODEL_FIELDS.has(key)) fail(`unknown field ${key} (known: ${[...MODEL_FIELDS].join(", ")})`);
  }
  if (model.name !== undefined && typeof model.name !== "string") fail("name must be a string");
  if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") fail("reasoning must be true or false");
  if (model.contextWindow !== undefined && !positive(model.contextWindow)) fail("contextWindow must be a whole number of tokens over 0");
  if (model.maxTokens !== undefined && !positive(model.maxTokens)) fail("maxTokens must be a whole number of tokens over 0");
  if (model.input !== undefined) {
    const input = model.input;
    if (!Array.isArray(input) || input.length === 0 || !input.every((v) => v === "text" || v === "image")) {
      fail('input must be a list of "text" and/or "image"');
    }
  }
  if (model.cost !== undefined) {
    const cost = model.cost;
    if (!cost || typeof cost !== "object" || Array.isArray(cost)) fail("cost must be an object");
    for (const [key, price] of Object.entries(cost as object)) {
      if (!COST_FIELDS.has(key)) fail(`unknown cost field ${key} (known: ${[...COST_FIELDS].join(", ")})`);
      if (typeof price !== "number" || !(price >= 0)) fail(`cost.${key} must be a price of 0 or more (USD per million tokens)`);
    }
  }
  if (model.thinkingLevelMap !== undefined) {
    const map = model.thinkingLevelMap;
    if (!map || typeof map !== "object" || Array.isArray(map)) fail("thinkingLevelMap must be an object");
    for (const [level, mapped] of Object.entries(map as object)) {
      if (!THINKING_LEVELS.has(level)) fail(`thinkingLevelMap.${level} is not a thinking level (${[...THINKING_LEVELS].join(", ")})`);
      if (mapped !== null && typeof mapped !== "string") fail(`thinkingLevelMap.${level} must be a level name or null`);
    }
  }
}

function readHeaders(value: unknown, configPath: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${configPath}: headers must be an object`);
  }

  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (/(authorization|api[-_]?key|token|secret|cookie|virtual[-_]?key)/i.test(key)) {
      throw new Error(`${configPath}: secret header ${key} must stay in magpie's sign-in, not in config JSON`);
    }
    if (typeof headerValue !== "string") {
      throw new Error(`${configPath}: headers.${key} must be a string`);
    }
    headers[key] = headerValue;
  }
  return headers;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${path}: ${formatError(error)}`);
  }
}

// The optional config file (CONFIG_PATH) holds settings shared by every
// account, for gateways that want them: `configId` (sent as
// x-portkey-config), extra non-secret `headers` and hidden `models`. Gateway and route are not among them — each account
// brings its own from its sign-in — so `baseUrl` and `provider` left in the
// file by earlier versions are ignored. No file means no shared settings.
// configPath null means no shared settings at all: the catalog alone.
export function readConfig(configPath: string | null = defaultConfigPath(), modelsPath = MODELS_PATH): PortkeyConfig {
  const value = configPath && existsSync(configPath) ? readJsonFile(configPath) : {};
  const where = configPath ?? "config";

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where}: root value must be an object`);
  }

  const raw = value as Record<string, unknown>;
  for (const forbidden of ["apiKey", "api_key", "anthropicApiKey", "authToken", "virtualKey"]) {
    if (forbidden in raw) {
      throw new Error(`${where}: ${forbidden} is a secret and must stay in magpie's sign-in, not in config JSON`);
    }
  }
  if (raw.configId !== undefined && typeof raw.configId !== "string") {
    throw new Error(`${where}: configId must be a string`);
  }

  const headers = readHeaders(raw.headers, where);
  // Routing is per account: each signed-in account's base URL and provider
  // slug come from its sign-in form, carried in the credential's env, and pi
  // resolves these `$VAR` templates from it on every request.
  headers["x-portkey-provider"] = `$${PROVIDER_ENV}`;
  headers[BASE_URL_HEADER] = `$${BASE_URL_ENV}`;
  if (raw.configId) headers["x-portkey-config"] = raw.configId;
  // Extra models the gateway serves but its /models list hides, callable by
  // id. They join the catalog (overriding an entry of the same id) and are
  // registered whether or not discovery reports them.
  const catalog = readModels(readJsonFile(modelsPath), modelsPath);
  // An empty list adds nothing; the catalog alone must be non-empty.
  const extra = raw.models === undefined || (Array.isArray(raw.models) && raw.models.length === 0)
    ? []
    : readModels(raw.models, where);
  const ids = new Set(extra.map((model) => model.id));
  return { headers, models: [...catalog.filter((model) => !ids.has(model.id)), ...extra] };
}

// What the plugin loads at start: a config that cannot be read (bad JSON, a
// misspelt field) must not take the whole provider away, which in magpie
// looks like the plugin vanishing. The catalog alone is used instead and the
// reason goes to the log (magpie's host sends console output there). The
// bundled models.json is not covered: a broken one is a packaging bug.
export function loadConfig(
  configPath = defaultConfigPath(),
  modelsPath = MODELS_PATH,
  log: (message: string) => void = console.error,
): PortkeyConfig {
  try {
    return readConfig(configPath, modelsPath);
  } catch (error) {
    log(`portkey-bedrock: ignoring ${configPath}, using the built-in catalog only: ${formatError(error)}`);
    return readConfig(null, modelsPath);
  }
}
