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
| `x-portkey-config` | 配置 id，或内联的重试配置 | `configId`，或 `retry` 开关 |
| `x-portkey-debug` | `false` | `log` 开关 |

## 事实，以及各自的出处

“文档”指 Portkey 官方文档写了。“源码”指是从开源网关里读到的。“未验证”指本 provider 依赖它，但还没有人在托管网关的这条路由上确认过。

### 鉴权

- `x-portkey-api-key` 是 Portkey 的 key。**文档**：`api-reference/inference-api/headers`。
- Portkey 会把给 provider 的 `Authorization: Bearer` 转成上游要的形式。**文档**：同一页 "Provider Slug + Auth"。
- Model Catalog 里的 provider，slug 是 `@provider-slug`；直接给凭证的，是 `bedrock` 这样的普通名字。**文档**：同一页 "AI Provider" 和 "Custom Host"。
- 登录表单的默认 slug 是 `aws-bedrock`。**未验证**：文档里写的是 `bedrock`，不是 `aws-bedrock`。

### 日志

- `x-portkey-debug: false` 就是 Portkey 的 "DO NOT TRACK"：日志里不存请求和响应内容，但保留 token、费用和延迟。**文档**：`product/observability/logs` 的 "DO NOT TRACK"。这个头虽然叫 "debug"，但只决定内容存不存。
- 它在 `/model/{id}/converse-stream` 上是否被遵守。**未验证**。文档只在 `/v1/chat/completions` 上展示过它。
- 没有按请求“什么都不存”的办法。组织级设置（`Admin Settings → Organization Properties → Request Logging`，Full Logging 或 Metrics Only）是 Enterprise 套餐的功能，且需要组织所有者；而 Metrics Only 的效果和这个头一样。**文档**：`product/administration/configuring-request-logging`。
- 切到 Metrics Only 不会删掉已经记录的内容。**文档**：同一页。

### 重试

- `retry` 配置对象有 `attempts`（必填）、`on_status_codes`、`use_retry_after_headers`。**文档**：`api-reference/inference-api/config-object`。
- 配置可以是一段内联 JSON，放在 `x-portkey-config` 头里；保存好的配置 id 也走这个头。**文档**：`integrations/libraries/vercel` 的 "Inline Config"。
- 每次重试前等待 1 秒、2 秒、4 秒、8 秒、16 秒。**文档**里有（`product/ai-gateway/automatic-retries`），源码也印证了：`retryRequest`（`handlers/retryHandler.ts`）调用 `async-retry`，它依赖的 `retry@0.13.1` 按 `minTimeout(1000) × factor(2) ^ attempt` 计算，`attempt` 从 0 开始。
- 默认重试哪些状态码。**文档**写的是 `[429, 500, 502, 503, 504, 529]`；开源的 `globals.ts` 里是 `RETRY_STATUS_CODES = [429, 500, 502, 503, 504]`，没有 529。托管网关用哪个**未验证**。529 是 Anthropic 的过载码，所以这个差别可能有影响；显式设置 `on_status_codes` 可以消除这个不确定。
- 开了 `use_retry_after_headers`，provider 返回的 `retry-after-ms`、`x-ms-retry-after-ms` 或 `retry-after` 会替代退避；没有这些头时仍按退避。**文档**：同一页。
- 累计等待有 60 秒上限；单个 `Retry-After` 达到 60 秒及以上，重试立即结束。**文档**（同一页）和源码都有：`MAX_RETRY_LIMIT_MS = 60 * 1000`；`retryRequest` 在 `retryAfter >= MAX_RETRY_LIMIT_MS` 或超出剩余额度时直接抛出，不等待。
- 不在重试范围内的状态码立即返回，不重试。**源码**：`retryRequest` 对它们调用 `bail`。
- 响应头 `x-portkey-retry-attempt-count`：`-1` 重试全部用完，`0` 没有配置重试，`>0` 在那一次重试上成功。**文档**：`product/ai-gateway/automatic-retries` 的 "Retry Attempt Header"。

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

### `log`：关

这是唯一能按请求控制的东西，而且它做到的比名字暗示的少：不存内容，但用量记录还在。默认关，因为“我的对话内容被存在第三方的日志里”是用户最不可能在没要求的情况下想要的东西。而且失败的方向是对的：配置读不出来时，回退到关。

它在这条路由上仍未验证（见上文）。在验证之前，这个开关保证的是“头发出去了”，不是“什么都没存”。

### `retry`：2

问题在于由谁来重试失败的请求：Portkey，在同一个账号上；还是 magpie，换一个账号。有两点决定了答案。

**提示词缓存是跟着账号走的。** 缓存写在路由背后的 AWS 凭证名下。magpie 故障切换到别的账号时，那个账号没有这段对话的缓存，要重新写一遍：按 `models.json` 里目录中每个 Claude 型号的定价，写入是输入价的 1.25 倍，而读取只有 0.1 倍。留在同一个账号上的重试能保住它。

**重试能消化故障切换解决不了的问题。** Portkey 只重试 `429` 和 `5xx`，其余的立即返回。所以短暂的限流在发生的地方就被处理掉了，magpie 的故障切换留给它该管的事：账号预算用完（`412`）、账号没有某个权限（`403`）——这些情况下换账号正是对的。

代价是等待，发生在请求一直失败的时候：

| `retry` | 各次等待 | 累计 | 共发出请求 |
| --- | --- | --- | --- |
| 0 | — | 0 秒 | 1 次 |
| 1 | 1 秒 | 1 秒 | 2 次 |
| **2** | 1 秒、2 秒 | **3 秒** | 3 次 |
| 3 | 1 秒、2 秒、4 秒 | 7 秒 | 4 次 |
| 5 | 1 秒、2 秒、4 秒、8 秒、16 秒 | 31 秒 | 6 次 |

两次重试足以覆盖一次短暂的限流，最多 3 秒。第三次要多等 4 秒，而这一试很少有用：如果一个账号 3 秒后还在限流，通常会限流得更久。而且 Bedrock 说了要等多久时，Portkey 会听：被告知要等一分钟及以上，它立即停止，所以长时间不可用的账号不会拖延，很快就交到 magpie 手上。

`use_retry_after_headers` 发的是 `true`，就是为了上面最后这一点：让等待时长由 Bedrock 来定，在 60 秒上限之内。

重试配置以**内联 JSON** 放在 `x-portkey-config` 里，因为就是这个头。保存好的配置 id 也用它，而一个头放不下两样东西，所以设了 `configId`（或 `headers` 里有这个头）时，开关退让：用一个只有重试的配置替换掉 id，会把那个保存的配置里的其它内容全部丢掉。这种情况下请把 `retry` 写进那个保存的配置里。

对一个长时间限流的账号，`0` 会让每次失败都立刻交给 magpie；当你更在意快速失败、而不是缓存时，就选它。

### `cacheTtl1h`：关

一小时并不简单地比五分钟好。据说保留一小时的检查点写入价更贵，但贵多少，这次读过的材料里都没有：Portkey 的文档和 `models.json` 里都没有单独的价格。这一点有两个影响。其一，它只在“隔了 5 分钟到 1 小时之后再回到这个对话”时才划算——在一次连续的使用里，五分钟就够了；隔了一夜，一小时也不够。这是每个人使用方式上的事实，所以该由每个人自己来设。其二，开着这个开关时，本 provider 报出来的费用是偏低的：每个型号只有一个缓存写入价（`models.json`），是五分钟那一档，所以一小时的写入是按五分钟的价格计的。开着 `cacheTtl1h` 时，请把报出的费用当作下限。

另外，哪些 Claude 型号接受它还未验证，而不接受的型号会直接拒绝请求。

这个开关只在“没有别的要求”时起作用。调用方自己的 `cacheRetention` 仍然优先：`none` 不发检查点，`long` 要求一小时。需要这个开关，是因为 magpie 的桥接层不传 retention，在此之前在那里根本没法要求一小时。

### 拒绝时说什么

拒绝会用网关自己的话来报告，并说明该怎么办；说哪句话取决于是谁拒绝的：

- **AWS**：消息里写明了 IAM action（`is not authorized to perform: bedrock:…`）。保留 action，去掉消息里的账号，因为报错信息会被复制到聊天和截图里。
- **Portkey，401/403/412**：它自己的消息和错误码，并按状态码给出下一步（401/403 查权限和 slug，412 查预算）。
- **其余情况，以及 429**：不算拒绝。SDK 的原始报告原样保留。因为一个 502 就让用户去查 key 的权限，比什么都不说更糟。

而且是哪个请求被拒绝也很重要。模型列表被拒绝时对话还能用，所以保留目录，建议是怎么让列表能用。请求本身被拒绝意味着对话就是坏掉的那个，所以建议是关于 key、预算或 IAM 策略的。

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

规律是：靠读代码得出的关于行为的结论，只是假设；凭记忆想起的数字也一样。在要紧的地方，去跑一遍——对着真实宿主，或者用测试里没有的输入——或者去查，又或者就说不知道。
