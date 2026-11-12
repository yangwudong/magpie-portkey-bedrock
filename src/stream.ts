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
import { bedrockReasoningOptions, cachePointFor, convertMessages, convertTools, mapReasoning } from "./convert.ts";
import { finishErrorMessage, formatError } from "./errors.ts";

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
