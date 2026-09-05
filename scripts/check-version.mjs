import fs from "node:fs";

const root = new URL("..", import.meta.url);
const packageVersion = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8")).version;
const tauriVersion = JSON.parse(fs.readFileSync(new URL("src-tauri/tauri.conf.json", root), "utf8")).version;
const cargo = fs.readFileSync(new URL("src-tauri/Cargo.toml", root), "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];

if (!cargoVersion || packageVersion !== tauriVersion || packageVersion !== cargoVersion) {
  throw new Error(`Version metadata is inconsistent: package=${packageVersion}, tauri=${tauriVersion}, cargo=${cargoVersion ?? "missing"}`);
}

console.log(`Aether version ${packageVersion}`);