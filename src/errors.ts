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
