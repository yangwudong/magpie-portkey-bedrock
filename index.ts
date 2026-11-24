// Portkey Bedrock: AWS Bedrock through a Portkey gateway, as a pi provider.
// Each module holds one concern; this file only registers the provider.
import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formToCredentials, portkeyLoginForm, type KnownAccounts } from "./src/account.ts";
import { loadConfig } from "./src/config.ts";
import { discoverGatewayModels, toProviderModels } from "./src/models.ts";
import { createPortkeyStream } from "./src/stream.ts";

export { accountFormOf, keyName, NEW_ACCOUNT, rememberAccount, type KnownAccount, type KnownAccounts, type PortkeyAccountForm } from "./src/account.ts";
export { CONFIG_PATH, defaultConfigPath, loadConfig, readConfig } from "./src/config.ts";
export { discoverGatewayModels, toProviderModels, type GatewayModelContext } from "./src/models.ts";
export { createPortkeyStream } from "./src/stream.ts";

const PROVIDER_ID = "portkey-bedrock";
const API_ID = "portkey-bedrock-ai-sdk" as Api;

// Every request goes to its own account's gateway, so the provider has no
// endpoint of its own. pi still wants one to register with; this one is never
// meant to be contacted — `.invalid` (RFC 2606) resolves nowhere, and a
// request reaching streamSimple without an account gateway is refused before
// its key could be sent anywhere else.
const UNROUTED_BASE_URL = "https://account-gateway.invalid/v1";

export default function portkeyAwsExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const models = toProviderModels(config.models, config.headers);
  // The accounts magpie has listed models for, for the sign-in form's
  // update. In memory: magpie hands them over as it lists each account.
  const known: KnownAccounts = new Map();

  pi.registerProvider(PROVIDER_ID, {
    name: "Portkey Bedrock",
    baseUrl: UNROUTED_BASE_URL,
    api: API_ID,
    headers: config.headers,
    models,
    streamSimple: createPortkeyStream(config.headers),
    async refreshModels(context) {
      return await discoverGatewayModels(config, context, globalThis.fetch, known);
    },
    oauth: {
      name: "Portkey Bedrock gateway",
      async login(callbacks) {
        return formToCredentials(await portkeyLoginForm(callbacks, known));
      },
      // A Portkey key never expires on its own; nothing to renew. The far
      // future expiry keeps pi's refresh path from ever running.
      async refreshToken(credentials) {
        return credentials;
      },
      getApiKey(credentials) {
        return String((credentials as { access?: string }).access ?? "");
      },
    },
  });
}
