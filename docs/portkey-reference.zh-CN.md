# Portkey 参考

本 provider 依赖 Portkey 做什么、每条结论从哪里来、三个开关为什么是现在这样。写于 2026 年 11 月，读完 Portkey 官方文档和开源网关（v1.15.2，提交 `669825c`）之后，为的是下次再改这里的人不用把这些重新找一遍，也不用重犯文末记录的那些错。

## 怎么读 Portkey 的文档

Portkey 的文档由 Mintlify 发布，有机器可读的版本，比抓网页好得多。`docs.portkey.ai` 是 `portkey.ai/docs` 的规范域名。

| 用途 | 地址 |
| --- | --- |
| 全站页面索引 | `https://docs.portkey.ai/docs/llms.txt` |
| 分区索引 | `https://docs.portkey.ai/docs/_llms/latest/{docs,integrations,admin-apis}.txt` |
| 全站合成一个文件（约 1.6 MB） | `https://docs.portkey.ai/docs/llms-full.txt` |
| 单页 Markdown | 在页面地址后加 `.md`，例如 `https://docs.portkey.ai/docs/api-reference/inference-api/headers.md` |
| OpenAPI 规范 | `Portkey-AI/openapi` 仓库 |

用单页版：先取索引，挑出相关的页面，只读这些。下文有一部分内容文档里根本没有，是从网关源码读出来的；每一条都标了来源。

## 本 provider 发的是什么

请求走的是 Bedrock Converse 流式协议，不是 Portkey 的 OpenAI 兼容接口：`POST {baseUrl}/model/{编码后的模型 id}/converse-stream`，响应是 AWS event-stream 二进制帧。请求由 `@ai-sdk/amazon-bedrock` 构造，指向账号自己的网关。

这个选择决定了 Portkey 的哪些功能在这里适用。文档的大部分篇幅讲的是统一接口（`/v1/chat/completions`），那边的 `reasoning_effort`、`cache_control` 块、`guardrailConfig` 都是**请求体**字段。本 provider 一个都没用：请求体是 Converse 的，Bedrock 专属特性以 Converse 的字段放进去（`additionalModelRequestFields`、`cachePoint`）。只有走**请求头**的东西，才能确定在这条路由上行为一样。

每个请求都带的头：

| 头 | 值 | 来源 |
| --- | --- | --- |
| `x-portkey-api-key` | 账号的 key | 登录表单 |
| `Authorization` | `Bearer` 加同一个 key | SDK 的 API key 模式 |
| `x-portkey-provider` | 账号的 provider slug | 登录表单 |
| `x-portkey-config` | 保存好的配置的 id，只在设了 `configId` 时 | `configId` |
| `x-portkey-debug` | `false` | `log` 开关 |

## 事实，以及各自的出处

“文档”指 Portkey 官方文档写了。“源码”指是从开源网关里读到的。“未验证”指本 provider 依赖它，但还没有人在托管网关的这条路由上确认过。

### 鉴权

- `x-portkey-api-key` 是 Portkey 的 key。**文档**：`api-reference/inference-api/headers`。
- Portkey 会把给 provider 的 `Authorization: Bearer` 转成上游要的形式。**文档**：同一页 "Provider Slug + Auth"。
- Model Catalog 里的 provider，slug 是 `@provider-slug`；直接给凭证的，是 `bedrock` 这样的普通名字。**文档**：同一页 "AI Provider" 和 "Custom Host"。
- 登录表单问 slug 时没有默认值，提示是 Model Catalog 的写法 `@your-bedrock-provider`。2.6.2 以前留空即 `aws-bedrock`。**源码**：没有叫这个名字的 Portkey provider；开源网关里 Bedrock 叫 `bedrock`（`globals.ts`，`BEDROCK = 'bedrock'`），文档里也一律写 `bedrock`。

### 日志

- `x-portkey-debug: false` 就是 Portkey 的 "DO NOT TRACK"：日志里不存请求和响应内容，但保留 token、费用和延迟。**文档**：`product/observability/logs` 的 "DO NOT TRACK"。这个头虽然叫 "debug"，但只决定内容存不存。
- 它在 `/model/{id}/converse-stream` 上是否被遵守。**未验证**：文档只在 `/v1/chat/completions` 上展示过它。2026 年 11 月看到的情况：带着这个头的请求，记录里写 "Request not logged as per your configuration"、`0 tokens`。但不带这个头的请求（2.5.1 发的）也一样没有内容，而且不论带不带，都不是每条请求都有记录。所以还不能说明“是这个头让内容没被存下来”。能说明的测试是：把 `log` 打开发几条，看内容是否出现。
- 没有按请求“什么都不存”的办法。组织级设置（`Admin Settings → Organization Properties → Request Logging`，Full Logging 或 Metrics Only）是 Enterprise 套餐的功能，且需要组织所有者；而 Metrics Only 的效果和这个头一样。**文档**：`product/administration/configuring-request-logging`。
- 切到 Metrics Only 不会删掉已经记录的内容。**文档**：同一页。
- 谁能看到记录下来的内容。"Logs" 是完整记录，含请求和响应；"Logs Metadata" 是时间、模型、token 数，不含内容。默认情况下 workspace 成员、管理者和组织管理员两者都能看，组织所有者和管理员始终能看到全部数据。**文档**：`product/administration/configure-logs-access-permissions-in-workspace`、`product/administration/configure-data-visibility-settings`。这些权限管的是“存下来的东西”：开了 DO NOT TRACK 内容不会被存，管理员也就没有内容可看。
- 内容还可能去往的两个地方，文档没说它们和这个头的关系。
  - **OpenTelemetry 导出。** Enterprise 或自托管网关可以把日志推送到运维方选定的 OTLP 端点（Datadog、LangSmith、自建 collector）。有两种：*Analytics*（次数、延迟、token、费用，不含内容）和 *Complete Logs*，后者带有 "Full prompt and completion content"、工具定义和请求参数，是实验性功能。两者都在网关的环境变量里开启，Complete Logs 用 `EXPERIMENTAL_GEN_AI_OTEL_TRACES_ENABLED=true` 加 `EXPERIMENTAL_GEN_AI_OTEL_EXPORTER_OTLP_ENDPOINT`；导出发生在响应返回之后。**文档**：`product/enterprise-offering/otel/otel`、`product/enterprise-offering/otel/complete-logs`、`product/enterprise-offering/otel/analytics`。没有任何请求头能关掉它们，文档也从未说过 DO NOT TRACK 能让内容不进导出：**未验证**。客户端无法得知它是否开启，因为请求和响应都不会有任何变化；只有网关的运维方知道。
  - **护栏**：检查内容的护栏会读取请求，不管它存不存。
- 网关是谁的，决定了还有谁能看到。在 Portkey 托管网关（`api.portkey.ai`）上，存下来的东西归 Portkey，组织管理员按上面说的权限查看。组织自己运行的网关（混合部署或自托管，用它自己的地址）由该组织运维：它导出什么、用 OpenTelemetry 还是别的方式，都由运维方决定，本 provider 的任何设置都管不到。导出这一点有**文档**依据（`self-hosting/hybrid-deployments/architecture`：数据面在组织自己的云里 "processes all your AI traffic"）。
- 组织可以禁止 DO NOT TRACK：用 start hook 配一个 Header Check，匹配 `{"x-portkey-debug": "false"}`，这样的请求会被 `446` 拒绝，目的是“stop clients from turning off request logging”。**文档**：`product/guardrails/start-hooks`、`product/administration/enforce-policies-with-start-hooks`。
- DO NOT TRACK 会让 Portkey 自己的响应缓存失效："Caching won't work if `x-portkey-debug: "false"` header is included."。**文档**：`product/ai-gateway/cache-simple-and-semantic`。Bedrock 的提示词缓存是上游的另一回事，不受影响。

### 重试

Portkey 网关可以重试，但本 provider 不让它来做：本 provider 自己重试（原因见下文“`retry`：2”）。下面是做这个决定所依据的事实。

- 网关的重试是配置里的一个 `retry` 对象：`attempts`（必填）、`on_status_codes`、`use_retry_after_headers`。**文档**：`api-reference/inference-api/config-object`。没有单独控制它的请求头。**文档**（`api-reference/inference-api/headers` 里没有）和**源码**（`globals.ts` 里唯一的重试头是响应头 `x-portkey-retry-count`）。
- 配置要么是保存好的配置的 id，要么是一段内联 JSON，都放在同一个 `x-portkey-config` 头里。**文档**：`integrations/libraries/vercel` 的 "Inline Config"。
- 组织可以拒绝内联配置。打开 **Block Inline Configs**（Admin Settings → Security → Data Plane Security Settings）后，带内联配置 JSON 的请求会得到 `400`，`error.code` 是 `inline_config_blocked`；保存好的配置 id 仍然可以。**2026 年 6 月 19 日及以后创建的组织默认是打开的**。**文档**：`product/administration/enforce-saved-only-config`。
- 请求里带了配置，就会替换掉管理员挂在 API key 上的默认配置："The default config only applies when no config is specified in the request itself."。如果 key 的 "Allow Config Override" 关着，这样的请求会直接 `400`。**文档**：`product/ai-gateway/configs`、`product/administration/enforce-default-config`。
- 所以，每个请求都带一份内联重试配置，在禁止内联配置的组织里会被直接拒绝，在别的组织里会悄悄丢掉管理员在 key 上设的一切（护栏、fallback、预算）。2.6.1 默认就是这么做的。
- 备查：网关自己的重试，等待 1 秒、2 秒、4 秒、8 秒、16 秒。**文档**里有（`product/ai-gateway/automatic-retries`），源码也印证了：`retryRequest`（`handlers/retryHandler.ts`）调用 `async-retry`，它依赖的 `retry@0.13.1` 按 `minTimeout(1000) × factor(2) ^ attempt` 计算，`attempt` 从 0 开始。默认重试的状态码：**文档**写的是 `[429, 500, 502, 503, 504, 529]`；开源的 `globals.ts` 里是 `[429, 500, 502, 503, 504]`，没有 529。累计等待上限 60 秒，单个 `Retry-After` 达到 60 秒及以上，重试立即结束（`MAX_RETRY_LIMIT_MS`）。一份保存好的、带 `"passthrough": true` 目标的配置，可以给所有账号带上重试，因为 provider 是从请求里取的。**文档**：`product/ai-gateway/configs` 的 "Passthrough targets"。

### 请求超时

- `x-portkey-request-timeout`（毫秒）会终止超时的请求，Portkey 随后返回 `408`。**文档**：`product/ai-gateway/request-timeouts`。
- 对流式请求，只要已经收到至少一个 chunk，就不会触发。**文档**：同一页 "Caveats"。本 provider 自己的 `timeoutMs` 是对整个请求的限制，两者不是一回事。

### 模型列表

- `GET /v1/models` 有两种模式。`x-portkey-provider` 里带 `@provider-slug`（或带 `provider`/`targets` 的配置）时，它代理 provider 自己的列表；不带时，返回 workspace 的 Model Catalog。**文档**：`api-reference/inference-api/models/models`。
- AWS Bedrock 在它能代理的 provider 之列。**文档**：同一页 "Supported Providers"。
- `x-portkey-fetch-integrated-models: true` 让它在给了 provider 的情况下仍返回 Model Catalog 的模型。**文档**：同一页。本 provider 没用；它只在请求到达路由层之后才有意义。
- 这条路由要求 key 有 `models.list` 或 `completions.write` 权限。**文档**：models 页；帮助页 `help-center/you-do-not-have-enough-permissions` 的说法是 `completions.write` 或 `virtual_keys.list`。
- 2026 年 11 月用一个真实 key 得到的实际响应：`HTTP 403`，响应体是 `{"status":"failure","message":"Portkey Error: Forbidden!. Error Code: 033","error":{"message":"Portkey Error: Forbidden!. Error Code: 033","code":"033"}}`，没有 `x-portkey-trace-id` 头。**实测一次**。`033` 的含义**未验证**：文档里没有定义，`portkey.ai/error-library/033` 不存在。从形状看是 Portkey 自己的拒绝，发生在请求到达 provider 之前。

### 错误

- Portkey 自己的错误以 "Portkey Error" 开头；provider 的错误原样返回。**文档**：`support/common-errors-and-resolutions`。
- 带 Portkey 含义的状态码：`408` 超时，`412` 预算耗尽，`429` 限流，`446` 护栏拒绝了请求，`246` 请求成功但护栏检查未通过。**文档**：`api-reference/inference-api/error-codes`。
- 每个响应都带 `x-portkey-trace-id`、`x-portkey-retry-attempt-count`、`x-portkey-cache-status`、`x-portkey-last-used-option-index`。**文档**：`api-reference/inference-api/response-schema`。
- `Invalid response received from bedrock: {…}` 是网关在 provider 的响应形状读不出来时的兜底文案：`src/providers/utils.ts` 里的 `generateInvalidProviderResponseError`，由 Bedrock 的 chat 和 messages 转换器返回。**源码**。这句话不是本 provider 写的。
- Block Inline Configs 拒绝时返回 `400`，响应体写明拒绝了什么：`{"status":"failure","error":{"code":"inline_provider_blocked","message":"…","field":"x-portkey-provider"},"message":"…"}`。错误码有：`inline_config_blocked`、`inline_provider_blocked`（用了 `bedrock` 这样的普通名字，而不是保存好的 `@slug`）、`inline_custom_host_blocked`、`inline_provider_url_blocked`、`inline_forward_headers_blocked`。只返回找到的第一个。**文档**：`product/administration/enforce-saved-only-config`。

### 提示词缓存

- Bedrock 在显式检查点处缓存，`cachePoint: { type: "default" }`；`ttl: "1h"` 要求一小时 TTL。**文档**：`integrations/llms/bedrock/prompt-caching`。
- Portkey 的表里，支持一小时 TTL 的只有 Claude Opus 4.5、Sonnet 4.5、Haiku 4.5，表里其余的只有五分钟。Nova 自己缓存，上限 20K token，不含工具。**文档**：同一页。
- 更新的 Claude 型号（本目录里的 5.x 系列）是否接受 `ttl: "1h"`。**未验证**：Portkey 的表里没有它们，可能是表没更新，也可能是型号不支持，两者的可能性差不多。
- 一小时的检查点写入价是多少，相比五分钟的。**未验证**：读过的文档里都没有这个价格。`models.json` 里每个型号只有一个缓存写入价，是其输入价的 1.25 倍，读取是 0.1 倍。
- Portkey 的简单缓存（`cache: { mode: "simple" }`）是另一回事：它保存完整响应，要求整个请求一致，所以在一个对话的各轮之间永远不会命中。**文档**：`integrations/libraries/claude-code-gateway-compatibility` 的 "Gateway caching"。
- 会改写请求的护栏（PII 脱敏）会让每一轮都缓存未命中。**文档**：同一页 "Guardrails"。

### 考虑过但没有采用的

- `x-portkey-metadata`、`x-portkey-trace-id`、`x-portkey-span-id` 可以把请求在 Portkey 的 Logs 视图里归成 trace；`x-portkey-bedrock-map-metadata: true` 把 metadata 透传成 Bedrock 的 request metadata。**文档**（`product/observability/metadata`、`product/observability/traces`、`integrations/llms/bedrock/aws-bedrock`）。没有采用：它们只在开了日志时才有用，而 `log` 默认是关的。
- 用 metadata 生成 AWS STS 会话标签，在 Cost Explorer 里做成本归因。仅限企业自托管。**文档**：`guides/use-cases/aws-bedrock-cost-attribution-with-sts-session-tags`。
- Bedrock Mantle provider（`bedrock-mantle`），一条 OpenAI 兼容的 Bedrock 路由。**文档**：`integrations/llms/bedrock-mantle`。没有采用：`@ai-sdk/amazon-bedrock` 有对应的 `./mantle` 入口，但它没有显式的缓存检查点，而那正是本 provider 的意义所在。
- Converse 请求体里的 `guardrailConfig` 和 `additionalModelRequestFields` 在 `/model/{id}/converse-stream` 上是否被原样透传。**未验证**。推理强度依赖 `additionalModelRequestFields`，目前是能用的。

## 三个开关为什么是现在这样

开关从两个地方读取。magpie 的 Options（插件页的编辑器，存进 `plugins.json`）优先于配置文件，配置文件优先于默认值。`src/config.ts` 里的 `DEFAULT_SWITCHES` 保存默认值和每个值的理由；`package.json` 里的 `magpie.options` 是 Options 编辑器打开时显示的内容，有一条测试保证两者一致。

magpie 在 `plugins.json` 里按插件被添加时的 spec 保存它，别的什么都不存：`{spec, off, options}`。spec 常常是带版本或标签的包名（`@jack-yang/magpie-portkey-bedrock@latest`），也可能是 git 仓库或文件夹。本 provider 按 magpie 读 spec 的方式找自己的那一条（它 `store.go` 里的 `plugin.Name`、`IsPath`、`IsGit`）：npm 的 spec 看包名，git 的 spec 看 bun 装成的包名，路径看文件夹。2.6.0 和 2.6.1 是拿整个 spec 去和不带版本的包名比较，所以带版本的那一条永远找不到，Options 里保存的开关全都被忽略了，而且没有任何提示。

### `log`：关

这是唯一能按请求控制的东西，而且它做到的比名字暗示的少：不存内容，但用量记录还在。默认关，因为“我的对话内容被存在第三方的日志里”是用户最不可能在没要求的情况下想要的东西。而且失败的方向是对的：配置读不出来时，回退到关。

它在这条路由上仍未验证（见上文）。在验证之前，这个开关保证的是“头发出去了”，不是“什么都没存”。而且它管的是 Portkey 自己的日志：网关运维方开启的 OpenTelemetry 导出它管不到，客户端发什么都关不掉那个。

### `retry`：2

问题在于由谁来重试失败的请求：本 provider，在同一个账号上；还是 magpie，换一个账号。如果是前者，再问一句：由谁发出重试，本 provider 还是 Portkey 网关。

**提示词缓存是跟着账号走的。** 缓存写在路由背后的 AWS 凭证名下。magpie 故障切换到别的账号时，那个账号没有这段对话的缓存，要重新写一遍：按 `models.json` 里目录中每个 Claude 型号的定价，写入是输入价的 1.25 倍，而读取只有 0.1 倍。留在同一个账号上的重试能保住它。

**重试能消化故障切换解决不了的问题。** 只有 `429`、`408` 和 `5xx` 会重试，其余的立即返回。所以短暂的限流在发生的地方就被处理掉了，magpie 的故障切换留给它该管的事：账号预算用完（`412`）、账号没有某个权限（`403`）——这些情况下换账号正是对的。

**重试由本 provider 发出，不是 Portkey 网关。** 网关的重试要求每个请求都带一份内联 `x-portkey-config`，而这在禁止内联配置的组织里（2026 年 6 月 19 日以后创建的组织默认如此）会被直接拒绝，在别的组织里会替换掉管理员挂在 API key 上的默认配置（见上文“重试”）。2.6.1 就是这么做的，而且 `retry` 默认是开的。从 2.6.2 起，请求只是被原样再发一次：同样的请求体，发给同一个账号。Portkey 看到的是普通请求，组织策略和 key 的默认配置都不受影响，`x-portkey-config` 里只有用户自己放的东西（`configId`）。

规则沿用网关的：`429`、`408` 和 `5xx` 重试；Bedrock 在 `retry-after-ms` 或 `retry-after` 里说了等多久就按它，否则从 1 秒起每次翻倍；累计等待不超过一分钟，要求等一分钟及以上时干脆不等，所以长时间不可用的账号会立刻交给 magpie。每次都失败时，交给 magpie 的是最后一次的响应、它的状态码和 `Retry-After`，故障切换照旧。中止会立即结束等待。Bedrock 在已经开始的流里发来的异常（`200` 里的 `throttlingException` 帧）不重试：答案可能已经显示出一部分了。

代价是等待，发生在请求一直失败的时候：

| `retry` | 各次等待 | 累计 | 共发出请求 |
| --- | --- | --- | --- |
| 0 | — | 0 秒 | 1 次 |
| 1 | 1 秒 | 1 秒 | 2 次 |
| **2** | 1 秒、2 秒 | **3 秒** | 3 次 |
| 3 | 1 秒、2 秒、4 秒 | 7 秒 | 4 次 |
| 5 | 1 秒、2 秒、4 秒、8 秒、16 秒 | 31 秒 | 6 次 |

两次重试足以覆盖一次短暂的限流，最多 3 秒。第三次要多等 4 秒，而这一试很少有用：如果一个账号 3 秒后还在限流，通常会限流得更久。

对一个长时间限流的账号，`0` 会让每次失败都立刻交给 magpie；当你更在意快速失败、而不是缓存时，就选它。

### `cacheTtl1h`：关

一小时并不简单地比五分钟好。据说保留一小时的检查点写入价更贵，但贵多少，这次读过的材料里都没有：Portkey 的文档和 `models.json` 里都没有单独的价格。这一点有两个影响。其一，它只在“隔了 5 分钟到 1 小时之后再回到这个对话”时才划算——在一次连续的使用里，五分钟就够了；隔了一夜，一小时也不够。这是每个人使用方式上的事实，所以该由每个人自己来设。其二，开着这个开关时，本 provider 报出来的费用是偏低的：每个型号只有一个缓存写入价（`models.json`），是五分钟那一档，所以一小时的写入是按五分钟的价格计的。开着 `cacheTtl1h` 时，请把报出的费用当作下限。

另外，哪些 Claude 型号接受它还未验证，而不接受的型号会直接拒绝请求。

这个开关只在“没有别的要求”时起作用。调用方自己的 `cacheRetention` 仍然优先：`none` 不发检查点，`long` 要求一小时。需要这个开关，是因为 magpie 的桥接层不传 retention，在此之前在那里根本没法要求一小时。

### 拒绝时说什么

拒绝会用网关自己的话来报告，并说明该怎么办；说哪句话取决于是谁拒绝的：

- **AWS**：消息里写明了 IAM action（`is not authorized to perform: bedrock:…`）。保留 action，去掉消息里的账号，因为报错信息会被复制到聊天和截图里。
- **Portkey，401/403/412**：它自己的消息和错误码，并按状态码给出下一步（401/403 查权限和 slug，412 查预算）。
- **Block Inline Configs，带 `inline_…_blocked` 错误码的 400**：报出错误码，以及这边发出内联值的那个设置。`inline_provider_blocked` 是用了 `bedrock` 这样的普通 slug：用 `@slug` 重新登录。`inline_config_blocked` 是 `configId` 或 `headers` 里放了配置对象。没有这种错误码的 `400` 是 Bedrock 的（`validationException`），保留 SDK 的原话。
- **护栏，446**：被组织的策略拒绝；重发也会被拒绝。匹配到 `x-portkey-debug` 的，是要求记录日志的策略，建议是打开 `log`。
- **其余情况，以及 429**：不算拒绝。SDK 的原始报告原样保留。因为一个 502 就让用户去查 key 的权限，比什么都不说更糟。

而且是哪个请求被拒绝也很重要。模型列表被 key 拒绝时对话还能用，所以保留目录，建议是怎么让列表能用。组织策略拒绝了列表，也同样会拒绝对话，所以不说“对话不受影响”。请求本身被拒绝意味着对话就是坏掉的那个，所以建议是关于 key、预算、IAM 策略或组织设置的。

只要响应里有 `x-portkey-trace-id`，失败时就会带上它，方便在 Portkey 里找到这次请求。

## 一路上犯过的错

记下来，是因为每一条都让我对用户说错过一次话，而且全都是先核实一下就能避免的。

1. **说网关在每次推理请求前都会调用 `bedrock:ListFoundationModels`。** 并不会：开源网关调用的是 `GetInferenceProfile`，而且只在模型以 ARN 给出时才调，失败还会被吞掉。这个结论来自把文档里的一段话读成了比它实际说的更多的意思。

2. **说 pi 扩展可以声明 magpie 的开/关切换。** 不可以：`pi.js` 拼出来的 `auth` 对象只有四个固定字段，给扩展的对象上也没有 `input.magpie`。对着真实宿主跑探针，得到的是 `"options": []`。这是测出来的，不是读出来的；读代码的结论两次都是“可以”。

3. **用同一个宿主进程里的第二次 `init` 来模拟重启**，并把开关没生效当成了 bug。扩展模块是按进程缓存的。magpie 是真的重启宿主（`store.SetOptions` 的最后一行是 `Restart()`），所以测试必须起一个新进程。

4. **把所有非 2xx 的响应都当成拒绝**，用关于 key 权限的建议替换了 SDK 的报错——对 502 也这样。当时所有测试都通过；是测试没覆盖到的输入，靠探针才发现的。

5. **让测试去读用户真实的 `plugins.json`。** 隔离用的预加载脚本只管了配置文件。

6. **把重试退避说成 2 秒、4 秒、8 秒，还说文档里的 1 秒、2 秒、4 秒是理想化的。** 文档是对的。库里 `attempt` 从 0 开始，我当成了从 1 开始。

7. **先说多账号时 `retry` 应该保持 0，后来又说了相反的。** 第一次的回答只考虑了故障切换有多快，没考虑故障切换对缓存做了什么。

8. **说一小时的缓存写入价大约是五分钟的两倍**，还没核实就把这个倍数写进了建议里。读过的文档里都没有这个价格。方向保留了，写成“据说更贵”并标了未验证；数字去掉了。

9. **把 `retry` 做成默认 2 的内联网关配置（2.6.1）**，当时没读 Portkey 的管理类页面。那些页面写着：打开 Block Inline Configs 时内联配置会被拒绝，而 2026 年 6 月 19 日以后创建的组织默认就是打开的；在别的组织里它会替换掉 key 的默认配置。修复的做法是把重试挪进本 provider。

10. **查找本插件的 Options 时，拿整个 spec 和包名比较（2.6.0、2.6.1）。** magpie 保存 spec 时带着 `@latest`，所以 Options 里存的东西从来没有生效。测试里 spec 是自己写的、不带版本，所以都通过了；是读了用户真实的 `plugins.json` 才发现。测试另一个程序写出的东西，就得按那个程序的写法来写。

11. **把 Logs 页的变化当成了版本之间的变化。** 同一个版本、同一分钟里，有的请求有记录、有的没有；拿来比较的请求后来发现分属三个版本。先把观察和“当时装的是哪个版本”对齐，再去解释。

规律是：靠读代码得出的关于行为的结论，只是假设；凭记忆想起的数字也一样。在要紧的地方，去跑一遍——对着真实宿主，或者用测试里没有的输入——或者去查，又或者就说不知道。
