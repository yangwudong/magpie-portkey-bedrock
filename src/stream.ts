// One request: the Bedrock SDK's stream, as pi's assistant message events.
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { streamText, type FinishReason, type LanguageModelUsage } from "ai";
import {
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  ToolCallArgumentsStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type ProviderHeaders,
  type SimpleStreamOptions,
  type StopReason,
  type ThinkingContent,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { BASE_URL_ENV, BASE_URL_HEADER, resolveTemplateHeaders } from "./account.ts";
import { DEFAULT_SWITCHES, type PortkeyConfig } from "./config.ts";
import { bedrockReasoningOptions, cachePointFor, convertMessages, convertTools, mapReasoning } from "./convert.ts";
import { finishErrorMessage, formatError, requestRefusal } from "./errors.ts";

interface StreamBlockState {
  contentIndex: number;
  ended: boolean;
}

interface ToolBlockState extends StreamBlockState {
  /** Incremental parser for streaming tool arguments; removed when the call ends. */
  arguments?: ToolCallArgumentsStream;
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

// The switches that reach the gateway as headers. A header of the same name
// in the config wins over a switch, so a user can still set one by hand.
//
// x-portkey-debug decides whether Portkey stores a request's content. The
// header is named "debug", but false only drops the request and response
// bodies; tokens, cost and latency are kept.
//
// Retries are not among them: they are this provider's own (sendWithRetries).
// Asking the gateway to retry takes an inline x-portkey-config, which a
// Portkey organization blocking inline configs refuses outright (400
// inline_config_blocked, the default for organizations made since June
// 2026), and which replaces a default config an admin set on the API key.
function switchHeaders(switches: Pick<PortkeyConfig, "log">, configured: Record<string, string>): Record<string, string> {
  const has = (name: string) => Object.keys(configured).some((key) => key.toLowerCase() === name);
  return !switches.log && !has("x-portkey-debug") ? { "x-portkey-debug": "false" } : {};
}

// A failure worth sending again as it was: rate limited (429), timed out
// (408) or the upstream failing (5xx). Anything else says the request
// itself is refused, and the same request would be refused again.
function retryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

// How long to wait before the next try: what the reply asks for when it
// says, else 1s doubled each time (1s, 2s, 4s…). null when the wait it asks
// for is a minute or more, or would take the waiting past a minute in all:
// the account is not coming back soon, and magpie should hear of it now.
const RETRY_WAIT_CAP_MS = 60_000;
function retryWait(response: Response, attempt: number, waited: number): number | null {
  const ms = response.headers.get("retry-after-ms");
  const after = response.headers.get("retry-after");
  let asked: number | undefined;
  if (ms && !Number.isNaN(Number(ms))) asked = Number(ms);
  else if (after) {
    const seconds = Number(after);
    asked = Number.isNaN(seconds) ? Date.parse(after) - Date.now() : seconds * 1000;
    if (Number.isNaN(asked)) asked = undefined;
  }
  const wait = asked !== undefined ? Math.max(0, asked) : 1000 * 2 ** attempt;
  if (wait >= RETRY_WAIT_CAP_MS || waited + wait > RETRY_WAIT_CAP_MS) return null;
  return wait;
}

// Sends a request, and sends it again on the same account while it fails
// in a way that may pass (retryable), up to `retries` more times. The same
// account, so the prompt cache written there is read again: magpie moving
// to another account starts with no cache. The last reply is what is
// returned, success or not, so magpie still sees the final status and its
// Retry-After when every try failed. An abort stops the waiting at once.
async function sendWithRetries(
  send: () => Promise<Response>,
  retries: number,
  signal: AbortSignal | undefined,
): Promise<Response> {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const response = await send();
    if (response.ok || attempt >= retries || !retryable(response.status)) return response;
    const wait = retryWait(response, attempt, waited);
    if (wait === null) return response;
    // The failed reply is let go before waiting; its body is not read.
    await response.body?.cancel().catch(() => {});
    waited += wait;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, wait);
      const stop = () => { clearTimeout(timer); reject(signal!.reason); };
      signal?.addEventListener("abort", stop, { once: true });
    });
  }
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

function streamPortkeyAws(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  configuredHeaders: Record<string, string>,
  switches: Pick<PortkeyConfig, "log" | "retry" | "cacheTtl1h">,
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
    // What the gateway said about the one request made below, for an error
    // message: its trace id, to find the request in Portkey, and its own
    // words when it refused.
    let traceId: string | undefined;
    let refusal: string | undefined;
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
        headers: providerHeaders(portkeyApiKey, { ...configured, ...switchHeaders(switches, configured) }),
        fetch: async (url, init) => {
          if (options?.onPayload && typeof init?.body === "string") {
            const payload: unknown = JSON.parse(init.body);
            const replacement = await options.onPayload(payload, model);
            init = { ...init, body: JSON.stringify(replacement ?? payload) };
          }
          // The body is a string, so it can be sent again as it is.
          const retries = typeof init?.body === "string" || init?.body == null ? switches.retry : 0;
          const response = await sendWithRetries(() => send(url, init), retries, signal);
          traceId = response.headers.get("x-portkey-trace-id") ?? undefined;
          // A refusal is the gateway's own: read its body once here, since
          // the SDK only keeps the text of an error it recognises.
          if (!response.ok && response.status !== 429) {
            refusal = requestRefusal(response.status, await response.clone().text());
          }
          await options?.onResponse?.({
            status: response.status,
            headers: Object.fromEntries(response.headers),
          }, model);
          return response;
        },
      });

      const systemPrompt = getCurrentSystemPrompt(context.messages);
      const reasoningOptions = bedrockReasoningOptions(model, options?.reasoning);
      const cachePoint = cachePointFor(model, options?.cacheRetention, switches.cacheTtl1h);
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
      // A timeout or an abort is the user's own doing; only a failure owes
      // an explanation, and then in the gateway's words where it has any.
      if (timeout?.aborted && !options?.signal?.aborted) {
        output.errorMessage = `portkey-bedrock: the request timed out after ${options!.timeoutMs} ms`;
      } else if (output.stopReason === "error") {
        // With the gateway's own account of the refusal, the SDK's copy of
        // the body is left out: it repeats the same words and, for an IAM
        // denial, the account it names.
        output.errorMessage = [
          refusal ?? formatError(error),
          traceId ? `Portkey trace id: ${traceId}` : undefined,
        ].filter(Boolean).join(" ");
      } else {
        output.errorMessage = formatError(error);
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export function createPortkeyStream(configuredHeaders: Record<string, string>, switches: Pick<PortkeyConfig, "log" | "retry" | "cacheTtl1h"> = DEFAULT_SWITCHES) {
  return (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => streamPortkeyAws(model, context, options, configuredHeaders, switches);
}
