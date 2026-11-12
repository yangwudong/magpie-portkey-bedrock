import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import {
  jsonSchema,
  streamText,
  type AssistantContent,
  type FilePart,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type TextPart,
  type ToolSet,
} from "ai";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type OAuthLoginCallbacks,
  type TranscriptContext,
  type ImageContent,
  type Message,
  type Model,
  type ProviderHeaders,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  ToolCallArgumentsStream,
} from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER_ID = "portkey-bedrock";
const API_ID = "portkey-bedrock-ai-sdk" as Api;
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
// Optional and advanced: settings shared by every account (see readConfig).
// Kept in magpie's config folder, outside the installed package, so plugin
// updates never take it away. The file beside index.ts, where earlier
// versions read it, is still read when the new one does not exist.
// PORTKEY_BEDROCK_CONFIG points elsewhere (tests use it to stay off the
// user's own file).
export const CONFIG_PATH = process.env.PORTKEY_BEDROCK_CONFIG ||
  join(homedir(), ".config", "magpie", "portkey-bedrock", "config.json");
const LEGACY_CONFIG_PATH = join(EXTENSION_DIR, "config.local.json");

export function defaultConfigPath(path = CONFIG_PATH, legacy = LEGACY_CONFIG_PATH): string {
  return !existsSync(path) && existsSync(legacy) ? legacy : path;
}
const MODELS_PATH = join(EXTENSION_DIR, "models.json");

// Every request goes to its own account's gateway, so the provider has no
// endpoint of its own. pi still wants one to register with; this one is never
// meant to be contacted — `.invalid` (RFC 2606) resolves nowhere, and a
// request reaching streamSimple without an account gateway is refused before
// its key could be sent anywhere else.
const UNROUTED_BASE_URL = "https://account-gateway.invalid/v1";

// A signed-in account carries its own gateway routing next to its key. The
// values live in the credential (magpie's plugin-auth.json, never tracked
// files) and reach each request as `options.env`, where pi resolves the
// `$VAR` header templates below per account. The base URL rides along as a
// courier header that streamSimple strips before calling the SDK.
const BASE_URL_ENV = "PORTKEY_BASE_URL";
const PROVIDER_ENV = "PORTKEY_PROVIDER";
const BASE_URL_HEADER = "x-portkey-account-base-url";
const FAR_FUTURE = 4_102_444_800_000; // 2100-01-01: no refresh is ever due.

// A login form's answers: what magpie's sign-in dialog asked, one field at a time.
export interface PortkeyAccountForm {
  baseUrl: string;
  provider: string;
  apiKey: string;
  /** The name magpie lists the account under: the user's alias, else one derived from the key. */
  name: string;
}

// The account name when the user gives no alias: enough of the key to tell
// accounts apart at a glance without showing it. Portkey keys often share a
// prefix, so both ends are kept — a prefix alone would give two accounts the
// same name, and magpie takes two sign-ins of one name for one account.
export function keyName(apiKey: string): string {
  if (apiKey.length <= 8) return "API key";
  return `API key ${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

// Decodes an account's credential back into the form that created it.
export function accountFormOf(credential: unknown): PortkeyAccountForm | undefined {
  const record = credential && typeof credential === "object" ? (credential as Record<string, unknown>) : undefined;
  if (!record) return undefined;
  const env = record.env && typeof record.env === "object" ? (record.env as Record<string, string>) : undefined;
  const key = typeof record.access === "string" && record.access ? record.access : undefined;
  const baseUrl = env?.[BASE_URL_ENV];
  const provider = env?.[PROVIDER_ENV];
  if (!key || !baseUrl || !provider) return undefined;
  const name = typeof record.accountId === "string" && record.accountId ? record.accountId : keyName(key);
  return { baseUrl, provider, apiKey: key, name };
}

// OAuthCredentials keeps `access` (the key magpie sends as Bearer) and any
// extra fields; `env` rides the credential so pi resolves the header
// templates with it on every request of this account. `accountId` is what
// magpie names the account by in its lists and sign-in notices — and also
// how it recognises a sign-in to an account it already has: signing in
// again under the same name updates that account instead of adding one.
function formToCredentials(form: PortkeyAccountForm) {
  return {
    access: form.apiKey,
    refresh: form.apiKey,
    expires: FAR_FUTURE,
    accountId: form.name,
    env: { [BASE_URL_ENV]: form.baseUrl, [PROVIDER_ENV]: form.provider },
  };
}

// Anthropic models on Bedrock only cache at explicit checkpoints. Without these
// markers nothing is ever written to the cache, so every request pays full
// input price on the entire prompt. Bedrock allows 4 checkpoints; we use 2.
type CacheRetention = SimpleStreamOptions["cacheRetention"];
type CachePointOptions = { bedrock: { cachePoint: { type: "default"; ttl?: "1h" } } };

// Only Claude and Nova accept cachePoint blocks; other families (Llama,
// Mistral, DeepSeek…) gain nothing from them and may reject the request.
// "long" asks for Bedrock's one-hour TTL, as pi's native Bedrock adapter does.
function cachePointFor(model: Model<Api>, retention: CacheRetention): CachePointOptions | undefined {
  if (retention === "none") return undefined;
  if (!/claude|anthropic\.|nova/i.test(`${model.id} ${model.name ?? ""}`)) return undefined;
  return { bedrock: { cachePoint: { type: "default", ...(retention === "long" ? { ttl: "1h" as const } : {}) } } };
}

interface ModelConfig {
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

interface PortkeyConfig {
  headers: Record<string, string>;
  models: ModelConfig[];
}

interface StreamBlockState {
  contentIndex: number;
  ended: boolean;
}

interface ToolBlockState extends StreamBlockState {
  /** Incremental parser for streaming tool arguments; removed when the call ends. */
  arguments?: ToolCallArgumentsStream;
}

function readModels(value: unknown, configPath: string): ModelConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${configPath}: models must be a non-empty array`);
  }

  return value.map((entry, index) => {
    if (typeof entry === "string" && entry.length > 0) return { id: entry };
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const model = entry as ModelConfig;
      if (typeof model.id === "string" && model.id.length > 0) return model;
    }
    throw new Error(`${configPath}: models[${index}] must be a model ID or an object with an id`);
  });
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
export function readConfig(configPath = defaultConfigPath(), modelsPath = MODELS_PATH): PortkeyConfig {
  const value = existsSync(configPath) ? readJsonFile(configPath) : {};

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${configPath}: root value must be an object`);
  }

  const raw = value as Record<string, unknown>;
  for (const forbidden of ["apiKey", "api_key", "anthropicApiKey", "authToken", "virtualKey"]) {
    if (forbidden in raw) {
      throw new Error(`${configPath}: ${forbidden} is a secret and must stay in magpie's sign-in, not in config JSON`);
    }
  }
  if (raw.configId !== undefined && typeof raw.configId !== "string") {
    throw new Error(`${configPath}: configId must be a string`);
  }

  const headers = readHeaders(raw.headers, configPath);
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
    : readModels(raw.models, configPath);
  const ids = new Set(extra.map((model) => model.id));
  return { headers, models: [...catalog.filter((model) => !ids.has(model.id)), ...extra] };
}

// Resolves `$VAR` header templates against an account's env map, as pi's
// provider layer does. A header whose template the env cannot answer is
// left out rather than sent as its own `$VAR` text.
function resolveTemplateHeaders(headers: Record<string, string>, env: Record<string, string> | undefined): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    let missing = false;
    const text = value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_whole, name: string) => {
      const found = env?.[name];
      if (!found) missing = true;
      return found ?? "";
    });
    if (!missing) resolved[key] = text;
  }
  return resolved;
}

function providerHeaders(
  portkeyApiKey: string,
  configuredHeaders: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...configuredHeaders,
    "x-portkey-api-key": portkeyApiKey,
  };
}

// Header lookup that tolerates case differences between the layer that set
// it and the one that reads it.
function firstHeader(headers: ProviderHeaders | Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && typeof value === "string" && value) return value;
  }
  return undefined;
}

function convertUserContent(content: string | Array<TextContent | ImageContent>): string | Array<TextPart | FilePart> {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text };
    return {
      type: "file" as const,
      data: part.data,
      mediaType: part.mimeType,
    };
  });
}

function convertToolResultContent(message: ToolResultMessage) {
  const text = message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const images = message.content.filter((part): part is ImageContent => part.type === "image");

  if (images.length === 0) {
    return message.isError
      ? ({ type: "error-text", value: text || "Tool execution failed" } as const)
      : ({ type: "text", value: text } as const);
  }

  return {
    type: "content" as const,
    value: [
      ...(text ? [{ type: "text" as const, text: message.isError ? `Error: ${text}` : text }] : []),
      ...images.map((image) => ({
        type: "file" as const,
        data: { type: "data" as const, data: image.data },
        mediaType: image.mimeType,
      })),
    ],
  };
}

function convertMessages(messages: Message[], cachePoint?: CachePointOptions): ModelMessage[] {
  const converted: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      converted.push({ role: "user", content: convertUserContent(message.content) });
      continue;
    }

    if (message.role === "assistant") {
      // Converse's ReasoningContentBlock union carries redacted reasoning as a
      // top-level redactedContent member, but Anthropic models take it wrapped
      // in redactedReasoning.data instead. Replay each block the way its model
      // originally delivered it.
      const anthropicRedaction = /anthropic\./.test(message.model ?? "");
      const content: AssistantContent = [];
      for (const block of message.content) {
        if (block.type === "text") {
          if (block.text) content.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          const thinking = block as ThinkingContent;
          if (thinking.redacted && thinking.thinkingSignature) {
            content.push({
              type: "reasoning",
              text: "",
              providerOptions: anthropicRedaction
                ? { bedrock: { redactedData: thinking.thinkingSignature } }
                : { bedrock: { redactedContent: thinking.thinkingSignature } },
            });
            continue;
          }
          if (!thinking.thinking) continue;
          if (thinking.thinkingSignature) {
            content.push({
              type: "reasoning",
              text: thinking.thinking,
              providerOptions: { bedrock: { signature: thinking.thinkingSignature } },
            });
          } else {
            // Bedrock Anthropic models reject replayed thinking without a signature. Preserve it as text instead.
            content.push({ type: "text", text: thinking.thinking });
          }
        } else if (block.type === "toolCall") {
          content.push({
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: block.arguments,
          });
        }
      }
      if (content.length > 0) converted.push({ role: "assistant", content });
      continue;
    }

    if (message.role === "toolResult") {
      converted.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            output: convertToolResultContent(message),
          },
        ],
      });
    }
  }

  // Checkpoint the end of the conversation so the next turn reads this prefix
  // back instead of re-paying for it. The marker rolls forward every turn.
  const last = converted[converted.length - 1];
  if (last && cachePoint) last.providerOptions = cachePoint;

  return converted;
}

function convertTools(tools: Tool[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;

  const converted: ToolSet = {};
  for (const tool of tools) {
    converted[tool.name] = {
      description: tool.description,
      inputSchema: jsonSchema(tool.parameters),
      // No outputSchema: Bedrock's toolSpec has no output field, so an
      // empty schema here only adds conversion work per request.
    };
  }
  return converted;
}

function mapReasoning(level: SimpleStreamOptions["reasoning"], enabled: boolean) {
  if (!enabled || !level) return "none" as const;
  // AI SDK's top-level reasoning type does not yet include max. The provider
  // option below preserves the actual max effort instead of downgrading it.
  if (level === "max") return "xhigh" as const;
  return level;
}

const BEDROCK_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function bedrockReasoningOptions(model: Model<Api>, level: SimpleStreamOptions["reasoning"]) {
  if (!model.reasoning || !level || !model.thinkingLevelMap) return undefined;

  const mapped = model.thinkingLevelMap[level];
  if (mapped === null) return undefined;
  const effort = typeof mapped === "string" ? mapped : level === "minimal" ? "low" : level;
  if (!BEDROCK_REASONING_EFFORTS.has(effort)) return undefined;

  return {
    bedrock: {
      reasoningConfig: {
        type: "adaptive" as const,
        // Bedrock omits thinking unless display asks for it, so a long think
        // sends nothing until the answer starts: the first token then waits for
        // the whole reasoning pass. Summarized thinking streams as it happens.
        display: "summarized" as const,
        maxReasoningEffort: effort as "low" | "medium" | "high" | "xhigh" | "max",
      },
    },
  };
}

// Bedrock's trace.guardrail names what fired: input/output assessments keyed
// by guardrail id, each holding policy sections (topicPolicy.topics,
// contentPolicy.filters, wordPolicy.customWords, sensitiveInformationPolicy
// .piiEntities, ...). Report every entry that took an action.
function guardrailFindings(trace: unknown): string[] {
  const guardrail = (trace as { guardrail?: Record<string, unknown> } | undefined)?.guardrail;
  if (!guardrail || typeof guardrail !== "object") return [];
  const findings = new Set<string>();
  const visit = (where: string, assessment: unknown) => {
    if (!assessment || typeof assessment !== "object") return;
    for (const [policy, sections] of Object.entries(assessment)) {
      if (!sections || typeof sections !== "object") continue;
      for (const entries of Object.values(sections)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries as Record<string, unknown>[]) {
          if (!entry || typeof entry.action !== "string" || entry.action === "NONE") continue;
          const what = [entry.name, entry.type, entry.match].filter((v) => typeof v === "string" && v).join(" ");
          const confidence = typeof entry.confidence === "string" ? `, confidence ${entry.confidence}` : "";
          findings.add(`${where} ${policy}${what ? ` ${what}` : ""} ${entry.action}${confidence}`);
        }
      }
    }
  };
  for (const [id, assessment] of Object.entries((guardrail.inputAssessment ?? {}) as Record<string, unknown>)) {
    visit(`input[${id}]`, assessment);
  }
  for (const [id, list] of Object.entries((guardrail.outputAssessments ?? {}) as Record<string, unknown>)) {
    for (const assessment of Array.isArray(list) ? list : [list]) visit(`output[${id}]`, assessment);
  }
  return [...findings];
}

// Name the cause so a blocked response is not mistaken for a gateway outage.
function finishErrorMessage(reason: FinishReason | undefined, raw: string | undefined, trace?: unknown): string {
  const detail = raw ? ` (stopReason: ${raw})` : "";
  if (reason === "content-filter") {
    const by = raw === "guardrail_intervened" ? "a Bedrock/Portkey guardrail" : "Bedrock content filtering";
    const fired = guardrailFindings(trace);
    return `Response blocked by ${by}${detail}. ` +
      (fired.length ? `Bedrock reported: ${fired.join("; ")}. ` : "") +
      "This is a content policy decision, not a gateway failure; " +
      "retrying the same request will likely be blocked again. Check the guardrail logs in Portkey to see which rule fired.";
  }
  return `Portkey returned an error finish reason${detail}`;
}

function mapFinishReason(reason: FinishReason): StopReason {
  switch (reason) {
    case "tool-calls":
      return "toolUse";
    case "length":
      return "length";
    case "error":
      return "error";
    // Bedrock reports guardrail interventions and safety filtering this way.
    // The finish handler turns it into an explicit error below so a filtered
    // response never looks like a complete one.
    case "content-filter":
      return "error";
    default:
      return "stop";
  }
}

function updateUsage(output: AssistantMessage, usage: LanguageModelUsage, model: Model<Api>): void {
  const cacheRead = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails.cacheWriteTokens ?? 0;
  const input =
    usage.inputTokenDetails.noCacheTokens ??
    Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);

  output.usage.input = input;
  output.usage.output = usage.outputTokens ?? 0;
  output.usage.cacheRead = cacheRead;
  output.usage.cacheWrite = cacheWrite;
  output.usage.totalTokens = input + output.usage.output + cacheRead + cacheWrite;
  calculateCost(model, output.usage);
}

function applyReasoningMetadata(block: ThinkingContent, metadata: unknown): void {
  if (!metadata || typeof metadata !== "object") return;
  for (const key of ["amazonBedrock", "bedrock"]) {
    const entry = (metadata as Record<string, unknown>)[key];
    if (!entry || typeof entry !== "object") continue;
    const { signature, redactedData, redactedContent } = entry as Record<string, unknown>;
    if (typeof signature === "string" && signature) block.thinkingSignature = signature;
    // redactedData is Anthropic's redactedReasoning; redactedContent is the
    // Nova-style opaque reasoning the SDK accumulates and emits at block end.
    if (typeof redactedData === "string" && redactedData) {
      block.thinkingSignature = redactedData;
      block.redacted = true;
    }
    if (typeof redactedContent === "string" && redactedContent) {
      block.thinkingSignature = redactedContent;
      block.redacted = true;
    }
  }
}

function parseToolInput(input: unknown): ToolCall["arguments"] {
  const parsed: unknown = typeof input === "string" ? JSON.parse(input) : input;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as ToolCall["arguments"];
  }
  throw new Error("Portkey returned tool arguments that are not a JSON object");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const apiError = error as Error & { responseBody?: unknown; statusCode?: number; type?: unknown };
    const responseBody =
      typeof apiError.responseBody === "string"
        ? apiError.responseBody
        : apiError.responseBody === undefined
          ? undefined
          : JSON.stringify(apiError.responseBody);
    const message = apiError.message || "API request failed";
    // Bedrock's in-stream exceptions carry their name (validationException,
    // throttlingException, ...) as type; keep it so the cause is visible.
    const type = typeof apiError.type === "string" && !message.startsWith(apiError.type) ? apiError.type : undefined;
    return [
      type ? `Bedrock ${type}: ${message}` : message,
      apiError.statusCode ? `(HTTP ${apiError.statusCode})` : undefined,
      responseBody,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function streamPortkeyAws(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  configuredHeaders: Record<string, string>,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const textBlocks = new Map<string, StreamBlockState>();
    const reasoningBlocks = new Map<string, StreamBlockState>();
    const toolBlocks = new Map<string, ToolBlockState>();

    const ensureTextBlock = (id: string): StreamBlockState => {
      const existing = textBlocks.get(id);
      if (existing) return existing;
      const state = { contentIndex: output.content.length, ended: false };
      output.content.push({ type: "text", text: "" });
      textBlocks.set(id, state);
      stream.push({ type: "text_start", contentIndex: state.contentIndex, partial: output });
      return state;
    };

    const ensureReasoningBlock = (id: string, metadata?: unknown): StreamBlockState => {
      const existing = reasoningBlocks.get(id);
      if (existing) return existing;
      const block: ThinkingContent = { type: "thinking", thinking: "" };
      applyReasoningMetadata(block, metadata);
      const state = { contentIndex: output.content.length, ended: false };
      output.content.push(block);
      reasoningBlocks.set(id, state);
      stream.push({ type: "thinking_start", contentIndex: state.contentIndex, partial: output });
      return state;
    };

    const ensureToolBlock = (id: string, name: string): ToolBlockState => {
      const existing = toolBlocks.get(id);
      if (existing) return existing;
      const state = { contentIndex: output.content.length, arguments: new ToolCallArgumentsStream(), ended: false };
      output.content.push({ type: "toolCall", id, name, arguments: {} });
      toolBlocks.set(id, state);
      stream.push({ type: "toolcall_start", contentIndex: state.contentIndex, partial: output });
      return state;
    };

    // A deadline of its own, so a timeout reads as one rather than as an
    // abort the user never asked for or an opaque stream failure.
    const timeout = options?.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
    try {
      const portkeyApiKey = options?.apiKey;
      if (!portkeyApiKey) throw new Error("portkey-bedrock: no account is signed in (Providers → Portkey Bedrock → sign in)");

      // Per-account routing. Pi resolves the provider headers' `$VAR`
      // templates from the account's credential env and passes the result
      // here as options.headers. The base-URL courier among them picks the
      // account's gateway and is never sent on.
      const env = options?.env;
      const accountBaseUrl = firstHeader(options?.headers, BASE_URL_HEADER) ?? env?.[BASE_URL_ENV];
      if (!accountBaseUrl) {
        throw new Error("portkey-bedrock: this account carries no gateway — sign it out and sign in again (Providers → Portkey Bedrock)");
      }
      const requestHeaders = Object.fromEntries(
        Object.entries(options?.headers ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string" && entry[0].toLowerCase() !== BASE_URL_HEADER,
        ),
      );
      const configured = resolveTemplateHeaders(configuredHeaders, env);
      delete configured[BASE_URL_HEADER];

      const send = options?.fetch ?? globalThis.fetch;
      const signal = timeout
        ? AbortSignal.any([...(options?.signal ? [options.signal] : []), timeout])
        : options?.signal;
      const bedrock = createAmazonBedrock({
        baseURL: accountBaseUrl,
        // Portkey requires both Bearer authentication and its own key header.
        apiKey: portkeyApiKey,
        headers: providerHeaders(portkeyApiKey, configured),
        fetch: async (url, init) => {
          if (options?.onPayload && typeof init?.body === "string") {
            const payload: unknown = JSON.parse(init.body);
            const replacement = await options.onPayload(payload, model);
            init = { ...init, body: JSON.stringify(replacement ?? payload) };
          }
          const response = await send(url, init);
          await options?.onResponse?.({
            status: response.status,
            headers: Object.fromEntries(response.headers),
          }, model);
          return response;
        },
      });

      const systemPrompt = getCurrentSystemPrompt(context.messages);
      const reasoningOptions = bedrockReasoningOptions(model, options?.reasoning);
      const cachePoint = cachePointFor(model, options?.cacheRetention);
      const result = streamText({
        model: bedrock(model.id as never),
        // Passed as a SystemModelMessage rather than a plain string so it can
        // carry a cache checkpoint. Tools and system form the large static
        // prefix, so this is the checkpoint that pays for itself.
        instructions: systemPrompt
          ? {
              role: "system",
              content: systemPrompt,
              ...(cachePoint ? { providerOptions: cachePoint } : {}),
            }
          : undefined,
        messages: convertMessages(context.messages, cachePoint),
        tools: convertTools(getCurrentTools(context.messages)),
        maxOutputTokens: options?.maxTokens ?? model.maxTokens,
        reasoning: reasoningOptions ? undefined : mapReasoning(options?.reasoning, model.reasoning),
        providerOptions: reasoningOptions,
        temperature: model.reasoning && options?.reasoning ? undefined : options?.temperature,
        toolChoice: options?.toolChoice,
        headers: requestHeaders,
        includeRawChunks: !!options?.onProviderStreamEvent,
        abortSignal: signal,
        maxRetries: 0,
        // The host renders finalized errors; suppress the SDK's stack dump.
        onError: () => {},
      });

      stream.push({ type: "start", partial: output });

      let finished = false;
      let finishReason: FinishReason | undefined;
      let rawFinishReason: string | undefined;
      let guardrailTrace: unknown;
      for await (const part of result.stream) {
        if (part.type === "raw" && options?.onProviderStreamEvent) {
          // Observation must not interrupt the response if an observer fails.
          try { await options.onProviderStreamEvent(part.rawValue, model); } catch {}
        }
        switch (part.type) {
          case "text-start":
            ensureTextBlock(part.id);
            break;
          case "text-delta": {
            const state = ensureTextBlock(part.id);
            const block = output.content[state.contentIndex];
            if (block.type !== "text") break;
            block.text += part.text;
            stream.push({ type: "text_delta", contentIndex: state.contentIndex, delta: part.text, partial: output });
            break;
          }
          case "text-end": {
            const state = ensureTextBlock(part.id);
            if (state.ended) break;
            state.ended = true;
            const block = output.content[state.contentIndex];
            if (block.type === "text") {
              stream.push({ type: "text_end", contentIndex: state.contentIndex, content: block.text, partial: output });
            }
            break;
          }
          case "reasoning-start":
            ensureReasoningBlock(part.id, part.providerMetadata);
            break;
          case "reasoning-delta": {
            const state = ensureReasoningBlock(part.id, part.providerMetadata);
            const block = output.content[state.contentIndex];
            if (block.type !== "thinking") break;
            block.thinking += part.text;
            applyReasoningMetadata(block, part.providerMetadata);
            stream.push({
              type: "thinking_delta",
              contentIndex: state.contentIndex,
              delta: part.text,
              partial: output,
            });
            break;
          }
          case "reasoning-end": {
            const state = ensureReasoningBlock(part.id, part.providerMetadata);
            if (state.ended) break;
            state.ended = true;
            const block = output.content[state.contentIndex];
            if (block.type === "thinking") {
              applyReasoningMetadata(block, part.providerMetadata);
              stream.push({
                type: "thinking_end",
                contentIndex: state.contentIndex,
                content: block.thinking,
                partial: output,
              });
            }
            break;
          }
          case "tool-input-start":
            ensureToolBlock(part.id, part.toolName);
            break;
          case "tool-input-delta": {
            const state = toolBlocks.get(part.id);
            if (!state?.arguments) break;
            const block = output.content[state.contentIndex];
            if (block.type !== "toolCall") break;
            // Linear incremental parse: the naive way re-parses the whole
            // accumulated JSON on every delta, quadratic on large arguments.
            // append() returns the partial arguments, a fresh object only
            // when they actually changed.
            block.arguments = state.arguments.append(part.delta);
            stream.push({
              type: "toolcall_delta",
              contentIndex: state.contentIndex,
              delta: part.delta,
              partial: output,
            });
            break;
          }
          case "tool-call": {
            const state = ensureToolBlock(part.toolCallId, part.toolName);
            if (state.ended) break;
            state.ended = true;
            const block = output.content[state.contentIndex];
            if (block.type !== "toolCall") break;
            block.arguments = parseToolInput(part.input);
            delete state.arguments;
            stream.push({
              type: "toolcall_end",
              contentIndex: state.contentIndex,
              toolCall: block as ToolCall,
              partial: output,
            });
            break;
          }
          case "finish-step":
            guardrailTrace = (part.providerMetadata?.bedrock as { trace?: unknown } | undefined)?.trace;
            break;
          case "finish":
            if (part.finishReason === "other") throw new Error("Portkey stream ended without a valid stop reason");
            finished = true;
            finishReason = part.finishReason;
            rawFinishReason = part.rawFinishReason;
            output.stopReason = mapFinishReason(part.finishReason);
            updateUsage(output, part.totalUsage, model);
            break;
          case "abort":
            throw new Error(part.reason || "Request was aborted");
          case "error":
            throw part.error;
          default:
            break;
        }
      }

      if (options?.signal?.aborted) throw new Error("Request was aborted");
      if (timeout?.aborted) throw timeout.reason;
      if (!finished) throw new Error("Portkey stream ended before completion");
      if ([...textBlocks.values(), ...reasoningBlocks.values(), ...toolBlocks.values()].some((block) => !block.ended)) {
        throw new Error("Portkey stream ended with an incomplete content block");
      }
      if (output.stopReason === "error") throw new Error(finishErrorMessage(finishReason, rawFinishReason, guardrailTrace));

      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = timeout?.aborted && !options?.signal?.aborted
        ? `portkey-bedrock: the request timed out after ${options!.timeoutMs} ms`
        : formatError(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export function createPortkeyStream(configuredHeaders: Record<string, string>) {
  return (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => streamPortkeyAws(model, context, options, configuredHeaders);
}

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

// The sign-in form magpie renders in its dialog: each onPrompt is one GUI
// input, asked and answered in turn; no browser, no extra confirmation — the
// last answer saves the account. Three fields route the account; the fourth,
// an optional name, only labels it in magpie's lists (empty: part of the key).
//
// Placeholders are always Portkey's public defaults, never another account's
// values. An empty answer means the default the placeholder shows.
//
// magpie's bridge restarts a login that has already finished when the front
// end asks the method again, and the front end does ask again right after the
// last answer, before it authorizes. A login that simply returned would be
// restarted and the dialog would loop back to the first field. So after the
// last answer the login announces progress — the bridge wakes the waiting
// round on any notice, and with no question and no URL pending that round
// reports the form done — and stays in flight a moment longer. The front
// end's next round then finds the login still running and waits for it
// instead of restarting it, and authorize collects the result. No state is
// kept between sign-ins.
const FINISH_HOLD_MS = 1_000;
const DEFAULT_BASE_URL = "https://api.portkey.ai/v1";
const DEFAULT_PROVIDER = "aws-bedrock";

async function portkeyLoginForm(callbacks: OAuthLoginCallbacks): Promise<PortkeyAccountForm> {
  const ask = async (message: string, placeholder: string) =>
    (await callbacks.onPrompt({ message, placeholder })).trim();

  const baseUrl = (await ask("Portkey gateway base URL", DEFAULT_BASE_URL)) || DEFAULT_BASE_URL;
  const provider = (await ask("Portkey provider slug (x-portkey-provider)", DEFAULT_PROVIDER)) || DEFAULT_PROVIDER;
  const apiKey = await ask("Portkey API key", "pk-…");
  if (!apiKey) throw new Error("A Portkey API key is required");
  if (!/^https?:\/\/\S+$/i.test(baseUrl)) throw new Error(`The base URL must start with http:// or https://, not ${baseUrl}`);
  const derived = keyName(apiKey);
  const name = (await ask("Account name (optional, leave empty to use part of the key)", derived)) || derived;

  callbacks.onProgress?.("Saving the Portkey account…");
  await new Promise((resolve) => setTimeout(resolve, FINISH_HOLD_MS));
  return { baseUrl, provider, apiKey, name };
}

export default function portkeyAwsExtension(pi: ExtensionAPI): void {
  const config = readConfig();
  const models = toProviderModels(config.models, config.headers);

  pi.registerProvider(PROVIDER_ID, {
    name: "Portkey Bedrock",
    baseUrl: UNROUTED_BASE_URL,
    api: API_ID,
    headers: config.headers,
    models,
    streamSimple: createPortkeyStream(config.headers),
    async refreshModels(context) {
      return await discoverGatewayModels(config, context);
    },
    oauth: {
      name: "Portkey Bedrock gateway",
      async login(callbacks) {
        return formToCredentials(await portkeyLoginForm(callbacks));
      },
      // A Portkey key never expires on its own; nothing to renew. The far
      // future expiry keeps pi's refresh path from ever running.
      async refreshToken(credentials) {
        return credentials;
      },
      getApiKey(credentials) {
        return String((credentials as { access?: string }).access ?? "");
      },
    },
  });
}
