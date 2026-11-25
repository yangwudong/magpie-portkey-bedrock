# Portkey reference

What this provider relies on Portkey for, where each fact comes from, and
why the switches are what they are. Written after reading Portkey's
documentation and the open-source gateway (v1.15.2, commit `669825c`) in
November 2026, so that the next change here does not have to find all this
again — or repeat the mistakes recorded at the end.

## Reading Portkey's documentation

The documentation is published by Mintlify in machine-readable forms, which
are far better than scraping the HTML. `docs.portkey.ai` is the canonical
host of `portkey.ai/docs`.

| What | Where |
| --- | --- |
| Index of every page | `https://docs.portkey.ai/docs/llms.txt` |
| Section indexes | `https://docs.portkey.ai/docs/_llms/latest/{docs,integrations,admin-apis}.txt` |
| Whole site in one file (~1.6 MB) | `https://docs.portkey.ai/docs/llms-full.txt` |
| One page as Markdown | the page's URL with `.md` appended, e.g. `https://docs.portkey.ai/docs/api-reference/inference-api/headers.md` |
| OpenAPI specification | the `Portkey-AI/openapi` repository |

The single-page form is the one to use: fetch the index, take the pages that
matter, read those. Some of what follows is not in the documentation at all,
and came from the gateway's source instead; the table below says which is
which for every fact.

## What this provider sends

A request is the Bedrock Converse streaming protocol, not Portkey's
OpenAI-compatible API: `POST {baseUrl}/model/{encoded model id}/converse-stream`
with an AWS event-stream body in reply. It is built by
`@ai-sdk/amazon-bedrock` pointed at the account's gateway.

That choice decides what applies here. Most of Portkey's documentation
describes its unified API (`/v1/chat/completions`), where features such as
`reasoning_effort`, `cache_control` blocks and `guardrailConfig` are request
body fields. None of them are used by this provider: the body is Converse's,
and Bedrock-specific features go in it as Converse fields
(`additionalModelRequestFields`, `cachePoint`). Only what travels in a
**header** is certain to work the same way on this route.

Headers sent on every request:

| Header | Value | From |
| --- | --- | --- |
| `x-portkey-api-key` | the account's key | the sign-in form |
| `Authorization` | `Bearer` with the same key | the SDK's API-key mode |
| `x-portkey-provider` | the account's provider slug | the sign-in form |
| `x-portkey-config` | a config id, or an inline retry config | `configId`, or the `retry` switch |
| `x-portkey-debug` | `false` | the `log` switch |

## Facts, and where each comes from

"Documented" means Portkey's documentation says it. "Source" means it was
read in the open-source gateway. "Unverified" means this provider depends on
it and nobody has confirmed it against the managed gateway on this route.

### Authentication

- `x-portkey-api-key` is the Portkey key. **Documented** — `api-reference/inference-api/headers`.
- Portkey converts a provider's `Authorization: Bearer` into whatever the upstream expects. **Documented** — same page, "Provider Slug + Auth".
- A provider slug is `@provider-slug` for one in the Model Catalog, or a plain name such as `bedrock` for direct credentials. **Documented** — same page, "AI Provider" and "Custom Host".
- The sign-in form's default slug is `aws-bedrock`. **Unverified**: the documentation names `bedrock`, not `aws-bedrock`.

### Logging

- `x-portkey-debug: false` is Portkey's "DO NOT TRACK": the request and response content is left out of the logs, while tokens, cost and latency are kept. **Documented** — `product/observability/logs`, "DO NOT TRACK". The header is named "debug" but only decides whether content is stored.
- That it is honoured on `/model/{id}/converse-stream`. **Unverified**: the documentation shows it on `/v1/chat/completions` only.
- There is no per-request way to store nothing at all. The organization-wide setting (`Admin Settings → Organization Properties → Request Logging`, Full Logging or Metrics Only) is an Enterprise-plan feature for organization owners, and Metrics Only is the same as the header. **Documented** — `product/administration/configuring-request-logging`.
- Changing to Metrics Only does not remove what was already logged. **Documented** — same page.

### Retries

- The `retry` config object has `attempts` (required), `on_status_codes` and `use_retry_after_headers`. **Documented** — `api-reference/inference-api/config-object`.
- A config may be an inline JSON object in the `x-portkey-config` header, which is also where a saved config id goes. **Documented** — `integrations/libraries/vercel`, "Inline Config".
- The wait before each retry is 1s, 2s, 4s, 8s, 16s. **Documented** in `product/ai-gateway/automatic-retries`, and confirmed in source: `retryRequest` (`handlers/retryHandler.ts`) calls `async-retry`, whose `retry@0.13.1` computes `minTimeout(1000) × factor(2) ^ attempt` with `attempt` from 0.
- Which status codes are retried by default. **Documented** as `[429, 500, 502, 503, 504, 529]`; the open-source `globals.ts` has `RETRY_STATUS_CODES = [429, 500, 502, 503, 504]`, without 529. **Unverified** which the managed gateway uses. 529 is an Anthropic overload code, so the difference may matter; setting `on_status_codes` explicitly would remove the doubt.
- With `use_retry_after_headers`, a `retry-after-ms`, `x-ms-retry-after-ms` or `retry-after` from the provider replaces the backoff; without such a header the backoff stands. **Documented** — same page.
- The cumulative wait is capped at 60 seconds, and a single `Retry-After` of 60 seconds or more ends the retries at once. **Documented** on the same page and in source: `MAX_RETRY_LIMIT_MS = 60 * 1000`, and `retryRequest` throws instead of waiting when `retryAfter >= MAX_RETRY_LIMIT_MS` or it exceeds what is left.
- Status codes outside the retried set are returned at once, not retried. **Source** — `retryRequest` calls `bail` for them.
- `x-portkey-retry-attempt-count` on the response: `-1` all retries exhausted, `0` none configured, `>0` succeeded on that retry. **Documented** — `product/ai-gateway/automatic-retries`, "Retry Attempt Header".

### Request timeouts

- `x-portkey-request-timeout` (milliseconds) ends a request that runs long, and Portkey then answers `408`. **Documented** — `product/ai-gateway/request-timeouts`.
- For a streaming request it is not triggered once at least one chunk has arrived. **Documented** — same page, "Caveats". This provider's own `timeoutMs` is a limit on the whole request instead; the two are not the same thing.

### The model list

- `GET /v1/models` answers in one of two modes. With an `@provider-slug` in `x-portkey-provider` (or a config with `provider`/`targets`), it proxies the provider's own list. Without one, it returns the workspace's Model Catalog. **Documented** — `api-reference/inference-api/models/models`.
- AWS Bedrock is among the providers whose list it can proxy. **Documented** — same page, "Supported Providers".
- `x-portkey-fetch-integrated-models: true` returns the Model Catalog's models even when a provider is given. **Documented** — same page. Not used here; it only matters once a request reaches the routing layer.
- The route requires a key with the `models.list` or `completions.write` scope. **Documented** on the models page; the help page `help-center/you-do-not-have-enough-permissions` says `completions.write` or `virtual_keys.list`.
- What the managed gateway answered, in November 2026, for a real key: `HTTP 403` with the body `{"status":"failure","message":"Portkey Error: Forbidden!. Error Code: 033","error":{"message":"Portkey Error: Forbidden!. Error Code: 033","code":"033"}}`, and no `x-portkey-trace-id` header. **Observed once**; the meaning of `033` is **unverified**: no documentation defines it, and `portkey.ai/error-library/033` does not exist. By its shape it is Portkey's own refusal, made before the request reached a provider.

### Errors

- Portkey's own errors are prefixed "Portkey Error"; a provider's errors are returned as they are. **Documented** — `support/common-errors-and-resolutions`.
- Status codes with a meaning of Portkey's: `408` timed out, `412` budget exhausted, `429` rate limited, `446` a guardrail denied the request, `246` a guardrail check failed on a successful request. **Documented** — `api-reference/inference-api/error-codes`.
- Every response carries `x-portkey-trace-id`, `x-portkey-retry-attempt-count`, `x-portkey-cache-status` and `x-portkey-last-used-option-index`. **Documented** — `api-reference/inference-api/response-schema`.
- `Invalid response received from bedrock: {…}` is the gateway's fallback when a provider's response has a shape it cannot read: `generateInvalidProviderResponseError` in `src/providers/utils.ts`, returned by the Bedrock chat and messages transforms. **Source**: it is not this provider's wording.

### Prompt caching

- Bedrock caches at explicit checkpoints, `cachePoint: { type: "default" }`; `ttl: "1h"` asks for the one-hour TTL. **Documented** — `integrations/llms/bedrock/prompt-caching`.
- Portkey's table lists the one-hour TTL for Claude Opus 4.5, Sonnet 4.5 and Haiku 4.5, and five minutes only for the others it lists. Nova caches on its own, up to 20K tokens, without tools. **Documented** — same page.
- That later Claude models (the 5.x ones in this catalog) accept `ttl: "1h"`. **Unverified**: Portkey's table does not list them, which is as likely the table being behind as the models refusing.
- What a one-hour checkpoint costs to write, against a five-minute one. **Unverified**: none of the documentation read has a price for it. `models.json` carries one cache-write price per model, 1.25× its input price, and 0.1× for a read.
- Portkey's simple cache (`cache: { mode: "simple" }`) is something else: it stores whole responses and needs the entire request to match, so it never hits across turns of a conversation. **Documented** — `integrations/libraries/claude-code-gateway-compatibility`, "Gateway caching".
- A guardrail that rewrites the request (PII redaction) causes a cache miss on every turn. **Documented** — same page, "Guardrails".

### What was considered and left out

- `x-portkey-metadata`, `x-portkey-trace-id` and `x-portkey-span-id` would group requests into traces in Portkey's Logs view, and `x-portkey-bedrock-map-metadata: true` passes metadata on as Bedrock request metadata. **Documented** (`product/observability/metadata`, `product/observability/traces`, `integrations/llms/bedrock/aws-bedrock`). Left out: they are only useful with logging on, and the `log` switch is off by default.
- AWS STS session tags from metadata, for cost attribution in Cost Explorer. Enterprise self-hosted only. **Documented** — `guides/use-cases/aws-bedrock-cost-attribution-with-sts-session-tags`.
- The Bedrock Mantle provider (`bedrock-mantle`), an OpenAI-compatible route to Bedrock. **Documented** — `integrations/llms/bedrock-mantle`. Not used: `@ai-sdk/amazon-bedrock` has a `./mantle` entry for it, but it has no explicit cache checkpoints, which is what this provider is for.
- Whether `guardrailConfig` and `additionalModelRequestFields` in a Converse body are passed through untouched on `/model/{id}/converse-stream`. **Unverified**: `additionalModelRequestFields` is relied on for reasoning effort and has worked.

## Why the switches are what they are

The three switches are read from two places. magpie's Options (the Plugins
page's editor, saved to `plugins.json`) wins over the config file, which wins
over the default. `DEFAULT_SWITCHES` in `src/config.ts` holds the defaults and
the reason for each; `magpie.options` in `package.json` is what the Options
editor opens on, and a test keeps the two equal.

### `log`: off

The only per-request control there is, and it does less than its name
suggests: content is left out, usage records are not. Off by default because
"my prompts and answers are stored in a third party's log" is the thing a
user is least likely to want without having asked for it, and the failure
direction is right: a config that cannot be read falls back to off.

Still unverified on this route (see above). Until it is, the switch promises
that the header is sent, not that nothing is stored.

### `retry`: 2

The question is who retries a failed request: Portkey, on the same account,
or magpie, on another one. Two things decide it.

**The prompt cache follows the account.** A cache is written under the AWS
credentials behind the route. When magpie fails over to another account, that
account has no cache for the conversation and pays to write one again: at
1.25× the input price, against 0.1× for a read, as `models.json` has it for
every Claude model in the catalog. A retry that stays on the same account
keeps it.

**A retry absorbs what failover cannot fix.** Portkey retries only `429` and
the `5xx` codes; everything else goes straight back. So a brief throttle is
handled where it happens, and magpie's failover is kept for what it is for:
an account that is out of budget (`412`) or not allowed something (`403`),
where switching accounts is exactly the right move.

The cost is the waiting, when a request keeps failing:

| `retry` | Waits | Total | Requests made |
| --- | --- | --- | --- |
| 0 | — | 0s | 1 |
| 1 | 1s | 1s | 2 |
| **2** | 1s, 2s | **3s** | 3 |
| 3 | 1s, 2s, 4s | 7s | 4 |
| 5 | 1s, 2s, 4s, 8s, 16s | 31s | 6 |

Two retries cover a brief throttle for three seconds at the most. A third
costs four more seconds for a try that rarely helps: if the account is still
throttled after three seconds it is usually throttled for longer. And when
Bedrock says how long to wait, Portkey listens: told to wait a minute or
more, it stops at once, so an account that is down for long reaches magpie
without the delay.

`use_retry_after_headers` is sent as `true` for that last reason: it makes
the wait Bedrock's to name, within the 60-second cap.

The retry config goes in `x-portkey-config` as inline JSON, because that is
the header. A saved config id uses it too, and one header cannot hold both,
so when `configId` is set (or the header is in `headers`), the switch gives
way: replacing the id with a bare retry config would drop everything else the
saved config holds. Put `retry` in that saved config instead.

For an account that is throttled for long, `0` hands every failure to magpie
at once; that is the setting to choose when a fast failure matters more than
the cache.

### `cacheTtl1h`: off

The hour is not simply better than five minutes. A checkpoint kept for an
hour is said to cost more to write, though by how much is not in anything
read for this: neither Portkey's documentation nor `models.json` has a
separate price for it. That matters twice over. It only pays when the
conversation is picked up again between five minutes and an hour later —
within one sitting the five minutes are enough, after a night the hour is
not, which is a fact about how each person uses the tool and theirs to set.
And the cost this provider reports is wrong with the switch on: it has one
cache-write price per model (`models.json`), the five-minute one, so the
hour's writes are counted at the five-minute price. Take the reported cost
as a lower bound with `cacheTtl1h` on.

It is also unverified which Claude models accept it, and a model that does
not refuses the request.

The switch only acts where nothing was asked. A caller's own `cacheRetention`
stands: `none` sends no checkpoint, `long` asks for the hour. It was needed
because magpie's bridge names no retention, so the hour could not be asked
for there at all before.

### What a refusal says

A refusal is reported in the gateway's words with what to do about it, and
which words depends on who refused:

- **AWS**: the message names the IAM action (`is not authorized to perform:
  bedrock:…`). The action is kept and the account in the message is left out,
  because an error message gets copied into chats and screenshots.
- **Portkey, 401/403/412**: its own message and code, with the next step by
  status (scopes and slug for 401/403, the budget for 412).
- **Anything else, and 429**: not a refusal. The SDK's account of it is kept
  whole. Sending a user to check their key's scopes over a 502 is worse than
  saying nothing.

And it matters which request was refused. The model list refused leaves chat
working, so the catalog stands in and the advice is how to get the list. The
request itself refused means chat is what broke, so the advice is about the
key, the budget or the IAM policy.

`x-portkey-trace-id` is added to every failure that has one, so the request
can be found in Portkey.

## Mistakes made along the way

Recorded because each cost a wrong statement to the user, and all were
catchable by checking first.

1. **Said the gateway calls `bedrock:ListFoundationModels` before each
   inference request.** It does not: the open-source gateway calls
   `GetInferenceProfile`, only for a model given as an ARN, and swallows the
   failure. The claim came from reading one paragraph of documentation as
   more than it said.

2. **Said a pi extension could declare magpie's Off/On switches.** It cannot:
   `pi.js` builds the `auth` object with four fixed fields and hands the
   extension no `input.magpie`. A probe against the real host answered
   `"options": []`. Found by testing, not by reading; the reading had said
   yes twice.

3. **Simulated a restart with a second `init` in the same host process**, and
   took the switch not applying for a bug. The extension module is cached per
   process. magpie restarts the host for real (`store.SetOptions` ends in
   `Restart()`), so the test had to start a new process.

4. **Treated every non-2xx reply as a refusal** and replaced the SDK's error
   with advice about key scopes — for a 502 too. Every test passed; a probe
   with inputs the tests did not cover found it.

5. **Read tests that depend on the user's real `plugins.json`.** The
   isolation preload covered the config file only.

6. **Stated the retry backoff as 2s, 4s, 8s, and called the documentation's
   1s, 2s, 4s idealistic.** The documentation was right. The library's
   `attempt` starts at 0; the exponent was taken as starting at 1.

7. **Said `retry` should stay 0 with several accounts**, then the opposite.
   The first answer weighed only how fast failover happens, and not what
   failover does to the cache.

8. **Said a one-hour cache write costs about twice a five-minute one**, and
   wrote the ratio into advice before checking it. No documentation read has
   the price. The direction was kept, as "said to cost more", and marked
   unverified; the number was dropped.

The pattern: a statement about behaviour from reading code is a hypothesis,
and so is a number remembered rather than looked up. Where it matters, run
it — against the real host, or with an input the tests do not have — or look
it up, or say it is not known.
