import fs from "node:fs";

const endpoint = process.env.AETHER_UPDATE_ENDPOINT;
const publicKey = process.env.TAURI_SIGNING_PUBLIC_KEY;

if (!endpoint || !publicKey) {
  throw new Error("AETHER_UPDATE_ENDPOINT and TAURI_SIGNING_PUBLIC_KEY are required to configure a release build.");
}
if (!endpoint.startsWith("https://")) throw new Error("AETHER_UPDATE_ENDPOINT must use HTTPS.");

const configPath = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.plugins ??= {};
config.plugins.updater = { pubkey: publicKey, endpoints: [endpoint] };
config.bundle.createUpdaterArtifacts = true;
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);