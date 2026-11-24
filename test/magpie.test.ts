import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { frame, textEvents, end, type WireEvent } from "./wire.ts";

const source = process.env.MAGPIE_SOURCE_DIR;
const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("Magpie's actual Bun host: discovery, account keys, Anthropic SSE/JSON, thinking, tools and HTTP errors", { skip: !source, timeout: 60000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "magpie-portkey-host-"));
  let events = textEvents();
  let status = 200;
  const requests: Array<{ headers: any; body: any }> = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    if (req.method === "GET" || raw.length === 0) {
      requests.push({ headers: req.headers, body: null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "vendor.discovered-v1:0", name: "Discovered" }] }));
      return;
    }
    requests.push({ headers: req.headers, body: JSON.parse(raw) });
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json", "retry-after": "7" });
      res.end(JSON.stringify({ type: "throttlingException", message: "Slow down" }));
    } else {
      res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
      res.end(Buffer.concat(events.map(frame)));
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const port = (upstream.address() as { port: number }).port;
  // Routing comes from each account's sign-in form, so the test needs no
  // config file — and never touches the user's own config file.
  writeFileSync(join(temp, "auth.json"), "{}");
  const child = spawn(process.env.BUN_BIN ?? "bun", [join(source!, "internal/plugin/host.js")], {
    cwd: temp,
    env: { ...process.env, DO_NOT_TRACK: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-16000); });
  type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; frames: any[]; timer: ReturnType<typeof setTimeout> };
  const pending = new Map<number, Pending>();
  let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const msg = JSON.parse(line);
    const call = pending.get(msg.id);
    if (!call) return;
    if (msg.event) { call.frames.push(msg); return; }
    clearTimeout(call.timer);
    pending.delete(msg.id);
    if (msg.error) call.reject(new Error(msg.error.message));
    else call.resolve({ result: msg.result, frames: call.frames });
  });
  child.on("exit", (code) => {
    for (const call of pending.values()) {
      clearTimeout(call.timer); call.reject(new Error(`Magpie host exited ${code}: ${stderr}`));
    }
    pending.clear();
  });
  function rpc(method: string, params: unknown = {}): Promise<any> {
    const key = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Magpie ${method} timed out: ${stderr}`)); }, 25000);
      pending.set(key, { resolve, reject, frames: [], timer });
      child.stdin.write(JSON.stringify({ id: key, method, params }) + "\n");
    });
  }
  const model = "us.anthropic.claude-opus-4-8";
  async function ask(body: Record<string, unknown> = {}, account?: string) {
    const response = await rpc("fetch", {
      provider: "portkey-bedrock", model, account, npm: "@ai-sdk/anthropic", url: "http://pi.magpie/v1/messages", method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ model, max_tokens: 1000, system: "System prompt", messages: [{ role: "user", content: "Hi" }], stream: true, ...body })).toString("base64"),
    });
    const head = response.frames.find((f: any) => f.event === "head");
    const data = Buffer.concat(response.frames.filter((f: any) => f.event === "chunk").map((f: any) => Buffer.from(f.data, "base64"))).toString();
    return { head, data };
  }
  // Signs an account in through the provider's GUI form, replaying exactly
  // what magpie's front end does (app.js startPluginSignIn / pluginAnswer):
  // every answer is one `prompt` round carrying the answer, immediately
  // followed by a round with the accumulated inputs only — after the last
  // answer too, before it authorizes. The form must neither ask again nor
  // loop back to its first field; authorize then finishes the login with no
  // URL (nothing opens) and the callback saves it.
  //
  // `pick` answers the form's choice, when it offers one (a sign-in while an
  // account is already signed in): the label of the option chosen, as the
  // dialog's button gives it. `expected` is the questions asked, in order.
  // `renamed` is the answer to the name asked over, when the name given is
  // one an account already has.
  async function signInForm(
    account: string | undefined, baseUrl: string, provider: string, apiKey: string, name = "",
    pick?: string, expected = ["gateway", "provider", "API", "name"], renamed?: string,
  ) {
    let inputs: Record<string, string> = {};
    const asked: string[] = [];
    // startPluginSignIn: a round with the inputs so far
    let r = (await rpc("prompt", { provider: "portkey-bedrock", method: 0, inputs })).result;
    while (r?.prompt) {
      const q = r.prompt;
      if (q.type === "select") {
        // renderPluginAsk: a choice is buttons; the one clicked is answered
        assert.equal(q.message, "Add an account, or update one you have", JSON.stringify(q));
        const option = q.options.find((o: any) => o.label === pick);
        assert.ok(option, `no option "${pick}" among ${q.options.map((o: any) => o.label).join(", ")}`);
        // pluginAnswer: the dialog's button gives the option's value, and
        // the host's plugin-signin/prompt puts it in the inputs
        // (plugins.go), which the next round carries.
        inputs = { ...inputs, [q.key]: option.value };
        r = (await rpc("prompt", { provider: "portkey-bedrock", method: 0, inputs })).result;
        continue;
      }
      asked.push(q.message);
      if (asked.length > expected.length) throw new Error(`the form asked again: ${asked.join(" / ")}`);
      const value = /base URL/i.test(q.message) ? baseUrl
        : /provider slug/i.test(q.message) ? provider
          : /API key/i.test(q.message) ? apiKey
            : /already named/i.test(q.message) ? (renamed ?? "")
              : name;
      // pluginAnswer: the answer, as the host's plugin-signin/prompt adds it
      inputs = { ...inputs, [q.key]: value };
      await rpc("prompt", { provider: "portkey-bedrock", method: 0, inputs });
      // …then startPluginSignIn again with what it gave back
      r = (await rpc("prompt", { provider: "portkey-bedrock", method: 0, inputs })).result;
    }
    assert.deepEqual(asked.map((m) => m.split(" ")[1]), expected, asked.join(" / "));
    const authorize = await rpc("authorize", { provider: "portkey-bedrock", method: 0, inputs, ...(account ? { account } : {}) });
    // Older hosts answer without `ok`; a session is what both versions give.
    assert.ok(authorize.result.session, JSON.stringify(authorize.result));
    // The finish is automatic: nothing opens, nothing is pasted.
    assert.equal(authorize.result.method, "auto");
    assert.equal(authorize.result.url, "");
    const done = await rpc("callback", { session: authorize.result.session });
    assert.equal(done.result.ok, true, JSON.stringify(done.result));
    return done.result.account as string;
  }
  try {
    const init = await rpc("init", { directory: temp, authPath: join(temp, "auth.json"), piPath: join(source!, "internal/plugin/pi.js"), plugins: [{ spec: root, target: root }] });
    assert.equal(init.result.plugins[0].error, undefined, init.result.plugins[0].error ?? stderr);
    assert.deepEqual(init.result.plugins[0].provides, ["portkey-bedrock"]);
    const { result: providers } = await rpc("providers");
    assert.equal(providers[0].models.length, 15);
    assert.ok(providers[0].models.find((m: any) => m.id === model).variants.includes("max"));
    const first = await signInForm(undefined, `http://127.0.0.1:${port}/v1`, "@aws-test", "first-test-key", "Team A");
    assert.equal(first, "portkey-bedrock");
    // The signed-in account triggers the model refresh: the gateway's list is
    // merged into the catalog.
    const listed = await rpc("providers");
    assert.equal(listed.result[0].models.length, 16, stderr);
    assert.ok(listed.result[0].models.some((m: any) => m.id === "vendor.discovered-v1:0"));
    const listedRequest = requests.find((r) => r.body === null);
    assert.ok(listedRequest, "the gateway was asked for its model list");
    assert.equal(listedRequest.headers["x-portkey-api-key"], "first-test-key");
    const stream = await ask();
    assert.equal(stream.head.status, 200, stream.data);
    assert.match(stream.head.headers["content-type"], /text\/event-stream/);
    assert.match(stream.data, /Hello 世界 🐦/);
    assert.match(stream.data, /message_stop/);
    assert.match(stream.data, /cache_read_input_tokens":3/);
    assert.match(stream.data, /cache_creation_input_tokens":2/);
    assert.equal(requests.at(-1)!.headers["authorization"], "Bearer first-test-key");
    assert.equal(requests.at(-1)!.headers["x-portkey-api-key"], "first-test-key");
    assert.equal(requests.at(-1)!.body.system[0].text, "System prompt");
    assert.deepEqual(requests.at(-1)!.body.system.at(-1), { cachePoint: { type: "default" } });

    const json = await ask({ stream: false });
    assert.equal(json.head.status, 200, json.data);
    assert.equal(JSON.parse(json.data).content[0].text, "Hello 世界 🐦");

    events = [
      ["messageStart", { role: "assistant" }],
      ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "Consider this" } } }],
      ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig-1" } } }],
      ["contentBlockStop", { contentBlockIndex: 0 }],
      ["contentBlockStart", { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call_1", name: "lookup" } } }],
      ["contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '{"q":"value"}' } } }],
      ["contentBlockStop", { contentBlockIndex: 1 }], ...end("tool_use"),
    ] satisfies WireEvent[];
    const tools = await ask({ thinking: { type: "adaptive" }, output_config: { effort: "max" }, tools: [{ name: "lookup", description: "Look up", input_schema: { type: "object", properties: { q: { type: "string" } } } }] });
    assert.equal(tools.head.status, 200, tools.data);
    assert.match(tools.data, /signature_delta/);
    assert.match(tools.data, /sig-1/);
    assert.match(tools.data, /tool_use/);
    assert.match(tools.data, /input_json_delta/);
    assert.equal(requests.at(-1)!.body.toolConfig.tools[0].toolSpec.name, "lookup");
    assert.equal(requests.at(-1)!.body.additionalModelRequestFields.output_config.effort, "max");

    // A second account, through the same form, routed to its own gateway
    // and provider slug: requests for it leave with its key and route even
    // while the first stays signed in.
    const secondKey = await signInForm("new", `http://127.0.0.1:${port}/v1`, "@aws-second", "second-test-key", "", "Add a new account");
    events = textEvents();
    const secondAnswer = await ask({}, secondKey);
    assert.equal(secondAnswer.head.status, 200, secondAnswer.data);
    assert.equal(requests.at(-1)!.headers["x-portkey-api-key"], "second-test-key");
    assert.equal(requests.at(-1)!.headers["x-portkey-provider"], "@aws-second");

    status = 429;
    const failure = await ask();
    assert.equal(failure.head.status, 429, failure.data);
    assert.equal(failure.head.headers["retry-after"], "7");
    assert.match(failure.data, /Slow down/);
    const auth = JSON.parse(readFileSync(join(temp, "auth.json"), "utf8"));
    // The form's sign-ins are stored as oauth credentials carrying the key
    // and the account's routing env, one entry per account.
    assert.equal(auth["portkey-bedrock"].access, "first-test-key");
    assert.equal(auth[secondKey].access, "second-test-key");
    assert.equal(auth[secondKey].env.PORTKEY_PROVIDER, "@aws-second");
    assert.ok(auth[secondKey].expires > Date.now() + 3650 * 24 * 3600 * 1000);

    // Account names, as magpie lists them: the alias given, else both ends
    // of the key.
    assert.equal(auth["portkey-bedrock"].accountId, "Team A");
    assert.equal(auth[secondKey].accountId, "API key seco…-key");
    const named = (await rpc("providers")).result[0].accounts;
    assert.deepEqual(
      named.map((a: any) => a.accountId).sort(),
      ["API key seco…-key", "Team A"],
    );

    // Updating an account: the host has listed the models of both accounts
    // since each signed in, handing the plugin their credentials, so a new
    // sign-in offers them by name. Choosing one asks for its gateway, route
    // and key under that name — never a new name — and magpie keeps it the
    // same account: nothing is added, the name stays, what was typed
    // replaces what the account had.
    const accounts = Object.keys(auth).filter((k) => k.startsWith("portkey-bedrock"));
    const updated = await signInForm("new", `http://127.0.0.1:${port}/v1`, "@aws-third-rerouted", "fourth-test-key", "", 'Update "Team A"',
      ["gateway", "provider", "API"]);
    assert.equal(updated, "portkey-bedrock");
    events = textEvents();
    status = 200;
    const asUpdated = await ask({}, updated);
    assert.equal(asUpdated.head.status, 200, asUpdated.data);
    const final = JSON.parse(readFileSync(join(temp, "auth.json"), "utf8"));
    assert.deepEqual(Object.keys(final).filter((k) => k.startsWith("portkey-bedrock")), accounts);
    assert.equal(final["portkey-bedrock"].accountId, "Team A");
    assert.equal(final["portkey-bedrock"].access, "fourth-test-key");
    assert.equal(final["portkey-bedrock"].env.PORTKEY_PROVIDER, "@aws-third-rerouted");
    // The request went out with the account's new key and route.
    assert.equal(requests.at(-1)!.headers["x-portkey-api-key"], "fourth-test-key");
    assert.equal(requests.at(-1)!.headers["x-portkey-provider"], "@aws-third-rerouted");
    // The other account is as it was.
    assert.equal(final[secondKey].access, "second-test-key");
    assert.equal(final[secondKey].env.PORTKEY_PROVIDER, "@aws-second");

    // Adding an account under a name one already has would replace that
    // account — the name is the account — so adding asks for another name
    // instead, and the account is added under it.
    const renamed = await signInForm("new", `http://127.0.0.1:${port}/v1`, "@aws-fourth", "fifth-test-key", "Team A", "Add a new account",
      ["gateway", "provider", "API", "name", "account"], "Team D");
    assert.equal(renamed.startsWith("portkey-bedrock#"), true, renamed);
    const afterAdded = JSON.parse(readFileSync(join(temp, "auth.json"), "utf8"));
    assert.equal(Object.keys(afterAdded).filter((k) => k.startsWith("portkey-bedrock")).length, accounts.length + 1);
    assert.equal(afterAdded[renamed].accountId, "Team D");
    assert.equal(afterAdded[renamed].access, "fifth-test-key");
    // "Team A" is still the account it was, with the key its update gave it.
    assert.equal(afterAdded["portkey-bedrock"].access, "fourth-test-key");
    assert.equal(afterAdded["portkey-bedrock"].env.PORTKEY_PROVIDER, "@aws-third-rerouted");
  } finally {
    for (const call of pending.values()) clearTimeout(call.timer);
    child.kill();
    lines.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true });
  }
});
