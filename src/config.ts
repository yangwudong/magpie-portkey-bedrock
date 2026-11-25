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
  /** Whether Portkey may store request and response content in its logs. Off by default. */
  log: boolean;
  /** Gateway-side retries on 429/5xx: how many attempts after the first, 0 for none. */
  retry: number;
  /** Ask Bedrock's one-hour prompt-cache TTL on Claude models that support it, instead of the 5-minute default. */
  cacheTtl1h: boolean;
}

// The switches, by name, with what a value must be: each is read the same way
// from the config file and from magpie's plugin options, so the two agree.
const SWITCHES = {
  log: { boolean: true },
  retry: { whole: 5 },
  cacheTtl1h: { boolean: true },
} as const;
type SwitchName = keyof typeof SWITCHES;
// The switches as the config carries them, any of them left out.
type Switches = Pick<PortkeyConfig, SwitchName>;
type SomeSwitches = Partial<Switches>;

export const DEFAULT_SWITCHES = { log: false, retry: 0, cacheTtl1h: false } as const;

// Checks one source's switches and names the bad one; a source that says
// nothing about a switch leaves it to the next. A name that is no switch is
// refused too: a mistyped one (`logs`) would otherwise be dropped in
// silence, and a switch the user believes off stay as it was.
function readSwitches(raw: Record<string, unknown>, where: string, only: boolean): SomeSwitches {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!(name in SWITCHES)) {
      if (only) throw new Error(`${where}: unknown field ${name} (known: ${Object.keys(SWITCHES).join(", ")})`);
      continue;
    }
    if (value === undefined) continue;
    const rule = SWITCHES[name as SwitchName];
    if ("boolean" in rule && typeof value !== "boolean") throw new Error(`${where}: ${name} must be true or false`);
    if ("whole" in rule && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > rule.whole)) {
      throw new Error(`${where}: ${name} must be a whole number from 0 to ${rule.whole}`);
    }
    out[name] = value;
  }
  return out as SomeSwitches;
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
// `over` are switches set above the file (magpie's plugin options); each one
// it names wins over the file's, and the rest come from the file.
export function readConfig(
  configPath: string | null = defaultConfigPath(),
  modelsPath = MODELS_PATH,
  over: SomeSwitches = {},
): PortkeyConfig {
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
  // Portkey's "DO NOT TRACK" is among these: with x-portkey-debug false the
  // gateway keeps only tokens, cost and latency for a request, never its
  // content. Off by default, so nothing is stored unless asked for.
  const switches: Switches = { ...DEFAULT_SWITCHES, ...readSwitches(raw, where, false), ...over };

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
  return { headers, models: [...catalog.filter((model) => !ids.has(model.id)), ...extra], ...switches };
}

// magpie's Plugins page gives a provider plugin an Options editor (shown
// once package.json suggests some in magpie.options). What it saves goes to
// plugins.json in magpie's configuration folder, beside this plugin's own
// config file, and the host is restarted. magpie hands those options only to
// its native plugins, so a pi extension reads the file itself; in plain pi
// there is none, and the config file alone is read. PORTKEY_BEDROCK_PLUGINS
// points elsewhere, as PORTKEY_BEDROCK_CONFIG does, so tests stay off the
// user's own file.
export function MAGPIE_PLUGINS_PATH(home: string = homedir()): string {
  return process.env.PORTKEY_BEDROCK_PLUGINS || join(home, ".config", "magpie", "plugins.json");
}

// This plugin's entry in magpie's plugins.json, by its own name; its
// switches, checked as the config file's are. A file that cannot be read is
// no override: it is magpie's, not this plugin's to fail on.
export function readMagpieOptions(
  pluginsPath = MAGPIE_PLUGINS_PATH(),
  name: string,
  log: (message: string) => void = console.error,
): SomeSwitches {
  if (!existsSync(pluginsPath)) return {};
  try {
    const list = readJsonFile(pluginsPath) as { plugins?: Array<{ spec?: unknown; options?: unknown }> } | null;
    const entry = Array.isArray(list?.plugins)
      ? list.plugins.find((plugin) => plugin?.spec === name)
      : undefined;
    const options = entry?.options;
    if (!options || typeof options !== "object" || Array.isArray(options)) return {};
    // Only switches belong there, so anything else is a slip worth naming.
    return readSwitches(options as Record<string, unknown>, `${pluginsPath}: ${name} options`, true);
  } catch (error) {
    log(`portkey-bedrock: ignoring magpie's plugin options, using the config file only: ${formatError(error)}`);
    return {};
  }
}

// What the plugin loads at start: a config that cannot be read (bad JSON, a
// misspelt field) must not take the whole provider away, which in magpie
// looks like the plugin vanishing. The catalog alone is used instead and the
// reason goes to the log (magpie's host sends console output there). The
// bundled models.json is not covered: a broken one is a packaging bug.
// magpie's plugin options are read first, so they still count when the file
// is set aside.
export function loadConfig(
  configPath = defaultConfigPath(),
  modelsPath = MODELS_PATH,
  log: (message: string) => void = console.error,
  over: SomeSwitches = {},
): PortkeyConfig {
  try {
    return readConfig(configPath, modelsPath, over);
  } catch (error) {
    log(`portkey-bedrock: ignoring ${configPath}, using the built-in catalog only: ${formatError(error)}`);
    return readConfig(null, modelsPath, over);
  }
}
