// Tests never read the user's own config (~/.config/magpie/portkey-bedrock):
// the config path points at a file that does not exist before index.ts loads.
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PORTKEY_BEDROCK_CONFIG = join(tmpdir(), "portkey-bedrock-no-such-config.json");
