# magpie-portkey-bedrock

[magpie](https://github.com/yetone/magpie) 的供应商插件：通过 [Portkey](https://portkey.ai) 使用 AWS Bedrock 模型。它真正运行 [`@ai-sdk/amazon-bedrock`](https://www.npmjs.com/package/@ai-sdk/amazon-bedrock)（原生 Bedrock Converse 协议），在 magpie（经 magpie 的 pi 包桥接）和 [pi](https://github.com/earendil-works/pi) 里都能用。

供应商 id 是 **`portkey-bedrock`**。它的模型对 magpie 连接的所有 agent 可用。

English documentation: [README.md](./README.md)

## 功能

- 经 `@ai-sdk/amazon-bedrock` 的原生 Bedrock Converse 流式输出。
- 动态模型发现：账号登录后，provider 会请求网关的模型列表（`GET /v1/models`），把你的账号实际可用的模型合并进目录；失败时保留目录。
- 文本、视觉、流式工具参数与工具结果，包括图片结果和失败的工具。
- 推理强度档位（声明处含 `xhigh`、`max`）；带签名和已脱敏的思考在回放时保留。
- 两个显式 prompt-cache 检查点（系统提示词和最后一条对话消息）——Bedrock 只在显式检查点写缓存，这正是让 Anthropic 模型的 prompt caching 真正生效的机制。
- input/output/cache-read/cache-write token 用量统计，按目录价计算成本。
- 取消、请求超时、载荷检查和响应钩子。
- HTTP 状态码和重试头转发给 magpie，接入它的路由与故障切换。

## 在 magpie 里安装

```sh
# npm（发布后）
magpie plugin add @jack-yang/magpie-portkey-bedrock

# 或 GitHub
magpie plugin add github:yangwudong/magpie-portkey-bedrock

# 或本地检出
git clone https://github.com/yangwudong/magpie-portkey-bedrock.git
magpie plugin add "$PWD/magpie-portkey-bedrock"
```

然后用你的 **Portkey 网关 API key** 登录（`magpie plugin login portkey-bedrock`，或在应用里 Providers 页点登录）。magpie 把它存在配置目录的 `plugin-auth.json`，每次请求带上账号的 key。支持多账号。

在 **Providers → Portkey Bedrock** 里展开，给 agent 选 `portkey-bedrock/…` 模型：

```sh
magpie claude portkey-bedrock/us.anthropic.claude-opus-5-5
```

magpie 会按需安装 Bun、插件的运行时依赖和它的 pi 运行时。在应用里改了代码，把插件关掉再打开即可重新加载。

## 配置网关

包里带的公共默认 `config.json`：

```json
{
  "baseUrl": "https://api.portkey.ai/v1",
  "provider": "aws-bedrock",
  "headers": {}
}
```

在 `index.ts` 旁边建 `config.local.json` 覆盖它。该文件被 git 忽略，也不会进 npm 包。加载顺序：`config.local.json` → `config.json`，每次选定一份完整配置。**不使用任何环境变量**——路由来自这两个文件，凭证来自 magpie 的登录。

- `baseUrl`：你的 Portkey 网关的 Bedrock 兼容地址。请求发往 `/model/{编码后的模型 id}/converse-stream`。
- `provider`：可选的 `x-portkey-provider` 路由。用 provider 集成时填你配置的 Portkey AWS provider slug，例如 `@your-aws-provider`。
- `configId`：可选的 `x-portkey-config` 配置 id。使用已在 Portkey 配好 AWS 凭证的路由或配置。
- `headers`：额外的非敏感网关头。

这关系到插件更新：重装 npm/GitHub 插件会替换它的目录，装在里面的 `config.local.json` 会丢，需要重新建一份。用本地文件夹安装（`magpie plugin add /path/to/checkout`）时，`config.local.json` 在你自己的检出里，永远不会被动到。

凭证只放在 magpie 的登录里，绝不进配置文件。配置读取器会拒绝嵌在 JSON 里的 API key 和敏感头（`apiKey`、`virtualKey`、`authorization`、`*-api-key`、`token`、`secret`、`cookie`）。请求同时以 `Authorization: Bearer …` 和 `x-portkey-api-key` 携带所选账号的 key。改完配置重启插件生效。

## 模型

`models.json` 是可编辑的目录。条目可以是模型 ID 字符串，或带 `id`、`name`、`reasoning`、`thinkingLevelMap`、`input`、`contextWindow`、`maxTokens`、`cost` 的对象。价格是 USD / 百万 token，`input`、`output`、`cacheRead`、`cacheWrite` 分列。

内置目录覆盖当前 Bedrock 主力型号，外加常见的 Amazon / DeepSeek / Meta / Mistral 模型。可用性、上限和价格取决于你的 AWS 账号和 Portkey 路由，请按需调整目录。账号登录后，magpie 会通过 provider 的 `refreshModels` 刷新列表：网关 `/models` 的响应与目录合并——目录条目保留自己的元数据，未知 id 以保守默认值加入。

| 名称 | 模型 id | 上下文 | 最大输出 |
| --- | --- | ---: | ---: |
| Claude Haiku 4.5 | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | 200,000 | 64,000 |
| Claude Opus 4.8 | `us.anthropic.claude-opus-4-8` | 1,000,000 | 64,000 |
| Claude Opus 5 | `us.anthropic.claude-opus-5` | 1,000,000 | 64,000 |
| Claude Opus 5.5 | `us.anthropic.claude-opus-5-5` | 1,000,000 | 128,000 |
| Claude Sonnet 5 | `us.anthropic.claude-sonnet-5` | 1,000,000 | 64,000 |
| Claude Sonnet 5.5 | `us.anthropic.claude-sonnet-5-5` | 1,000,000 | 128,000 |
| Claude Sonnet 4.5 | `anthropic.claude-sonnet-4-5-20250929-v1:0` | 200,000 | 64,000 |
| Claude 3.5 Haiku | `anthropic.claude-3-5-haiku-20241022-v1:0` | 200,000 | 8,192 |
| Nova Premier | `amazon.nova-premier-v1:0` | 1,000,000 | 32,000 |
| Nova Pro | `amazon.nova-pro-v1:0` | 300,000 | 6,400 |
| Nova Lite | `amazon.nova-lite-v1:0` | 300,000 | 6,400 |
| Nova Micro | `amazon.nova-micro-v1:0` | 128,000 | 4,096 |
| DeepSeek R1 | `deepseek.r1-v1:0` | 128,000 | 8,192 |
| Llama 3.3 70B | `meta.llama3-3-70b-instruct-v1:0` | 128,000 | 8,192 |
| Pixtral Large | `mistral.pixtral-large-2502-v1:0` | 128,000 | 8,192 |

## 在 pi 里使用

本地检出后：

```sh
pi -e ./index.ts
```

用 `/login` 登录 `portkey-bedrock`，或导出 `apiKeyEnv` 指定的环境变量。同一会话只启用一份本 provider。

## OpenCode 插件 vs pi 扩展

本包是 **pi 扩展**：真正的 `@ai-sdk/amazon-bedrock` SDK 在这里运行、讲原生 Bedrock Converse，上面的 prompt-cache 检查点、推理强度映射、签名思考回放都因此而来。更轻的替代是 OpenCode 供应商插件（magpie 网关转成 chat completions，一个小 `fetch` 补网关头）——更简单，但通用 chat 流量带不了显式 cachePoint 这类 Bedrock 专属特性。两种方式 provider id 不同，可以同时安装。

## 开发与验证

在 pi 1.2.0 和 magpie 的 Bun 插件宿主上测试。

```sh
bun install --ignore-scripts
bun run check   # typecheck + 测试
```

测试用真实的 AWS event-stream 帧对 Bedrock SDK 验证认证、转换、工具、图片、推理、缓存标记、用量、Unicode 块边界、取消和失败。不使用真实凭证。

集成覆盖：

```sh
git clone --depth 1 https://github.com/yetone/magpie.git /tmp/magpie
MAGPIE_SOURCE_DIR=/tmp/magpie bun test test/magpie.test.ts
```

它会在临时配置目录里用 Bun 启动 magpie 真实的 `internal/plugin/host.js`，并经 pi 桥发送 Anthropic 请求。没有 `MAGPIE_SOURCE_DIR` 时该集成测试跳过。自动化测试不访问真实的 Portkey。

`npm publish` 产出的安装包只含 provider、公共默认、目录和文档；依赖、测试和本地覆盖被排除。

## 上架

仓库打上 `magpie-plugin` topic 即可出现在 **插件 → 发现 → 非官方插件 · GitHub**。想进精选列表，发布 npm 后向 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 `registry.json` 提 PR：

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

## 致谢

配置分层、密钥卫生和流式核心基于 [TianZuo555/magpie-portkey](https://github.com/TianZuo555/magpie-portkey)（MIT）。本包使用不同的 provider id（`portkey-bedrock`），两者可以同时安装。

## License

MIT
