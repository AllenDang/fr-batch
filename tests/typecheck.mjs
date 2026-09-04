#!/usr/bin/env node
/**
 * Typecheck fr-batch against whatever pi install this machine actually has.
 *
 * tsconfig.json used to name `/opt/homebrew/lib/node_modules/...` four times, which is
 * one node installation out of several: with pi installed through nvm the whole path is
 * absent, so `tsc -p tsconfig.json` reported the pi packages as unresolved and an editor
 * opening the repo showed the same errors. Nothing about the code was wrong.
 *
 * So the committed tsconfig now points at `.types/`, and this script populates `.types/`
 * with symlinks to the packages pi already ships. That keeps the property the README
 * claims — no `npm install`, no bundler, no vendored copies — while moving the one
 * machine-specific fact out of a committed file.
 *
 *   node tests/typecheck.mjs              # link, then typecheck
 *   node tests/typecheck.mjs --link-only  # just refresh .types/ (for an editor/LSP)
 *   PI_PKG_ROOT=/path/to/lib/node_modules node tests/typecheck.mjs
 *
 * The link step is idempotent and re-points a stale link, so a pi reinstall under a
 * different node needs no cleanup.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_PKG = join("@earendil-works", "pi-coding-agent");
/** Proof that a candidate really is a node_modules root with pi in it. */
const probe = (root) => existsSync(join(root, AGENT_PKG, "dist", "index.d.ts"));

function findPkgRoot() {
  const candidates = [];
  if (process.env.PI_PKG_ROOT) candidates.push(process.env.PI_PKG_ROOT);
  try {
    // The authoritative answer, and the only one that follows a node version manager.
    candidates.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim());
  } catch {
    // npm missing or not on PATH — the fallbacks below still cover the common layouts.
  }
  // <node>/bin/node -> <node>/lib/node_modules, which is where every manager puts it.
  candidates.push(resolve(dirname(process.execPath), "..", "lib", "node_modules"));
  candidates.push("/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules");

  for (const c of candidates) {
    if (c && probe(c)) return c;
  }
  const tried = candidates.filter(Boolean).join("\n  ");
  throw new Error(
    `Could not find pi's global install (looked for ${AGENT_PKG}/dist/index.d.ts under):\n  ${tried}\n\n` +
      `Install pi (npm install -g --ignore-scripts @earendil-works/pi-coding-agent) or point\n` +
      `PI_PKG_ROOT at the node_modules directory that holds it.`,
  );
}

/** Symlink `name` -> `target`, replacing a link that points somewhere else. */
function link(typesDir, name, target) {
  const path = join(typesDir, name);
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === target) return;
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Nothing there yet.
  }
  if (!existsSync(target)) throw new Error(`Expected ${target} in pi's install; not there.`);
  // "junction" is what lets this run on Windows without developer mode or elevation.
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function findTsc(pkgRoot) {
  const local = join(repo, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  if (existsSync(local)) return { cmd: local, args: [] };
  const global = join(pkgRoot, "typescript", "bin", "tsc");
  if (existsSync(global)) return { cmd: process.execPath, args: [global] };
  return null;
}

const pkgRoot = findPkgRoot();
const agent = join(pkgRoot, AGENT_PKG);
const nested = join(agent, "node_modules");
const typesDir = join(repo, ".types");
mkdirSync(typesDir, { recursive: true });
link(typesDir, "pi-coding-agent", agent);
link(typesDir, "pi-ai", join(nested, "@earendil-works", "pi-ai"));
link(typesDir, "typebox", join(nested, "typebox"));
link(typesDir, "@types", join(nested, "@types"));
console.log(`.types/ -> ${pkgRoot}`);

// pi's bundled @types is the FIRST typeRoot, not the only one. A pi update can ship without it — one
// did, and every check here failed with `Cannot find type definition file for 'node'` while the
// symlink itself was perfectly valid, because the link resolved to an empty directory. tsconfig
// therefore also lists ./node_modules/@types, and this says which root actually supplied it, so the
// next person reads a diagnosis instead of re-deriving one.
const nodeTypes = [join(typesDir, "@types", "node"), join(repo, "node_modules", "@types", "node")].filter((p) => existsSync(p));
if (nodeTypes.length === 0) {
  console.error(
    [
      "",
      "@types/node is in NEITHER type root, so nothing below will resolve:",
      `  ${join(typesDir, "@types", "node")}   (pi's bundled copy — a pi update may have dropped it)`,
      `  ${join(repo, "node_modules", "@types", "node")}   (local fallback)`,
      "",
      "  npm install --no-save @types/node",
      "",
    ].join("\n"),
  );
} else {
  console.log(`@types/node <- ${nodeTypes[0].startsWith(typesDir) ? "pi's bundle" : "local node_modules (pi's bundle has none)"}`);
}

if (process.argv.includes("--link-only")) process.exit(0);

const tsc = findTsc(pkgRoot);
if (!tsc) {
  console.error(
    `\nNo tsc found. Either is fine:\n` +
      `  npm install -g typescript          # global, shared by every checkout\n` +
      `  npm install --no-save typescript   # here only (node_modules/ is gitignored)\n\n` +
      `.types/ is linked, so an editor already resolves the pi packages either way.`,
  );
  process.exit(2);
}
try {
  // The VERSION is printed, because "typecheck: clean" is not attributable without it. A local
  // node_modules/typescript is gitignored, so one checkout can be pinned to an old tsc while a
  // fresh clone picks up the current one — and this repo's committed tsconfig was accepted by
  // 5.9.3 and REJECTED by 7.0.2 (TS5090 on non-relative `paths`, TS5102 on `baseUrl`), which is
  // invisible if the version is not on screen.
  const version = execFileSync(tsc.cmd, [...tsc.args, "--version"], { encoding: "utf8" }).trim();
  execFileSync(tsc.cmd, [...tsc.args, "-p", join(repo, "tsconfig.json")], { stdio: "inherit" });
  console.log(`typecheck: clean (${version})`);
} catch {
  process.exit(1);
}
