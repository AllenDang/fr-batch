#!/usr/bin/env node
// Guard tests for fr-batch. Run: node tests/run.mjs
//
// The probes import the REAL modules directly (`../driver.ts`, `../render.ts`, …). That is
// possible because every value import from a pi package lives in `index.ts` alone, which no
// probe touches, and because node erases `import type` before resolving it — so a module
// that types a parameter as `ExtensionAPI` still runs under plain node.
//
// This replaced a harness that copied index.ts and rewrote three fragments of it (the pi
// imports, and one constructor with TS parameter properties) to make the single-file
// extension executable. That copy bailed out with "index.ts no longer contains the text this
// harness rewrites" on any reformat, and module-private functions had to be re-exported by an
// appended block. Neither is needed now: the split gave the probes real module boundaries.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PROBES = ["probe_modules.ts", "probe_install.ts", "probe_audit2.ts", "probe_channel.ts", "probe_batch.ts", "probe_config.ts", "probe_driver.ts", "probe_scale.ts", "probe_bug.ts"];

let failed = 0;
for (const p of PROBES) {
  console.log(`\n--- ${p}`);
  try {
    execFileSync(process.execPath, [join(here, p)], { stdio: "inherit", timeout: 180_000 });
  } catch {
    failed++;
  }
}
console.log(failed === 0 ? "\nfr-batch: all guard tests pass" : `\nfr-batch: ${failed} probe file(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
