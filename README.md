# magpie-portkey-bedrock

A [magpie](https://github.com/yetone/magpie) provider for AWS Bedrock models through [Portkey](https://portkey.ai). It runs the real [`@ai-sdk/amazon-bedrock`](https://www.npmjs.com/package/@ai-sdk/amazon-bedrock) transport (native Bedrock Converse protocol) and works in both magpie (via magpie's pi package bridge) and [pi](https://github.com/earendil-works/pi).

The provider id is **`portkey-bedrock`**. Its models are available to every agent connected to magpie.

中文文档：[README.zh-CN.md](./README.zh-CN.md)

## Features

- Native Bedrock Converse streaming through `@ai-sdk/amazon-bedrock`.
- Dynamic model discovery: once an account is signed in, the provider asks the gateway for its model list (`GET /v1/models`) and merges what your account actually serves into the catalog; failures keep the catalog.
- Text, vision, streamed tool arguments and tool results, including image results and failed tools.
- Reasoning levels, including `xhigh` and `max` where declared; signed and redacted reasoning survives replay.
- Two explicit prompt-cache checkpoints (system prompt and final conversation message) — Bedrock only caches at explicit checkpoints, so this is what makes prompt caching actually work on Anthropic models.
- Input, output, cache-read and cache-write token accounting with catalog prices.
- Cancellation, request timeouts, payload inspection and response hooks.
- HTTP status and retry headers forwarded to magpie for its routing and failover logic.

## Install in magpie

```sh
# npm (after publishing)
magpie plugin add @jack-yang/magpie-portkey-bedrock

# or GitHub
magpie plugin add github:yangwudong/magpie-portkey-bedrock

# or a local checkout
git clone https://github.com/yangwudong/magpie-portkey-bedrock.git
magpie plugin add "$PWD/magpie-portkey-bedrock"
```

Then sign in with your **Portkey gateway API key** (`magpie plugin login portkey-bedrock`, or the Providers page). magpie stores it in `plugin-auth.json` under its configuration directory and supplies the account's key for each request. Multiple accounts are supported.

Select **Providers → Portkey Bedrock**, then choose a `portkey-bedrock/…` model for your agent:

```sh
magpie claude portkey-bedrock/us.anthropic.claude-opus-5-5
```

magpie installs Bun, the plugin's runtime dependencies and its pi runtime when needed. To reload edits in the app, turn the plugin off and on in Plugins.

## Configure your gateway

The package ships this public default in `config.json`:

```json
{
  "baseUrl": "https://api.portkey.ai/v1",
  "apiKeyEnv": "PORTKEY_API_KEY",
  "provider": "aws-bedrock",
  "headers": {}
}
```

Create `config.local.json` beside `index.ts` to override it. That file is ignored by git and excluded from the npm package. You can also set `PORTKEY_CONFIG_PATH` to an absolute configuration file path in magpie's launch environment. Loading order is `PORTKEY_CONFIG_PATH`, then `config.local.json`, then `config.json`; each selects a complete configuration file.

- `baseUrl`: your Portkey gateway's Bedrock-compatible base URL. Requests go to `/model/{encoded model id}/converse-stream`.
- `apiKeyEnv`: environment fallback when pi has no saved key. In magpie, use API-key sign-in so the menu bar app does not need your shell environment.
- `provider`: optional `x-portkey-provider` route. Set this to your configured Portkey AWS provider slug, such as `@your-aws-provider`, when using a provider integration.
- `configId`: optional `x-portkey-config` configuration id. Use a route or configuration with AWS credentials already configured in Portkey.
- `headers`: additional non-secret gateway headers.

Unset `baseUrl`, `provider` and `configId` fall back to the `PORTKEY_BASE_URL`, `PORTKEY_PROVIDER` and `PORTKEY_CONFIG_ID` environment variables; config-file values win. This matters for updates: reinstalling an npm/GitHub plugin replaces its directory, so a `config.local.json` created inside it is lost — environment variables (or `PORTKEY_CONFIG_PATH` pointing outside the package) survive. If you install from a local folder (`magpie plugin add /path/to/checkout`), `config.local.json` lives in your own checkout and is never touched.

Credentials belong in magpie's sign-in or the environment. The config reader rejects API keys and secret headers embedded in JSON (`apiKey`, `virtualKey`, `authorization`, `*-api-key`, `token`, `secret`, `cookie`). Requests send the selected account's key as both `Authorization: Bearer …` and `x-portkey-api-key`. Restart the plugin after configuration changes.

## Models

`models.json` is an editable catalog. Set `PORTKEY_MODELS_PATH` to an absolute file path to keep it outside the package. Entries may be model ID strings or objects with `id`, `name`, `reasoning`, `thinkingLevelMap`, `input`, `contextWindow`, `maxTokens` and `cost`. Prices are USD per million tokens, with separate `input`, `output`, `cacheRead` and `cacheWrite` values.

The included catalog covers the current Bedrock line-up plus common Amazon / DeepSeek / Meta / Mistral models. Availability, limits and prices depend on your AWS account and Portkey route; update the catalog to match them. When an account is signed in, magpie refreshes the list through the provider's `refreshModels`: the gateway's `/models` response is merged with the catalog — catalog entries keep their metadata, unknown ids are added with conservative defaults.

| Model id | Context | Max output |
| --- | ---: | ---: |
| `us.anthropic.claude-haiku-4-5-20251001-v1:0` | 200,000 | 64,000 |
| `us.anthropic.claude-opus-4-8` | 1,000,000 | 64,000 |
| `us.anthropic.claude-opus-5` | 1,000,000 | 64,000 |
| `us.anthropic.claude-opus-5-5` | 1,000,000 | 128,000 |
| `us.anthropic.claude-sonnet-5` | 1,000,000 | 64,000 |
| `us.anthropic.claude-sonnet-5-5` | 1,000,000 | 128,000 |
| `anthropic.claude-sonnet-4-5-20250929-v1:0` | 200,000 | 64,000 |
| `anthropic.claude-3-5-haiku-20241022-v1:0` | 200,000 | 8,192 |
| `amazon.nova-premier-v1:0` | 1,000,000 | 32,000 |
| `amazon.nova-pro-v1:0` | 300,000 | 6,400 |
| `amazon.nova-lite-v1:0` | 300,000 | 6,400 |
| `amazon.nova-micro-v1:0` | 128,000 | 4,096 |
| `deepseek.r1-v1:0` | 128,000 | 8,192 |
| `meta.llama3-3-70b-instruct-v1:0` | 128,000 | 8,192 |
| `mistral.pixtral-large-2502-v1:0` | 128,000 | 8,192 |

## Use in pi

From a local checkout:

```sh
pi -e ./index.ts
```

Use `/login` for `portkey-bedrock`, or export the variable named by `apiKeyEnv`. Enable only one copy of this provider per session.

## OpenCode plugin vs pi extension

This package is a **pi extension**: the real `@ai-sdk/amazon-bedrock` SDK runs here and speaks native Bedrock Converse, which is what enables the prompt-cache checkpoints, reasoning-effort mapping and signed-thinking replay above. A lighter alternative is an OpenCode provider plugin (magpie's gateway converts to chat completions and a tiny `fetch` adds the gateway headers) — simpler, but generic chat-completions traffic cannot carry Bedrock-specific features like explicit cache points. The two approaches use different provider ids and can be installed side by side.

## Development and verification

Tested with pi 1.2.0 and magpie's Bun plugin host.

```sh
bun install --ignore-scripts
bun run check   # typecheck + tests
```

Tests use real AWS event-stream frames against the Bedrock SDK to verify authentication, conversion, tools, images, reasoning, cache markers, usage, Unicode chunk boundaries, aborts and failures. No live credentials are used.

For integration coverage:

```sh
git clone --depth 1 https://github.com/yetone/magpie.git /tmp/magpie
MAGPIE_SOURCE_DIR=/tmp/magpie bun test test/magpie.test.ts
```

This starts magpie's actual `internal/plugin/host.js` under Bun in a temporary configuration directory and sends Anthropic requests through the pi bridge. Without `MAGPIE_SOURCE_DIR`, that integration test is skipped. Live Portkey access is not part of the automated tests.

`npm publish` creates an installable archive containing the provider, public defaults, catalog and documentation. Dependencies, tests and local overrides are excluded.

## Marketplace

Tag the repository `magpie-plugin` for automatic discovery under **Plugins → Discover → Unofficial, on GitHub**. For the curated list, PR an entry into [magpie-community/plugins](https://github.com/magpie-community/plugins)' `registry.json` after publishing to npm:

```json
{
  "package": "@jack-yang/magpie-portkey-bedrock",
  "name": "Portkey Bedrock",
  "providers": ["portkey-bedrock"],
  "summary": {
    "en": "AWS Bedrock through Portkey, with tools, vision, reasoning, prompt caching and dynamic model discovery.",
    "zh": "通过 Portkey 使用 AWS Bedrock，支持工具调用、图像、推理、提示词缓存与动态模型发现。"
  }
}
```

## Credits

Configuration layering, secret hygiene and the streaming core are based on [TianZuo555/magpie-portkey](https://github.com/TianZuo555/magpie-portkey) (MIT). This package uses a different provider id (`portkey-bedrock`), so the two can be installed side by side.

## License

MIT
