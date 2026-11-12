// Accounts: the sign-in form, its credential, and per-account routing.
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";

// A signed-in account carries its own gateway routing next to its key. The
// values live in the credential (magpie's plugin-auth.json, never tracked
// files) and reach each request as `options.env`, where pi resolves the
// `$VAR` header templates below per account. The base URL rides along as a
// courier header that streamSimple strips before calling the SDK.
export const BASE_URL_ENV = "PORTKEY_BASE_URL";
export const PROVIDER_ENV = "PORTKEY_PROVIDER";
export const BASE_URL_HEADER = "x-portkey-account-base-url";
const FAR_FUTURE = 4_102_444_800_000; // 2100-01-01: no refresh is ever due.

// A login form's answers: what magpie's sign-in dialog asked, one field at a time.
export interface PortkeyAccountForm {
  baseUrl: string;
  provider: string;
  apiKey: string;
  /** The name magpie lists the account under: the user's alias, else one derived from the key. */
  name: string;
}

// The account name when the user gives no alias: enough of the key to tell
// accounts apart at a glance without showing it. Portkey keys often share a
// prefix, so both ends are kept — a prefix alone would give two accounts the
// same name, and magpie takes two sign-ins of one name for one account.
export function keyName(apiKey: string): string {
  if (apiKey.length <= 8) return "API key";
  return `API key ${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

// Decodes an account's credential back into the form that created it.
export function accountFormOf(credential: unknown): PortkeyAccountForm | undefined {
  const record = credential && typeof credential === "object" ? (credential as Record<string, unknown>) : undefined;
  if (!record) return undefined;
  const env = record.env && typeof record.env === "object" ? (record.env as Record<string, string>) : undefined;
  const key = typeof record.access === "string" && record.access ? record.access : undefined;
  const baseUrl = env?.[BASE_URL_ENV];
  const provider = env?.[PROVIDER_ENV];
  if (!key || !baseUrl || !provider) return undefined;
  const name = typeof record.accountId === "string" && record.accountId ? record.accountId : keyName(key);
  return { baseUrl, provider, apiKey: key, name };
}

// OAuthCredentials keeps `access` (the key magpie sends as Bearer) and any
// extra fields; `env` rides the credential so pi resolves the header
// templates with it on every request of this account. `accountId` is what
// magpie names the account by in its lists and sign-in notices — and also
// how it recognises a sign-in to an account it already has: signing in
// again under the same name updates that account instead of adding one.
export function formToCredentials(form: PortkeyAccountForm) {
  return {
    access: form.apiKey,
    refresh: form.apiKey,
    expires: FAR_FUTURE,
    accountId: form.name,
    env: { [BASE_URL_ENV]: form.baseUrl, [PROVIDER_ENV]: form.provider },
  };
}

// Resolves `$VAR` header templates against an account's env map, as pi's
// provider layer does. A header whose template the env cannot answer is
// left out rather than sent as its own `$VAR` text.
export function resolveTemplateHeaders(headers: Record<string, string>, env: Record<string, string> | undefined): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    let missing = false;
    const text = value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_whole, name: string) => {
      const found = env?.[name];
      if (!found) missing = true;
      return found ?? "";
    });
    if (!missing) resolved[key] = text;
  }
  return resolved;
}

// The sign-in form magpie renders in its dialog: each onPrompt is one GUI
// input, asked and answered in turn; no browser, no extra confirmation — the
// last answer saves the account. Three fields route the account; the fourth,
// an optional name, only labels it in magpie's lists (empty: part of the key).
//
// Placeholders are always Portkey's public defaults, never another account's
// values. An empty answer means the default the placeholder shows.
//
// magpie's bridge restarts a login that has already finished when the front
// end asks the method again, and the front end does ask again right after the
// last answer, before it authorizes. A login that simply returned would be
// restarted and the dialog would loop back to the first field. So after the
// last answer the login announces progress — the bridge wakes the waiting
// round on any notice, and with no question and no URL pending that round
// reports the form done — and stays in flight a moment longer. The front
// end's next round then finds the login still running and waits for it
// instead of restarting it, and authorize collects the result. No state is
// kept between sign-ins.
const FINISH_HOLD_MS = 1_000;
const DEFAULT_BASE_URL = "https://api.portkey.ai/v1";
const DEFAULT_PROVIDER = "aws-bedrock";

export async function portkeyLoginForm(callbacks: OAuthLoginCallbacks): Promise<PortkeyAccountForm> {
  const ask = async (message: string, placeholder: string) =>
    (await callbacks.onPrompt({ message, placeholder })).trim();

  const baseUrl = (await ask("Portkey gateway base URL", DEFAULT_BASE_URL)) || DEFAULT_BASE_URL;
  const provider = (await ask("Portkey provider slug (x-portkey-provider)", DEFAULT_PROVIDER)) || DEFAULT_PROVIDER;
  const apiKey = await ask("Portkey API key", "pk-…");
  if (!apiKey) throw new Error("A Portkey API key is required");
  if (!/^https?:\/\/\S+$/i.test(baseUrl)) throw new Error(`The base URL must start with http:// or https://, not ${baseUrl}`);
  const derived = keyName(apiKey);
  const name = (await ask("Account name (optional, leave empty to use part of the key)", derived)) || derived;

  callbacks.onProgress?.("Saving the Portkey account…");
  await new Promise((resolve) => setTimeout(resolve, FINISH_HOLD_MS));
  return { baseUrl, provider, apiKey, name };
}
