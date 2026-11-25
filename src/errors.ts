// Error text: what failed, and for blocked responses, why.
import type { FinishReason } from "ai";

// Bedrock's trace.guardrail names what fired: input/output assessments keyed
// by guardrail id, each holding policy sections (topicPolicy.topics,
// contentPolicy.filters, wordPolicy.customWords, sensitiveInformationPolicy
// .piiEntities, ...). Report every entry that took an action.
export function guardrailFindings(trace: unknown): string[] {
  const guardrail = (trace as { guardrail?: Record<string, unknown> } | undefined)?.guardrail;
  if (!guardrail || typeof guardrail !== "object") return [];
  const findings = new Set<string>();
  const visit = (where: string, assessment: unknown) => {
    if (!assessment || typeof assessment !== "object") return;
    for (const [policy, sections] of Object.entries(assessment)) {
      if (!sections || typeof sections !== "object") continue;
      for (const entries of Object.values(sections)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries as Record<string, unknown>[]) {
          if (!entry || typeof entry.action !== "string" || entry.action === "NONE") continue;
          const what = [entry.name, entry.type, entry.match].filter((v) => typeof v === "string" && v).join(" ");
          const confidence = typeof entry.confidence === "string" ? `, confidence ${entry.confidence}` : "";
          findings.add(`${where} ${policy}${what ? ` ${what}` : ""} ${entry.action}${confidence}`);
        }
      }
    }
  };
  for (const [id, assessment] of Object.entries((guardrail.inputAssessment ?? {}) as Record<string, unknown>)) {
    visit(`input[${id}]`, assessment);
  }
  for (const [id, list] of Object.entries((guardrail.outputAssessments ?? {}) as Record<string, unknown>)) {
    for (const assessment of Array.isArray(list) ? list : [list]) visit(`output[${id}]`, assessment);
  }
  return [...findings];
}

// Name the cause so a blocked response is not mistaken for a gateway outage.
export function finishErrorMessage(reason: FinishReason | undefined, raw: string | undefined, trace?: unknown): string {
  const detail = raw ? ` (stopReason: ${raw})` : "";
  if (reason === "content-filter") {
    const by = raw === "guardrail_intervened" ? "a Bedrock/Portkey guardrail" : "Bedrock content filtering";
    const fired = guardrailFindings(trace);
    return `Response blocked by ${by}${detail}. ` +
      (fired.length ? `Bedrock reported: ${fired.join("; ")}. ` : "") +
      "This is a content policy decision, not a gateway failure; " +
      "retrying the same request will likely be blocked again. Check the guardrail logs in Portkey to see which rule fired.";
  }
  return `Portkey returned an error finish reason${detail}`;
}

// What a refusal from the gateway was. Portkey's own carry a code but no
// reason ("Portkey Error: Forbidden!. Error Code: 033"); AWS's name the IAM
// action they denied and the account that was denied it. The account is left
// out on purpose: an error message gets copied into chats and screenshots.
export type GatewayRefusal =
  | { kind: "aws"; action: string }
  | { kind: "portkey"; status: number; quoted: string }
  | { kind: "unknown"; status: number; quoted: string };

export function readGatewayRefusal(status: number, body: unknown): GatewayRefusal {
  const text = typeof body === "string" ? body : body == null ? "" : JSON.stringify(body);
  // Portkey repeats the same sentence in `message` and `error.message`; one
  // copy is enough, and leaves the quote room for whatever else it said.
  // The body usually arrives as text, so it is parsed here when it is JSON.
  let object = body;
  if (typeof body === "string") {
    try { object = JSON.parse(body); } catch { object = undefined; }
  }
  const error = typeof object === "object" && object !== null ? (object as { error?: { message?: unknown } }).error : undefined;
  const said = typeof error?.message === "string" ? error.message : text;
  const quoted = said.replace(/\s+/g, " ").trim().slice(0, 300);
  const iam = /is not authorized to perform:?\s*([a-zA-Z0-9:*_-]+)/.exec(text);
  if (iam) return { kind: "aws", action: iam[1] };
  if (status === 401 || status === 403 || status === 412) return { kind: "portkey", status, quoted };
  return { kind: "unknown", status, quoted };
}

// The refusal as one sentence, without what to do about it: that depends on
// which request was refused, and the caller knows.
function refusalLine(refusal: GatewayRefusal): string {
  switch (refusal.kind) {
    case "aws":
      return `AWS denied ${refusal.action} for the credentials behind this Portkey route`;
    case "portkey":
      return refusal.status === 412
        ? `Portkey stopped the request: a budget is exhausted (HTTP 412)${quote(refusal.quoted)}`
        : `Portkey refused the request (HTTP ${refusal.status})${quote(refusal.quoted)}`;
    default:
      return `Portkey answered HTTP ${refusal.status}${quote(refusal.quoted)}`;
  }
}

// A quoted body, with the space before it; none for an empty one.
function quote(quoted: string): string {
  return quoted ? ` ${quoted}` : "";
}

// For the model list. It is refused by a key that may not list models, or by
// AWS credentials that may not; chat works either way, so the catalog stands
// in and the user is told what would make the list work. Anything else (a
// 5xx, a body that is no error the gateway owns) is only reported: there is
// nothing here a user could act on, so they are not sent looking for one.
export function modelListRefusal(status: number, body: unknown): string {
  const refusal = readGatewayRefusal(status, body);
  if (refusal.kind === "unknown") return `${refusalLine(refusal)}. Chat is unaffected; the built-in catalog stays.`;
  const advice = refusal.kind === "aws"
    ? `To list the gateway's models, allow ${refusal.action} on the Portkey user, or list the models by hand in config.json.`
    : refusal.kind === "portkey" && refusal.status === 412
      ? "Raise or wait for the budget of this API key or provider."
      : "Check that the API key may list models (the completions.write scope) and that the provider slug belongs to the key's workspace.";
  return `${refusalLine(refusal)}. Chat is unaffected; the built-in catalog stays. ${advice}`;
}

// For the request itself. Unlike the model list, chat is what broke, so the
// advice is about the key, the budget or the AWS permissions, not a way
// around it. Nothing is returned for a failure that is no refusal the gateway
// owns: the caller then has the SDK's own account of it, which is the better
// one (its status, the body, the exception Bedrock named).
export function requestRefusal(status: number, body: unknown): string | undefined {
  const refusal = readGatewayRefusal(status, body);
  if (refusal.kind === "unknown") return undefined;
  const advice = refusal.kind === "aws"
    ? `Allow ${refusal.action} on the AWS principal behind this Portkey route.`
    : refusal.kind === "portkey" && refusal.status === 412
      ? "Raise or wait for the budget of this API key or provider."
      : "Check the API key's scopes and that the provider slug belongs to the key's workspace.";
  return `${refusalLine(refusal)}. ${advice}`;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    const apiError = error as Error & { responseBody?: unknown; statusCode?: number; type?: unknown };
    const responseBody =
      typeof apiError.responseBody === "string"
        ? apiError.responseBody
        : apiError.responseBody === undefined
          ? undefined
          : JSON.stringify(apiError.responseBody);
    const message = apiError.message || "API request failed";
    // Bedrock's in-stream exceptions carry their name (validationException,
    // throttlingException, ...) as type; keep it so the cause is visible.
    const type = typeof apiError.type === "string" && !message.startsWith(apiError.type) ? apiError.type : undefined;
    return [
      type ? `Bedrock ${type}: ${message}` : message,
      apiError.statusCode ? `(HTTP ${apiError.statusCode})` : undefined,
      responseBody,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
