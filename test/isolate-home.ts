// Tests never read the user's own files: neither the config
// (~/.config/magpie/portkey-bedrock/config.json) nor magpie's plugin list
// (~/.config/magpie/plugins.json). Both point at files that do not exist
// before index.ts loads.
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PORTKEY_BEDROCK_CONFIG = join(tmpdir(), "portkey-bedrock-no-such-config.json");
process.env.PORTKEY_BEDROCK_PLUGINS = join(tmpdir(), "portkey-bedrock-no-such-plugins.json");
