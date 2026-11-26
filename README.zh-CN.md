# magpie-portkey-bedrock

[magpie](https://github.com/yetone/magpie) 的供应商插件：通过 [Portkey](https://portkey.ai) 使用 AWS Bedrock 模型。它真正运行 [`@ai-sdk/amazon-bedrock`](https://www.npmjs.com/package/@ai-sdk/amazon-bedrock)（原生 Bedrock Converse 协议），在 magpie（经 magpie 的 pi 包桥接）和 [pi](https://github.com/earendil-works/pi) 里都能用。

供应商 id 是 **`portkey-bedrock`**。它的模型对 magpie 连接的所有 agent 可用。

English documentation: [README.md](./README.md)

> [!IMPORTANT]
> **从 1.2.x 及更早版本升级：请重新登录所有账号。** 每个账号的网关、路由和名称现在都来自登录表单，配置文件不再决定路由。
>
> 1. **登出所有已有的 Portkey Bedrock 账号**（Providers → Portkey Bedrock）。旧版本的账号只有 key、没有网关，它的请求会以 `Provider is not configured` 失败。这些请求不会发出，key 不会离开你的机器。
> 2. **用表单重新登录**：网关地址、provider slug、API key，以及选填的名称。
> 3. **删除 `index.ts` 旁的 `config.local.json`**，如果里面只有 `baseUrl` 和 `provider`。它们现在会被忽略；只有 `configId` 和额外的 `headers` 仍然生效（见[配置网关](#配置网关)）。

## 功能

- 经 `@ai-sdk/amazon-bedrock` 的原生 Bedrock Converse 流式输出。
- GUI 登录表单：**网关地址、Portkey provider slug、API key**，外加选填的账号名称——无需改配置文件、无需浏览器。每个账号路由到自己的网关。
- 多账号：每个已登录账号自带 key、网关地址和 provider 路由；magpie 按账号做轮转、故障切换和限流。
- 动态模型发现：账号登录后，provider 会请求**该账号网关**的模型列表（`GET /v1/models`），把账号实际可用的模型合并进目录；失败时保留目录。
- 文本、视觉、流式工具参数与工具结果，包括图片结果和失败的工具。工具参数按增量解析——耗时与流长度线性相关，而非平方级。
- 推理强度档位（声明处含 `xhigh`、`max`）；带签名和已脱敏的思考在回放时保留。思考以 `display: summarized` 流式输出，首个 token 在模型推理时即可到达，而不是等整个推理结束。
- prompt-cache 检查点按模型家族下发（仅 Claude 与 Nova——其余 Bedrock 家族会忽略或拒绝 `cachePoint`），支持 `cacheRetention`，包括 Bedrock 的一小时 TTL（`long`）。
- input/output/cache-read/cache-write token 用量统计，按目录价计算成本。
- 取消、请求超时、载荷检查和响应钩子。
- HTTP 状态码和重试头转发给 magpie，接入它的路由与故障切换。
- Portkey 拒绝请求时，报错会用它自己的话说明原因和该改什么：预算耗尽、key 缺少 scope、AWS 主体缺少 IAM 权限、组织只接受保存好的 provider 或配置（`inline_…_blocked`），或者组织的护栏要求记录日志（`446`）。报错里带有这次请求的 Portkey trace id。
- 可能会好转的失败（`429`、`408`、`5xx`）会在同一个账号上重发，这样账号的提示词缓存还能再读到，而不用换个账号重新写一遍。

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

然后用你的 **Portkey 网关账号**登录（在应用里 Providers 页点登录，或 `magpie plugin login portkey-bedrock`）。登录表单依次提问，答完最后一项就保存账号——不开浏览器，也没有别的确认步骤：

1. **网关地址（Base URL）**——该账号的 Portkey 网关 Bedrock 兼容地址。请求发往 `/model/{编码后的模型 id}/converse-stream`。
2. **Provider slug**——该账号的 `x-portkey-provider` 路由：你在 Portkey Model Catalog 里那个 Bedrock provider 的 slug，写成 `@your-bedrock-provider`。必填。
3. **API key**——该账号的 Portkey 网关 key。
4. **账号名称**（选填）——magpie 列表里显示的名字。留空则用 key 的首尾各四位命名，形如 `API key AbCd…Yz12`，key 的其余部分不会显示。

名称即账号身份：用一个已有账号的名称再次登录，会更新那个账号（换 key、网关或路由），而不是新增一个。请给每个账号起不同的名字。

网关地址留空即 Portkey 的公共网关 `https://api.portkey.ai/v1`。slug 没有默认值：它指的是你自己 Model Catalog 里的 provider。提示永远不会显示你自己的配置。magpie 把每次登录存进配置目录的 `plugin-auth.json`。每多一个账号就再登录一次：各账号保留自己的 key、网关和 provider 路由，magpie 的路由、故障切换和账号限额按账号生效。请求同时以 `Authorization: Bearer …` 和 `x-portkey-api-key` 携带所选账号的 key。

在 **Providers → Portkey Bedrock** 里展开，给 agent 选 `portkey-bedrock/…` 模型：

```sh
magpie claude portkey-bedrock/us.anthropic.claude-opus-5-5
```

magpie 会按需安装 Bun、插件的运行时依赖和它的 pi 运行时。在应用里改了代码，把插件关掉再打开即可重新加载。

## 配置网关

无需任何配置：每个账号的网关和路由都来自它的登录表单，包里也不带配置文件。

### 三个开关

有三项设置对所有账号生效，可以在两个地方设置：**magpie 的 Options 里设了的，优先于配置文件；配置文件优先于默认值。** `log` 和 `cacheTtl1h` 默认关，`retry` 默认 `2`。每一项为什么是这个默认值、背后的 Portkey 行为是什么，见 [docs/portkey-reference.zh-CN.md](docs/portkey-reference.zh-CN.md)。

**在 magpie 里：插件 → Portkey Bedrock 那一行 → Options。** 会打开一个带这三个开关的 JSON 框，改完保存，magpie 会重启插件。不用打开任何文件，也不用找路径。

**在配置文件里**（纯 pi，或者想手写）：`~/.config/magpie/portkey-bedrock/config.json`。它在已安装插件目录之外，更新插件不会动它。旧版本放在 `index.ts` 旁的 `config.local.json` 在新文件不存在时仍会读取；请把它挪过去，因为更新插件可能会删掉它：

```json
{
  "configId": "pc-your-config",
  "log": false,
  "retry": 2,
  "cacheTtl1h": false,
  "headers": { "x-portkey-trace-id": "magpie" }
}
```

- `log`：是否允许 Portkey 把请求和响应的**内容**存进它的日志。**默认关。** 关闭时每个请求都带 `x-portkey-debug: false`（Portkey 的 "DO NOT TRACK"）：网关仍记录 token、费用和延迟，但不存你的 prompt 和回复。打开后 Portkey 会保存完整的请求和响应内容。如果你在 `headers` 里自己写了 `x-portkey-debug`，以你的为准。

  > [!NOTE]
  > Portkey 的文档只针对它的 `/v1/chat/completions` 路由描述了这个头；本 provider 在 `/model/{id}/converse-stream` 上同样发送它。托管网关在这条路由上是否遵守，文档没有说明：启用 provider 后请在 Portkey 的 Logs 页面查看一条请求确认；只有在你接受完整内容被保存时才打开 `log`。这个开关不会去掉用量记录（token、费用、延迟），只去掉请求和响应内容。
- `retry`：Bedrock 返回 `429`、`408` 或 `5xx` 时，本 provider **在同一个账号上**再发几次，范围 `0` 到 `5`。**默认 `2`。** 留在同一个账号上，它的提示词缓存就还在；换成 magpie 故障切换到别的账号，那个账号没有缓存，要重新花写入的钱。代价是一直失败的请求最多多等 3 秒（先等 1 秒，再等 2 秒）；Bedrock 说了要等多久时会更短：按它的 `Retry-After` 来，要等一分钟及以上就干脆不等，让 magpie 马上知道、换账号。每次都失败时，magpie 拿到的是最后一次的响应和它的 `Retry-After`，和以前一样。其它错误（`400`、`403`、`412`）直接返回。设 `0` 则每次失败都立刻交给 magpie。重试是本 provider 自己做的，不是 Portkey 网关：让网关来做，就得在每个请求上带一份内联配置，而禁止内联配置的组织会拒绝它，别的组织里它还会替换掉你 API key 上的默认配置。
- `cacheTtl1h`：让 Claude 的 prompt-cache 检查点保留**一小时**，而不是 Bedrock 默认的五分钟，这样隔一会儿回到对话时还能命中缓存。默认关；只对 Claude 生效（Nova 自己会缓存，五分钟）。Portkey 文档里写明支持一小时 TTL 的是 Claude Opus 4.5、Sonnet 4.5 和 Haiku 4.5；你用的 Bedrock 模型是否接受，需要你自己确认，因为目录里还有 Portkey 表格没列的更新型号。调用方自己的 `cacheRetention` 仍然优先：`none` 不发检查点，`long` 无论开关如何都要求一小时。

文件里的其余设置：

- `configId`：随所有账号请求发送的 `x-portkey-config` 配置 id。
- `headers`：随所有账号请求发送的额外非敏感网关头。
- `models`：网关 `/models` 列表里不显示、但能直接按 id 调用的隐藏模型（如 `["us.anthropic.claude-fable-5-2"]`）。条目格式同 `models.json`；它们总会被注册，与目录同 id 的条目会覆盖目录里的那个。

在 magpie 的 Options 里把开关名拼错（比如把 `log` 写成 `logs`）会被拒绝，原因写进 magpie 的日志，而不是被悄悄忽略——否则你以为关掉的开关其实还开着。配置文件里出现非开关的名字则没关系，因为它不只放开关。

旧版本文件里的 `baseUrl` 和 `provider` 会被忽略——它们已不决定任何路由。凭证只放在 magpie 的登录里，不进这个文件：读取器会拒绝 API key 和敏感头（`apiKey`、`virtualKey`、`authorization`、`*-api-key`、`token`、`secret`、`cookie`）。改完重启插件生效。

插件启动时会逐条检查模型条目：未知字段（如 `contextwindow`）或类型不对都会报出来，并指明是哪一条。读不了的配置文件不会让插件挂掉：provider 仍会用内置目录加载，原因写进 magpie 的日志。

请求以未压缩形式发送。Portkey 线上网关按纯 JSON 解析请求体、不做解压：gzip 或 deflate 的请求体在 `/model/{id}/converse-stream` 和 `/v1/messages` 上都会返回 `400`（`Value null at 'messages'`），即使只有 95 字节也一样。要压缩请求需要网关先支持请求解压。响应同样不压缩，发 `Accept-Encoding: gzip, br` 也不会改变响应头。

## 模型

`models.json` 是可编辑的目录。条目可以是模型 ID 字符串，或带 `id`、`name`、`reasoning`、`thinkingLevelMap`、`input`、`contextWindow`、`maxTokens`、`cost` 的对象。价格是 USD / 百万 token，`input`、`output`、`cacheRead`、`cacheWrite` 分列。条目没写的字段按模型系列取默认值：Anthropic 与 Nova Pro / Premier 开启推理、支持图片、1M 上下文、64K 输出；其他系列只支持文本、不开推理、200K 上下文、8K 输出。价格默认为 0。

内置目录覆盖当前 Bedrock 主力型号，外加常见的 Amazon / DeepSeek / Meta / Mistral 模型。可用性、上限和价格取决于你的 AWS 账号和 Portkey 路由，请按需调整目录。账号登录后，magpie 会通过 provider 的 `refreshModels` 刷新列表：网关 `/models` 的响应与目录合并——目录条目保留自己的元数据，未知 id 以保守默认值加入。目录里的 `name` 是 magpie 模型选择器显示的名字（如 `Claude Opus 5.5`，而不是原始 Bedrock id）；请求用的仍然是 id。

网关不肯列出模型时，目录保留，原因写进 magpie 的日志，而不是让刷新失败：

- Portkey 自己的拒绝（例如 `403` 带 `Error Code: 033`）：API key 可能没有列出模型的 scope（`completions.write`），或者 provider slug 属于另一个 workspace。
- AWS 的拒绝，指明了 IAM action（例如 `bedrock:ListFoundationModels`）：路由背后的 AWS 主体没有这个权限。对话不受影响；可以在 AWS 里放行，或者直接在 `config.json` 的 `models` 里手动列出（见上文）。

其它失败（`5xx`、不是网关自己给出的错误）只报告状态码和网关的原话，不加建议：里面没有你能据以行动的信息。

### 谁能在 Portkey 里看到你的请求

`log` 关着时，Portkey 不存请求和响应的内容，所以你和组织管理员在 Logs 页都看不到：管理员的日志权限管的是存下来的东西，而这里什么都没存。保留下来的是元数据：时间、模型、key、耗时。这说的是 Portkey 自己的日志。有两样不归它管，本 provider 也管不到：Enterprise 或自托管网关可以把完整的 prompt 和回复导出到运维方指定的 OpenTelemetry 端点，开关在网关的环境变量里，没有任何请求头能关掉它，文档也没说 `log` 能让内容不进导出；检查内容的护栏不管存不存都会读到请求。如果你的网关不是 `api.portkey.ai`，而是你所在组织自己的，导出什么由它的运维方决定，该去问他们。组织也可以禁止关闭日志，这时请求会被 `446` 拒绝，报错会提示你打开 `log`。细节和出处见 [docs/portkey-reference.zh-CN.md](docs/portkey-reference.zh-CN.md)。

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

用 `/login` 登录 `portkey-bedrock`：pi 会问同样的四个字段。同一会话只启用一份本 provider。

## OpenCode 插件 vs pi 扩展

本包是 **pi 扩展**：真正的 `@ai-sdk/amazon-bedrock` SDK 在这里运行、讲原生 Bedrock Converse，上面的 prompt-cache 检查点、推理强度映射、签名思考回放都因此而来。更轻的替代是 OpenCode 供应商插件（magpie 网关转成 chat completions，一个小 `fetch` 补网关头）——更简单，但通用 chat 流量带不了显式 cachePoint 这类 Bedrock 专属特性。两种方式 provider id 不同，可以同时安装。

## 开发与验证

在 pi 1.5.2 和 magpie 的 Bun 插件宿主上测试。

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

`npm publish` 产出的安装包只含 provider、目录和文档；依赖、测试和本地覆盖被排除。

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
