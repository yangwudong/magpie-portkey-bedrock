// pi's transcript, tools and reasoning settings in AI SDK / Bedrock terms.
import {
  jsonSchema,
  type AssistantContent,
  type FilePart,
  type ModelMessage,
  type TextPart,
  type ToolSet,
} from "ai";
import type {
  Api,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

// Anthropic models on Bedrock only cache at explicit checkpoints. Without these
// markers nothing is ever written to the cache, so every request pays full
// input price on the entire prompt. Bedrock allows 4 checkpoints; we use 2.
type CacheRetention = SimpleStreamOptions["cacheRetention"];
export type CachePointOptions = { bedrock: { cachePoint: { type: "default"; ttl?: "1h" } } };

// Only Claude and Nova accept cachePoint blocks; other families (Llama,
// Mistral, DeepSeek…) gain nothing from them and may reject the request.
// "long" asks for Bedrock's one-hour TTL, as pi's native Bedrock adapter does.
export function cachePointFor(model: Model<Api>, retention: CacheRetention): CachePointOptions | undefined {
  if (retention === "none") return undefined;
  if (!/claude|anthropic\.|nova/i.test(`${model.id} ${model.name ?? ""}`)) return undefined;
  return { bedrock: { cachePoint: { type: "default", ...(retention === "long" ? { ttl: "1h" as const } : {}) } } };
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

export function convertMessages(messages: Message[], cachePoint?: CachePointOptions): ModelMessage[] {
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

export function convertTools(tools: Tool[] | undefined): ToolSet | undefined {
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

export function mapReasoning(level: SimpleStreamOptions["reasoning"], enabled: boolean) {
  if (!enabled || !level) return "none" as const;
  // AI SDK's top-level reasoning type does not yet include max. The provider
  // option below preserves the actual max effort instead of downgrading it.
  if (level === "max") return "xhigh" as const;
  return level;
}

const BEDROCK_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function bedrockReasoningOptions(model: Model<Api>, level: SimpleStreamOptions["reasoning"]) {
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
