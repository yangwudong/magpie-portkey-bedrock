import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeContext, type Api, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import plugin, { accountFormOf, CONFIG_PATH, createPortkeyStream, defaultConfigPath, discoverGatewayModels, keyName, readConfig } from "../index.ts";
import { end, textEvents, usage, wireResponse, type WireEvent } from "./wire.ts";

// The catalog with no shared settings, as a fresh install has: never the
// user's own config file.
const MODELS = fileURLToPath(new URL("../models.json", import.meta.url));
const noSettings = () => readConfig(join(tmpdir(), "portkey-no-such-config.json"), MODELS);

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

// The account's gateway as pi hands it to streamSimple: the resolved
// base-URL courier among the request headers.
const accountGateway = { "x-portkey-account-base-url": "https://portkey.example/v1" };

async function ask(events = textEvents(), ctx = context, extra: SimpleStreamOptions = {}) {
  const captured: { url?: string; init?: RequestInit; body?: any; response?: any; raw: unknown[] } = { raw: [] };
  const stream = createPortkeyStream({ "x-portkey-provider": "@aws-test", "x-portkey-config": "test-config" })(model, normalizeContext(ctx), {
    apiKey: "test-key", reasoning: "max", temperature: 0.2, headers: accountGateway,
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
  assert.equal(c.body.additionalModelRequestFields.thinking.display, "summarized"); // Otherwise the first token waits for the whole think.
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

test("content-filtered finishes surface as errors, not silent stops", async () => {
  for (const stopReason of ["content_filtered", "guardrail_intervened"]) {
    const events = textEvents();
    events[events.length - 2] = ["messageStop", { stopReason }];
    const { message } = await ask(events);
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage!, /^Response blocked by /);
    assert.match(message.errorMessage!, new RegExp(`stopReason: ${stopReason}`));
    assert.match(message.errorMessage!, stopReason === "guardrail_intervened" ? /guardrail/ : /content filtering/);
  }
});

test("guardrail blocks report what Bedrock says fired", async () => {
  const trace = { guardrail: { inputAssessment: { gr1: {
    topicPolicy: { topics: [{ name: "Finance", type: "DENY", action: "BLOCKED" }] },
    contentPolicy: { filters: [{ type: "VIOLENCE", confidence: "HIGH", action: "BLOCKED" }, { type: "HATE", confidence: "NONE", action: "NONE" }] },
  } } } };
  const events = textEvents();
  events.splice(-2, 2, ["messageStop", { stopReason: "guardrail_intervened" }], ["metadata", { usage, trace }]);
  const { message } = await ask(events);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /input\[gr1\] topicPolicy Finance DENY BLOCKED/);
  assert.match(message.errorMessage!, /input\[gr1\] contentPolicy VIOLENCE BLOCKED, confidence HIGH/);
  assert.doesNotMatch(message.errorMessage!, /HATE/);
});

test("Nova-style redactedContent reasoning survives streaming and replay", async () => {
  // The SDK accumulates opaque redactedContent deltas and emits the whole
  // payload on reasoning-end; Anthropic-style redactedData arrives on deltas.
  const events: WireEvent[] = [
    ["messageStart", { role: "assistant" }],
    ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: "cGFydA==" } } }],
    ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: "Mg==" } } }],
    ["contentBlockStop", { contentBlockIndex: 0 }], ...end(),
  ];
  const { message } = await ask(events);
  assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: "", thinkingSignature: "cGFydA==Mg==", redacted: true },
  ]);
  const replay = await ask(textEvents(), { ...context, messages: [...context.messages, { ...message, model: "amazon.nova-2-lite-v1:0" }, { role: "user", content: "Continue", timestamp: 1 }] });
  assert.equal(replay.message.stopReason, "stop", replay.message.errorMessage ?? "");
  const reasoning = replay.captured.body.messages.find((m: any) => m.role === "assistant").content;
  // Non-Anthropic models replay redacted reasoning as Converse's native
  // top-level redactedContent member; Anthropic wraps it in redactedReasoning.
  assert.equal(reasoning[0].reasoningContent.redactedContent, "cGFydA==Mg==");
  const anthropicReplay = await ask(textEvents(), { ...context, messages: [...context.messages, message, { role: "user", content: "Continue", timestamp: 1 }] });
  assert.equal(anthropicReplay.captured.body.messages.find((m: any) => m.role === "assistant").content[0].reasoningContent.redactedReasoning.data, "cGFydA==Mg==");
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
  assert.match(failed.message.errorMessage!, /^Bedrock validationException: context_length_exceeded \(HTTP 400\)/);
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
  // The provider has no gateway of its own: its registered endpoint resolves
  // nowhere, and every request goes to its account's gateway instead.
  assert.match(registered.options.baseUrl, /\.invalid\//);
});

test("a request without an account gateway is refused before anything is sent", async () => {
  let sent = false;
  const stream = createPortkeyStream({})(model, normalizeContext(context), {
    apiKey: "pk-keep-me-home",
    fetch: async () => { sent = true; return wireResponse(textEvents()); },
  });
  const message = await stream.result();
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /carries no gateway/);
  assert.equal(sent, false);
});

// A form sign-in's credential: the key plus the account's gateway and route.
const formCredential = {
  type: "oauth", access: "pk-test", refresh: "pk-test", expires: 4_102_444_800_000,
  env: { PORTKEY_BASE_URL: "https://portkey.example/v1", PORTKEY_PROVIDER: "@aws-test" },
};
const discoveryContext = (overrides: Record<string, unknown> = {}) => ({
  credential: formCredential,
  baseUrl: "https://ignored.example/v1",
  allowNetwork: true,
  signal: new AbortController().signal,
  ...overrides,
});

test("model discovery merges gateway models with the catalog", async () => {
  const config = noSettings();
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
  // The account's own route; the base-URL courier never reaches the gateway.
  assert.equal(headers.get("x-portkey-provider"), "@aws-test");
  assert.equal(headers.get("x-portkey-account-base-url"), null);
});

test("model discovery fails closed and keeps the catalog", async () => {
  const config = noSettings();
  const offline = await discoverGatewayModels(config, discoveryContext({ allowNetwork: false }) as any, async () => {
    throw new Error("must not be called");
  });
  assert.equal(offline.length, config.models.length);

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
  // A credential without the form's routing (a key sign-in from before the
  // form existed) lists nothing rather than guess a gateway for its key.
  for (const credential of [{ type: "oauth" }, { type: "api_key", key: "pk-old" }]) {
    await assert.rejects(
      () => discoverGatewayModels(config, discoveryContext({ credential }) as any, async () => {
        throw new Error("must not be called");
      }),
      /carries no gateway/,
    );
  }
});

test("the config lives in magpie's folder; the old file beside index.ts is read until it exists", () => {
  assert.ok(CONFIG_PATH.endsWith(join(".config", "magpie", "portkey-bedrock", "config.json")));
  const temp = mkdtempSync(join(tmpdir(), "portkey-path-"));
  try {
    const path = join(temp, "config.json");
    const legacy = join(temp, "config.local.json");
    assert.equal(defaultConfigPath(path, legacy), path);
    writeFileSync(legacy, "{}");
    assert.equal(defaultConfigPath(path, legacy), legacy);
    writeFileSync(path, "{}");
    assert.equal(defaultConfigPath(path, legacy), path);
  } finally { rmSync(temp, { recursive: true }); }
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
    // An empty file is fine: no shared settings.
    assert.deepEqual(read({}).headers, {
      "x-portkey-provider": "$PORTKEY_PROVIDER",
      "x-portkey-account-base-url": "$PORTKEY_BASE_URL",
    });
    // models shape
    assert.throws(() => read({}, []), /non-empty array/);
    assert.throws(() => read({}, [42]), /model ID/);
    // configId type
    assert.throws(() => read({ configId: [] }), /configId must be a string/);
    // headers: array, non-string values
    assert.throws(() => read({ headers: [] }), /headers must be an object/);
    assert.throws(() => read({ headers: { "x-ok": 1 } }), /must be a string/);
    // forbidden secret fields other than apiKey
    for (const field of ["api_key", "authToken", "virtualKey"]) {
      assert.throws(() => read({ [field]: "s" }), /secret/);
    }
    // Shared settings join every account's routing templates. baseUrl and
    // provider from an earlier version's file route nothing and are ignored.
    const config = read({ baseUrl: "https://old.example/v1", provider: "old-route", configId: "cfg-1", headers: { "x-custom": "ok" } });
    assert.deepEqual(config.headers, {
      "x-custom": "ok",
      "x-portkey-provider": "$PORTKEY_PROVIDER",
      "x-portkey-account-base-url": "$PORTKEY_BASE_URL",
      "x-portkey-config": "cfg-1",
    });
    // Hidden models: appended by id, override a catalog entry of the same id.
    const extra = read(
      { models: ["us.anthropic.claude-fable-5-2", { id: "model-1", name: "Renamed" }] },
      ["model-1", "model-2"],
    );
    assert.deepEqual(extra.models.map((m) => m.id), ["model-2", "us.anthropic.claude-fable-5-2", "model-1"]);
    assert.equal(extra.models.find((m) => m.id === "model-1")?.name, "Renamed");
    assert.equal(read({ models: [] }).models.length, 1);
    assert.throws(() => read({ models: [42] }), /model ID/);
  } finally { rmSync(temp, { recursive: true }); }
});

test("registered refreshModels lists models through the gateway", async () => {
  let registered: any;
  plugin({ registerProvider: (_id: string, options: unknown) => { registered = options; } } as any);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: ["vendor.live-model-v1:0"] }), { status: 200 })) as any;
  try {
    const merged = await registered.refreshModels(discoveryContext() as any);
    assert.equal(merged.length, noSettings().models.length + 1);
    assert.ok(merged.some((m: any) => m.id === "vendor.live-model-v1:0"));
  } finally {
    globalThis.fetch = original;
  }
});

// ---- multi-account routing and the GUI sign-in form --------------------------------

test("account form credentials decode and the login form asks its three fields", async () => {
  // The form-written credential: env routing values beside the key.
  const form = accountFormOf({
    type: "oauth", access: "pk-form", refresh: "pk-form", expires: 4_102_444_800_000, accountId: "Team A",
    env: { PORTKEY_BASE_URL: "https://gw.a.example/v1", PORTKEY_PROVIDER: "@aws-a" },
  });
  assert.deepEqual(form, { baseUrl: "https://gw.a.example/v1", provider: "@aws-a", apiKey: "pk-form", name: "Team A" });

  // Something else entirely decodes to nothing.
  assert.equal(accountFormOf({ type: "oauth", access: "", refresh: "", expires: 0 }), undefined);

  // The registered oauth method asks its three questions in order and
  // returns the credentials. No URL is ever announced: nothing opens a
  // browser. Placeholders are Portkey's public defaults, never the file's.
  let registered: any;
  plugin({ registerProvider: (_id: string, options: unknown) => { registered = options; } } as any);
  const signIn = async (answers: Record<string, string>) => {
    const asked: Array<{ message: string; placeholder?: string }> = [];
    let announcedUrl: string | undefined;
    const credentials = await registered.oauth.login({
      onPrompt: async (prompt: { message: string; placeholder?: string }) => {
        asked.push(prompt);
        return answers[prompt.message] ?? "";
      },
      onAuth: (info: { url?: string }) => { announcedUrl = info.url; },
      onProgress: () => {}, onDeviceCode: () => {}, onSelect: async () => undefined,
    });
    return { credentials, asked, announcedUrl };
  };
  const first = await signIn({
    "Portkey gateway base URL": "https://gw.form.example/v1",
    "Portkey provider slug (x-portkey-provider)": "@aws-form",
    "Portkey API key": "pk-form-a",
  });
  assert.deepEqual(first.asked, [
    { message: "Portkey gateway base URL", placeholder: "https://api.portkey.ai/v1" },
    { message: "Portkey provider slug (x-portkey-provider)", placeholder: "aws-bedrock" },
    { message: "Portkey API key", placeholder: "pk-…" },
    // The optional name's hint is the name an empty answer gives.
    { message: "Account name (optional, leave empty to use part of the key)", placeholder: "API key pk-f…rm-a" },
  ]);
  assert.equal(first.announcedUrl, undefined);
  // The credential carries the key pi sends per request plus the account's
  // routing env, and never expires into pi's refresh path.
  assert.equal(registered.oauth.getApiKey(first.credentials), "pk-form-a");
  assert.equal(first.credentials.env.PORTKEY_BASE_URL, "https://gw.form.example/v1");
  assert.equal(first.credentials.env.PORTKEY_PROVIDER, "@aws-form");
  assert.ok(first.credentials.expires > Date.now() + 3650 * 24 * 3600 * 1000);
  // No alias given: magpie lists the account by both ends of its key.
  assert.equal(first.credentials.accountId, "API key pk-f…rm-a");

  // A second sign-in right after asks again and saves its own answers:
  // nothing of the first account carries over.
  const second = await signIn({
    "Portkey API key": "pk-form-b",
    "Account name (optional, leave empty to use part of the key)": "  Team B  ",
  });
  assert.equal(second.asked.length, 4);
  assert.equal(second.credentials.accountId, "Team B");
  assert.equal(registered.oauth.getApiKey(second.credentials), "pk-form-b");
  // Empty answers mean the placeholders' public defaults.
  assert.equal(second.credentials.env.PORTKEY_BASE_URL, "https://api.portkey.ai/v1");
  assert.equal(second.credentials.env.PORTKEY_PROVIDER, "aws-bedrock");

  // A missing key or a base URL that isn't one fails the sign-in.
  await assert.rejects(() => signIn({}), /API key is required/);
  await assert.rejects(() => signIn({ "Portkey gateway base URL": "gw.example", "Portkey API key": "pk" }), /http/);
});

test("per-account headers route the request and the base-URL courier is stripped", async () => {
  const captured: { url?: string; init?: RequestInit } = {};
  const stream = createPortkeyStream({
    "x-portkey-provider": "$PORTKEY_PROVIDER",
    "x-portkey-account-base-url": "$PORTKEY_BASE_URL",
  })(model, normalizeContext(context), {
    apiKey: "acct-key",
    headers: { "x-portkey-provider": "@aws-live", "x-portkey-account-base-url": "https://live.example/v1" } as any,
    fetch: async (url, init) => {
      captured.url = String(url); captured.init = init;
      return wireResponse(textEvents());
    },
  });
  const message = await stream.result();
  assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
  // The account's own gateway and route are used…
  assert.equal(captured.url, "https://live.example/v1/model/" + encodeURIComponent(model.id) + "/converse-stream");
  const headers = new Headers(captured.init?.headers);
  assert.equal(headers.get("x-portkey-provider"), "@aws-live");
  // …and the courier header never reaches the wire.
  assert.equal(headers.get("x-portkey-account-base-url"), null);
});

test("template headers resolve against the account env and are never sent unresolved", async () => {
  const seen: Headers[] = [];
  const send = (env?: Record<string, string>) => createPortkeyStream({
    "x-portkey-provider": "$PORTKEY_PROVIDER",
    "x-portkey-config": "fixed",
  })(model, normalizeContext(context), {
    apiKey: "k",
    env: { PORTKEY_BASE_URL: "https://portkey.example/v1", ...env },
    fetch: async (_url: any, init: any) => {
      seen.push(new Headers(init?.headers));
      return wireResponse(textEvents());
    },
  }).result();
  const withEnv = await send({ PORTKEY_PROVIDER: "@aws-env" });
  const withoutEnv = await send();
  assert.equal(withEnv.stopReason, "stop");
  assert.equal(withoutEnv.stopReason, "stop");
  // The account env answers the template; without one the header is left
  // out instead of carrying its own `$VAR` text. Literal values never change.
  assert.equal(seen[0].get("x-portkey-provider"), "@aws-env");
  assert.equal(seen[0].get("x-portkey-config"), "fixed");
  assert.equal(seen[1].get("x-portkey-provider"), null);
  assert.equal(seen[1].get("x-portkey-config"), "fixed");
});

test("cache points follow the model family and cache retention", async () => {
  const capture = async (extra: SimpleStreamOptions = {}, id = model.id) => {
    const captured: any = {};
    const custom = { ...model, id };
    const stream = createPortkeyStream({})(custom, normalizeContext(context), {
      apiKey: "k", headers: accountGateway,
      fetch: async (_url, init) => { captured.body = JSON.parse(init!.body as string); return wireResponse(textEvents()); },
      ...extra,
    });
    await stream.result();
    return captured.body;
  };
  // Default: Claude caches at both checkpoints, 5m TTL.
  const claude = await capture();
  assert.deepEqual(claude.system.at(-1), { cachePoint: { type: "default" } });
  assert.deepEqual(claude.messages.at(-1).content.at(-1), { cachePoint: { type: "default" } });
  // Long retention asks for the one-hour TTL.
  const claudeLong = await capture({ cacheRetention: "long" });
  assert.deepEqual(claudeLong.system.at(-1), { cachePoint: { type: "default", ttl: "1h" } });
  // A non-caching family sends no cachePoint blocks at all.
  const llama = await capture({}, "meta.llama3-3-70b-instruct-v1:0");
  assert.equal(llama.system.at(-1).cachePoint, undefined);
  assert.equal(llama.messages.at(-1).content.at(-1).cachePoint, undefined);
  // And a caching model asked for no cache sends none either.
  const none = await capture({ cacheRetention: "none" });
  assert.equal(none.system.at(-1).cachePoint, undefined);
});

test("streaming tool arguments parse incrementally and stay correct", async () => {
  // A long argument split across many deltas: the old quadratic re-parse
  // would still be correct, this locks in that the incremental parser is.
  const value = JSON.stringify({ q: "x".repeat(512), list: Array.from({ length: 64 }, (_, i) => i) });
  const events: WireEvent[] = [
    ["messageStart", { role: "assistant" }],
    ["contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "call_1", name: "lookup" } } }],
  ];
  for (let i = 0; i < value.length; i += 97) {
    events.push(["contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: value.slice(i, i + 97) } } }]);
  }
  events.push(["contentBlockStop", { contentBlockIndex: 0 }], ...end("tool_use"));
  const { message } = await ask(events);
  assert.equal(message.stopReason, "toolUse", message.errorMessage ?? "");
  const call = message.content[0] as any;
  assert.deepEqual(call.arguments, JSON.parse(value));
});

test("derived account names tell keys apart without showing them", () => {
  // Keys that share a prefix still get different names.
  const a = keyName("Abcd1234567890xyzAAAA");
  const b = keyName("Abcd1234567890xyzBBBB");
  assert.notEqual(a, b);
  assert.equal(a, "API key Abcd…AAAA");
  // The name never carries enough of the key to use it.
  for (const key of ["Abcd1234567890xyzAAAA", "x".repeat(28)]) {
    assert.ok(keyName(key).length - "API key ".length < key.length / 2);
  }
  // A key too short to cut shows none of itself.
  assert.equal(keyName("short"), "API key");
});
