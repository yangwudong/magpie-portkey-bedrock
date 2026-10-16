import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext, type Api, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import plugin, { createPortkeyStream, discoverGatewayModels, readConfig } from "../index.ts";
import { end, textEvents, wireResponse, type WireEvent } from "./wire.ts";

export const model: Model<Api> = {
  id: "us.anthropic.claude-opus-4-8", name: "Test", provider: "portkey-bedrock", api: "portkey-bedrock-ai-sdk",
  baseUrl: "https://portkey.example/v1", reasoning: true, input: ["text", "image"],
  thinkingLevelMap: { xhigh: "xhigh", max: "max" }, contextWindow: 1_000_000, maxTokens: 64000,
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};
const context: Context = {
  systemPrompt: "You are helpful.",
  messages: [{ role: "user", content: "Hello", timestamp: 0 }],
  tools: [{ name: "lookup", description: "Look up a value", parameters: { type: "object", properties: { q: { type: "string" } } } }],
};

async function ask(events = textEvents(), ctx = context, extra: SimpleStreamOptions = {}) {
  const captured: { url?: string; init?: RequestInit; body?: any; response?: any; raw: unknown[] } = { raw: [] };
  const stream = createPortkeyStream({ "x-portkey-provider": "@aws-test", "x-portkey-config": "test-config" })(model, normalizeContext(ctx), {
    apiKey: "test-key", reasoning: "max", temperature: 0.2,
    fetch: async (url, init) => {
      captured.url = String(url); captured.init = init; captured.body = JSON.parse(init?.body as string);
      return wireResponse(events);
    },
    onResponse: (response) => { captured.response = response; },
    onProviderStreamEvent: (data) => { captured.raw.push(data); },
    ...extra,
  });
  const seen = [];
  for await (const event of stream) seen.push(structuredClone(event));
  return { captured, seen, message: await stream.result() };
}

test("real Bedrock request: authentication, routing, tools, reasoning, caching and Unicode response", async () => {
  const { captured: c, seen, message } = await ask();
  assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
  assert.deepEqual(message.content, [{ type: "text", text: "Hello 世界 🐦" }]);
  assert.equal(c.url, `https://portkey.example/v1/model/${encodeURIComponent(model.id)}/converse-stream`);
  const headers = new Headers(c.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer test-key");
  assert.equal(headers.get("x-portkey-api-key"), "test-key");
  assert.equal(headers.get("x-portkey-provider"), "@aws-test");
  assert.equal(headers.get("x-portkey-config"), "test-config");
  assert.deepEqual(c.body.system, [{ text: "You are helpful." }, { cachePoint: { type: "default" } }]);
  assert.deepEqual(c.body.messages.at(-1).content.at(-1), { cachePoint: { type: "default" } });
  assert.equal(c.body.toolConfig.tools[0].toolSpec.name, "lookup");
  assert.equal(c.body.inferenceConfig.temperature, undefined); // Bedrock omits sampling while thinking.
  assert.equal(c.body.additionalModelRequestFields.output_config.effort, "max");
  assert.equal(c.response.status, 200);
  assert.equal(c.response.headers["x-amzn-requestid"], "test-request");
  assert.ok(c.raw.length > 0);
  assert.deepEqual(seen.map((e) => e.type), ["start", "text_start", "text_delta", "text_end", "done"]);
  assert.deepEqual({ ...message.usage, cost: undefined }, { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23, cost: undefined });
  assert.ok(Math.abs(message.usage.cost.total - (11 * 5 + 7 * 25 + 3 * 0.5 + 2 * 6.25) / 1_000_000) < 1e-12);
});

test("empty text and length stops remain successful", async () => {
  assert.equal((await ask(textEvents(""))).message.stopReason, "stop");
  const events = textEvents();
  events[events.length - 2] = ["messageStop", { stopReason: "max_tokens" }];
  assert.equal((await ask(events)).message.stopReason, "length");
});

test("signed and redacted reasoning survives streaming and replay", async () => {
  const events: WireEvent[] = [
    ["messageStart", { role: "assistant" }],
    ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "Thinking…" } } }],
    ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig-1" } } }],
    ["contentBlockStop", { contentBlockIndex: 0 }],
    ["contentBlockDelta", { contentBlockIndex: 1, delta: { reasoningContent: { data: "cmVkYWN0ZWQ=" } } }],
    ["contentBlockStop", { contentBlockIndex: 1 }], ...end(),
  ];
  const { message } = await ask(events);
  assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: "Thinking…", thinkingSignature: "sig-1" },
    { type: "thinking", thinking: "", thinkingSignature: "cmVkYWN0ZWQ=", redacted: true },
  ]);
  const replay = await ask(textEvents(), { ...context, messages: [...context.messages, message, { role: "user", content: "Continue", timestamp: 1 }] });
  assert.equal(replay.message.stopReason, "stop", replay.message.errorMessage ?? "");
  const reasoning = replay.captured.body.messages.find((m: any) => m.role === "assistant").content;
  assert.deepEqual(reasoning[0].reasoningContent.reasoningText, { text: "Thinking…", signature: "sig-1" });
  assert.equal(reasoning[1].reasoningContent.redactedReasoning.data, "cmVkYWN0ZWQ=");
});

function toolEvents(input: string): WireEvent[] {
  return [
    ["messageStart", { role: "assistant" }],
    ["contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "call_1", name: "lookup" } } }],
    ["contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: input.slice(0, 4) } } }],
    ["contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: input.slice(4) } } }],
    ["contentBlockStop", { contentBlockIndex: 0 }], ...end("tool_use"),
  ];
}

test("tool calls, text/image tool results and user images round-trip", async () => {
  const { message, seen } = await ask(toolEvents('{"q":"世界"}'));
  assert.equal(message.stopReason, "toolUse", message.errorMessage ?? "");
  assert.deepEqual(message.content, [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { q: "世界" } }]);
  assert.equal(seen.filter((e) => e.type === "toolcall_end").length, 1);
  const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
  for (const isError of [false, true]) {
    const replay = await ask(textEvents(), { ...context, messages: [
      { role: "user", content: [{ type: "text", text: "See this" }, image], timestamp: 0 }, message,
      { role: "toolResult", toolCallId: "call_1", toolName: "lookup", content: [{ type: "text", text: "result" }, image], isError, timestamp: 1 },
    ] });
    assert.equal(replay.message.stopReason, "stop", replay.message.errorMessage ?? "");
    assert.ok(replay.captured.body.messages[0].content.some((c: any) => c.image?.format === "png"));
    const result = replay.captured.body.messages.at(-1).content.find((c: any) => c.toolResult)?.toolResult;
    assert.ok(result.content.some((c: any) => c.image?.format === "png"));
    assert.ok(result.content.some((c: any) => c.text.includes("result")));
  }
});

test("parallel tool calls and interleaved reasoning stream as separate blocks", async () => {
  const events: WireEvent[] = [
    ["messageStart", { role: "assistant" }],
    // Bedrock auto-registers a reasoning block on first reasoning-delta; an
    // explicit bare start would be typed as text and break the sequence.
    ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "Plan: call both" } } }],
    ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig-p" } } }],
    ["contentBlockStop", { contentBlockIndex: 0 }],
    ["contentBlockStart", { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call_a", name: "lookup" } } }],
    ["contentBlockStart", { contentBlockIndex: 2, start: { toolUse: { toolUseId: "call_b", name: "lookup" } } }],
    ["contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '{"q":' } } }],
    ["contentBlockDelta", { contentBlockIndex: 2, delta: { toolUse: { input: '{"q":"b"}' } } }],
    ["contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '"a"}' } } }],
    ["contentBlockStop", { contentBlockIndex: 1 }],
    ["contentBlockStop", { contentBlockIndex: 2 }],
    ["contentBlockStart", { contentBlockIndex: 3, start: {} }],
    ["contentBlockDelta", { contentBlockIndex: 3, delta: { text: "done" } }],
    ["contentBlockStop", { contentBlockIndex: 3 }],
    ...end("tool_use"),
  ];
  const { message, seen } = await ask(events);
  assert.equal(message.stopReason, "toolUse", message.errorMessage ?? "");
  assert.deepEqual(message.content.map((c) => c.type), ["thinking", "toolCall", "toolCall", "text"]);
  const [thinking, toolA, toolB, text] = message.content as any[];
  assert.equal(thinking.thinking, "Plan: call both");
  assert.equal(thinking.thinkingSignature, "sig-p");
  assert.deepEqual(toolA.arguments, { q: "a" });
  assert.deepEqual(toolB.arguments, { q: "b" });
  assert.equal(toolA.id, "call_a");
  assert.equal(toolB.id, "call_b");
  assert.equal(text.text, "done");
  assert.equal(seen.filter((e) => e.type === "toolcall_end").length, 2);
  assert.equal(seen.filter((e) => e.type === "thinking_end").length, 1);
});

test("foreign unsigned thinking becomes text", async () => {
  const foreign = { ...model, provider: "other" };
  const { message, captured } = await ask(textEvents(), { ...context, messages: [
    ...context.messages,
    { role: "assistant", api: foreign.api, provider: foreign.provider, model: foreign.id, content: [{ type: "thinking", thinking: "Foreign reasoning" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 },
    { role: "user", content: "Continue", timestamp: 1 },
  ] });
  assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
  assert.ok(captured.body.messages.some((m: any) => m.content.some((c: any) => c.text === "Foreign reasoning")));
});

test("payload replacement, tool-choice none and observer errors", async () => {
  const { captured, message } = await ask(textEvents(), context, {
    toolChoice: "none", reasoning: undefined,
    onPayload: (body) => ({ ...body as object, custom: "modified" }),
    onProviderStreamEvent: () => { throw Error("observer failed"); },
  });
  assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
  assert.equal(captured.body.custom, "modified");
  assert.equal(captured.body.toolConfig, undefined);
});

test("HTTP refusal reaches onResponse for Magpie failover without retries", async () => {
  let calls = 0;
  let response;
  const { message } = await ask([], context, {
    fetch: async () => { calls++; return new Response(JSON.stringify({ message: "Slow down", type: "throttlingException" }), { status: 429, headers: { "retry-after": "7", "content-type": "application/json" } }); },
    onResponse: (r) => { response = r; },
  });
  assert.equal(calls, 1);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /HTTP 429/);
  assert.deepEqual(response, { status: 429, headers: { "content-type": "application/json", "retry-after": "7" } });
});

test("aborting a request terminates as aborted", async () => {
  const abort = new AbortController();
  const pending = ask([], context, { signal: abort.signal, fetch: async (_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal!;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  } });
  abort.abort();
  assert.equal((await pending).message.stopReason, "aborted");
});

test("missing key, malformed tool JSON, truncated stream and provider errors fail", async () => {
  assert.equal((await ask([], context, { apiKey: undefined })).message.stopReason, "error");
  assert.equal((await ask(toolEvents('{"q":'))).message.stopReason, "error");
  assert.equal((await ask(textEvents().slice(0, 3))).message.stopReason, "error");
  const failed = await ask([["validationException", { message: "context_length_exceeded" }]]);
  assert.equal(failed.message.stopReason, "error");
  assert.match(failed.message.errorMessage!, /context_length_exceeded/);
});

test("rejects secrets embedded in the config", () => {
  const temp = mkdtempSync(join(tmpdir(), "portkey-config-"));
  try {
    const path = join(temp, "config.json");
    const models = join(temp, "models.json");
    writeFileSync(models, '["model-1"]');
    writeFileSync(path, JSON.stringify({ baseUrl: "https://example.com", apiKey: "secret" }));
    assert.throws(() => readConfig(path, models), /secret/);
    writeFileSync(path, JSON.stringify({ baseUrl: "https://example.com", headers: { Authorization: "secret" } }));
    assert.throws(() => readConfig(path, models), /secret/);
  } finally { rmSync(temp, { recursive: true }); }  let registered: any;
  plugin({ registerProvider: (id: string, options: unknown) => { registered = { id, options }; } } as any);
  assert.equal(registered.id, "portkey-bedrock");
  assert.equal(registered.options.models.length, 15);
  // The catalog ends with the non-Anthropic extras; check a known entry's shape.
  const nova = registered.options.models.find((m: any) => m.id === "amazon.nova-pro-v1:0");
  assert.equal(nova.maxTokens, 6400);
  assert.deepEqual(nova.input, ["text", "image"]);
  assert.equal(typeof registered.options.refreshModels, "function");
});

const discoveryContext = (overrides: Record<string, unknown> = {}) => ({
  credential: { type: "api_key", key: "pk-test" },
  baseUrl: "https://portkey.example/v1",
  allowNetwork: true,
  signal: new AbortController().signal,
  ...overrides,
});

test("model discovery merges gateway models with the catalog", async () => {
  const config = readConfig();
  let sent: { url: string; init: RequestInit } | undefined;
  const send = async (url: any, init: any) => {
    sent = { url: String(url), init };
    return new Response(JSON.stringify({
      data: [
        { id: "us.anthropic.claude-sonnet-5-5", name: "ignored, catalog wins" },
        { id: "vendor.custom-model-v1:0", name: "Custom Model" },
        "vendor.string-model-v1:0",
        { id: "us.anthropic.claude-future-9-9" },
        { id: "amazon.nova-pro-v2:0" },
      ],
    }), { status: 200 });
  };
  const merged = await discoverGatewayModels(config, discoveryContext() as any, send as any);

  const known = merged.find((m: any) => m.id === "us.anthropic.claude-sonnet-5-5")! as any;
  assert.equal(known.name, "Claude Sonnet 5.5");
  assert.equal(known.contextWindow, 1_000_000);

  const custom = merged.find((m: any) => m.id === "vendor.custom-model-v1:0")! as any;
  assert.equal(custom.name, "Custom Model");
  assert.equal(custom.reasoning, false);
  assert.deepEqual(custom.input, ["text"]);
  assert.equal(custom.contextWindow, 200_000);
  assert.equal(custom.maxTokens, 8192);

  // Anthropic/Nova ids discovered beyond the catalog get their family's defaults.
  const family = merged.find((m: any) => m.id === "us.anthropic.claude-future-9-9")! as any;
  assert.equal(family.reasoning, true);
  assert.deepEqual(family.input, ["text", "image"]);
  assert.equal(family.contextWindow, 1_000_000);
  assert.equal(family.maxTokens, 64_000);
  const nova = merged.find((m: any) => m.id === "amazon.nova-pro-v2:0")! as any;
  assert.equal(nova.contextWindow, 1_000_000);

  const stringModel = merged.find((m: any) => m.id === "vendor.string-model-v1:0")!;
  assert.ok(String(stringModel.name).startsWith("vendor.string-model"));

  assert.equal(merged.length, config.models.length + 4);
  assert.equal(sent!.url, "https://portkey.example/v1/models");
  const headers = new Headers(sent!.init.headers);
  assert.equal(headers.get("x-portkey-api-key"), "pk-test");
  assert.equal(headers.get("authorization"), "Bearer pk-test");
  assert.equal(headers.get("x-portkey-provider"), config.provider);
});

test("model discovery fails closed and keeps the catalog", async () => {
  const config = readConfig();
  const offline = await discoverGatewayModels(config, discoveryContext({ allowNetwork: false }) as any, async () => {
    throw new Error("must not be called");
  });
  assert.equal(offline.length, config.models.length);

  // The key may live in the credential's env map instead of a direct key.
  let envKey: string | undefined;
  await discoverGatewayModels(config, discoveryContext({ credential: { type: "api_key", env: { PORTKEY_API_KEY: "env-key" } } }) as any, async (_url: any, init: any) => {
    envKey = new Headers(init.headers).get("x-portkey-api-key") ?? undefined;
    return new Response(JSON.stringify({ data: ["vendor.env-v1:0"] }), { status: 200 });
  });
  assert.equal(envKey, "env-key");

  // Gateways that refuse to list models (403/404) keep the catalog quietly.
  for (const status of [403, 404]) {
    const kept = await discoverGatewayModels(
      config,
      discoveryContext() as any,
      async () => new Response("denied", { status }),
    );
    assert.equal(kept.length, config.models.length);
  }

  // Other failures surface so magpie logs them.
  await assert.rejects(
    () => discoverGatewayModels(config, discoveryContext() as any, async () => new Response("boom", { status: 500 })),
    /answered 500/,
  );
  await assert.rejects(
    () => discoverGatewayModels(config, discoveryContext() as any, async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    /returned no models/,
  );
  await assert.rejects(
    () => discoverGatewayModels(config, discoveryContext({ credential: { type: "oauth" } }) as any, async () => {
      throw new Error("must not be called");
    }),
    /no API key/,
  );
});

test("config validation covers headers, models and secret fields", () => {
  const temp = mkdtempSync(join(tmpdir(), "portkey-config-"));
  try {
    const path = join(temp, "config.json");
    const models = join(temp, "models.json");
    const read = (config: unknown, modelsList: unknown = ["model-1"]) => {
      writeFileSync(models, JSON.stringify(modelsList));
      writeFileSync(path, JSON.stringify(config));
      return readConfig(path, models);
    };
    // baseUrl and models shape
    assert.throws(() => read({ baseUrl: "" }), /baseUrl/);
    assert.throws(() => read({ baseUrl: "https://x.com" }, []), /non-empty array/);
    assert.throws(() => read({ baseUrl: "https://x.com" }, [42]), /model ID/);
    // provider / configId types
    assert.throws(() => read({ baseUrl: "https://x.com", provider: 5 }), /provider must be a string/);
    assert.throws(() => read({ baseUrl: "https://x.com", configId: [] }), /configId must be a string/);
    // headers: array, non-string values
    assert.throws(() => read({ baseUrl: "https://x.com", headers: [] }), /headers must be an object/);
    assert.throws(() => read({ baseUrl: "https://x.com", headers: { "x-ok": 1 } }), /must be a string/);
    // forbidden secret fields other than apiKey
    for (const field of ["api_key", "authToken", "virtualKey"]) {
      assert.throws(() => read({ baseUrl: "https://x.com", [field]: "s" }), /secret/);
    }
    // happy path: provider/configId become portkey headers
    const config = read({ baseUrl: "https://x.com", provider: "aws-bedrock", configId: "cfg-1", headers: { "x-custom": "ok" } });
    assert.deepEqual(config.headers, { "x-custom": "ok", "x-portkey-provider": "aws-bedrock", "x-portkey-config": "cfg-1" });
  } finally { rmSync(temp, { recursive: true }); }
});

test("registered refreshModels lists models through the gateway", async () => {
  let registered: any;
  plugin({ registerProvider: (_id: string, options: unknown) => { registered = options; } } as any);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: ["vendor.live-model-v1:0"] }), { status: 200 })) as any;
  try {
    const merged = await registered.refreshModels(discoveryContext() as any);
    assert.equal(merged.length, readConfig().models.length + 1);
    assert.ok(merged.some((m: any) => m.id === "vendor.live-model-v1:0"));
  } finally {
    globalThis.fetch = original;
  }
});
