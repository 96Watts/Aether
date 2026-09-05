import { execFileSync } from "node:child_process";
import fs from "node:fs";

const root = new URL("..", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");
const write = (name, content) => fs.writeFileSync(new URL(name, root), content);

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error("Git history is required. Install Git and run this command inside the Aether repository.");
  }
}

function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return match.slice(1).map(Number);
}

function bump(version, significance) {
  const [major, minor, patch] = parseVersion(version);
  if (significance === "MAJOR") return `${major + 1}.0.0`;
  if (significance === "MINOR") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function classify(changes) {
  const text = changes.toLowerCase();
  const major = /breaking|architecture rewrite|breaking change|new generation|fundamental redesign/.test(text);
  const minor = /feat|feature|add(ed|s)?|new provider|new runtime|integration|settings system|update system|installation/.test(text);
  const significance = major ? "MAJOR" : minor ? "MINOR" : "PATCH";
  const reason = changes.split("\n").filter(Boolean).slice(0, 8);
  return { significance, reason: reason.length ? reason : ["No committed changes were found; defaulting to the conservative PATCH bump."] };
}

function currentVersion() {
  return JSON.parse(read("package.json")).version;
}

function latestReleaseVersion() {
  const tag = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]);
  return tag.replace(/^v/, "");
}

function changeLog(previousTag) {
  return git(["log", `${previousTag}..HEAD`, "--format=%s%n%b"]);
}

function synchronize(version) {
  const packageJson = JSON.parse(read("package.json"));
  packageJson.version = version;
  write("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

  const tauriPath = "src-tauri/tauri.conf.json";
  const tauri = JSON.parse(read(tauriPath));
  tauri.version = version;
  write(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`);

  const cargoPath = "src-tauri/Cargo.toml";
  write(cargoPath, read(cargoPath).replace(/^(version\s*=\s*")[^"]+("\s*$)/m, `$1${version}$2`));
}

function prepare() {
  const previousTag = `v${latestReleaseVersion()}`;
  const previousVersion = latestReleaseVersion();
  const decision = classify(changeLog(previousTag));
  const nextVersion = bump(previousVersion, decision.significance);
  synchronize(nextVersion);
  console.log(`Aether v${nextVersion}`);
  console.log(`Version bump: ${decision.significance}`);
  console.log("Why:");
  decision.reason.forEach((line) => console.log(`- ${line}`));
  console.log(`Previous version: ${previousVersion}`);
  console.log(`New version: ${nextVersion}`);
  console.log("Updated package.json, src-tauri/tauri.conf.json, and src-tauri/Cargo.toml.");
  console.log("No tag, push, or GitHub release was created.");
}

function publish() {
  const version = currentVersion();
  console.log(`Prepared Aether v${version}. Create and push tag v${version} to trigger the signed GitHub Actions release.`);
}

const command = process.argv[2] ?? "prepare";
if (command === "prepare") prepare();
else if (command === "publish") publish();
else throw new Error(`Unknown release command: ${command}`);