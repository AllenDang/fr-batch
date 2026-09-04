#!/usr/bin/env node
// Mutation check: revert each fix, prove the guard suite catches it, restore.
//
// This is the answer to the report's sharpest line — the whole suite stayed green with all three
// agent definitions deleted, because nothing asserted across a boundary. A guard that cannot go
// red is not a guard, so every fix in this wave is listed here with the exact source mutation
// that undoes it and the probe file that must fail.
//
// Run: node tests/mutation.mjs   (~3 min; not part of run.mjs)
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (f) => readFileSync(join(root, f), "utf8");
const wr = (f, t) => writeFileSync(join(root, f), t);

/** file, a description, and the edit that undoes the fix. `probe` must FAIL after it. */
const MUTATIONS = [
  {
    name: "the changed-path set goes back to a tracked-only git diff",
    probe: "probe_bug.ts",
    file: "bug_pipeline.ts",
    mutate: (t) => t.replace('const r = await pi.exec("git", ["status", "--porcelain", "-z"], { cwd });', 'const r = await pi.exec("git", ["diff", "--name-only", "-z", "HEAD"], { cwd });'),
  },
  {
    name: "the pin digest reads the index instead of the working tree",
    probe: "probe_bug.ts",
    file: "bug_pipeline.ts",
    mutate: (t) => t.replace('const r = await pi.exec("git", ["hash-object", "--", ...files], { cwd });', 'const r = await pi.exec("git", ["rev-parse", ...files.map((f) => `HEAD:${f}`)], { cwd });'),
  },
  {
    name: "digestDrift stops reporting an added file under the pin",
    probe: "probe_bug.ts",
    file: "bug_pipeline.ts",
    mutate: (t) => t.replace('  for (const f of Object.keys(after)) if (!Object.hasOwn(before, f)) drift.push(`${f} (added)`);\n', ""),
  },
  {
    name: "a rename record's bare second path is sliced like a status line",
    probe: "probe_bug.ts",
    file: "bug_pipeline.ts",
    mutate: (t) => t.replace('    if ((xy[0] === "R" || xy[0] === "C") && i + 1 < recs.length) out.push(recs[++i]);\n', ""),
  },
  {
    name: "a results sink may collide with a pin path again",
    probe: "probe_bug.ts",
    file: "store.ts",
    mutate: (t) => t.replace("    const collision = p.pinPaths.map(sub).find((pp) => pp === sink);", "    const collision = undefined;"),
  },
  {
    name: "the run lock goes back to judging liveness by file age",
    probe: "probe_lifecycle.ts",
    file: "store.ts",
    mutate: (t) => t.replace("  if (pid === null) return { text, pid: null, alive: ageMs < STALE_RUNLOCK_MS, ageMs };", "  return { text, pid: null, alive: ageMs < STALE_RUNLOCK_MS, ageMs };"),
  },
  {
    name: "a retired driver reports again after a reload",
    probe: "probe_lifecycle.ts",
    file: "state.ts",
    mutate: (t) => t.replace("  return !d.retired && (generations.get(cwd) ?? 0) === d.generation;", "  return (generations.get(cwd) ?? 0) === d.generation;"),
  },
  {
    name: "status describes the deleted strict-shrink guard again",
    probe: "probe_lifecycle.ts",
    file: "render.ts",
    mutate: (t) => t.replace("budget counts BARREN rounds (nothing closed, nothing rejected)", "gap set must shrink each round"),
  },
  {
    name: "an abandonment forgets which phase to re-enter",
    probe: "probe_lifecycle.ts",
    file: "driver.ts",
    // The two-line form is what makes this unique: handlePause also writes `pausedPhase: phase`, but
    // with pausedChildId between it and pausedRound. Only abandonChild has them adjacent.
    mutate: (t) => t.replace("          pausedPhase: phase,\n          pausedRound: round,\n", "          pausedRound: round,\n"),
  },
  {
    name: "a dispute about the operator's own verify gate reads as an ordinary wish-list item",
    probe: "probe_lifecycle.ts",
    file: "render.ts",
    // Attacks the READER. Its twin below attacks the WRITER — the previous single row only ever edited
    // render.ts, so a change to the heading contract.ts writes would have gone unnoticed, which is the
    // drift the shared constant exists to prevent.
    mutate: (t) => t.replace('  return text.includes(VERIFY_DISPUTE_HEADING) ? "out-of-scope:yes VERIFY-DISPUTED" : "out-of-scope:yes";', '  return "out-of-scope:yes";'),
  },
  {
    name: "the dispute heading is changed on the WRITER side only",
    probe: "probe_lifecycle.ts",
    file: "contract.ts",
    mutate: (t) => t.replace('export const VERIFY_DISPUTE_HEADING = "### The project\'s verify gate disagrees with the PLAN\'s acceptance text";', 'export const VERIFY_DISPUTE_HEADING = "### verify gate notes";'),
  },
  {
    name: "a verdict block inside a phase stops recording that phase",
    probe: "probe_lifecycle.ts",
    file: "driver.ts",
    mutate: (t) => t.replace('`, "verdict", "fix-verify");', "`);"),
  },
  {
    name: "an outcome-failure block names a phase one behind",
    probe: "probe_lifecycle.ts",
    file: "driver.ts",
    mutate: (t) => t.replace('if (auditFailure) return block(auditFailure, "attempt", "audit");', 'if (auditFailure) return block(auditFailure, "attempt", "implement");'),
  },
  {
    name: "a second site starts writing pauseKind stopped",
    probe: "probe_lifecycle.ts",
    file: "driver.ts",
    mutate: (t) => t.replace('          pauseKind: "network",', '          pauseKind: "stopped",'),
  },
  {
    name: "an abandonment stops labelling its note",
    probe: "probe_lifecycle.ts",
    file: "driver.ts",
    mutate: (t) => t.replace("`${label} during ${phase}: ${cause.detail}`", "`during ${phase}: ${cause.detail}`"),
  },
  {
    name: "a timeout is reported to the operator as their own hard stop",
    probe: "probe_lifecycle.ts",
    file: "render.ts",
    mutate: (t) => t.replace('  const timedOut = stopped.filter((i) => (progress[i.id]?.note ?? "").startsWith("TIMED OUT"));', "  const timedOut = [];"),
  },
  {
    name: "status stops naming the cost cap",
    probe: "probe_lifecycle.ts",
    file: "render.ts",
    mutate: (t) => t.replace(" · maxTotalRounds ${q.maxTotalRounds}", ""),
  },
  {
    name: "a recycled pid holds the lock forever",
    probe: "probe_lifecycle.ts",
    file: "store.ts",
    mutate: (t) => t.replace("  if (alive && ageMs >= STALE_RUNLOCK_MS) return { text, pid, alive: false, ageMs };\n", ""),
  },
  {
    name: "an outcome-failure block forgets its phase, so re-entry skips implement",
    probe: "probe_lifecycle.ts",
    file: "driver.ts",
    mutate: (t) => t.replace('if (implFailure) return block(implFailure, "attempt", "implement");', 'if (implFailure) return block(implFailure, "attempt");'),
  },
  {
    name: "the re-entry writes a status the rest of the loop cannot see",
    probe: "probe_lifecycle.ts",
    file: "driver.ts",
    mutate: (t) => t.replace("          progress = loadProgress(cwd);\n", ""),
  },
  {
    name: "a block forgets the phase it stopped in, so re-entry skips implement",
    probe: "probe_lifecycle.ts",
    file: "store.ts",
    mutate: (t) => t.replace('    ...(status === "paused" || status === "blocked"', '    ...(status === "paused"'),
  },
  {
    name: "a blocked item revives a stale child id",
    probe: "probe_lifecycle.ts",
    file: "store.ts",
    mutate: (t) => t.replace('    // The child id is different: it names a PROCESS, and a stale one must never be revived. Only a\n    // paused item has a child worth resuming.\n    ...(status === "paused"\n', '    ...(status === "paused" || status === "blocked"\n'),
  },
  {
    name: "the barren counter stops being persisted",
    probe: "probe_lifecycle.ts",
    file: "store.ts",
    mutate: (t) => t.replace("    ...(patch.barrenRounds !== undefined ? { barrenRounds: patch.barrenRounds } : all[id]?.barrenRounds !== undefined ? { barrenRounds: all[id].barrenRounds } : {}),\n", ""),
  },
  {
    name: "a superseded driver reports again",
    probe: "probe_lifecycle.ts",
    file: "background.ts",
    mutate: (t) => t.replace("  if (!isCurrentGeneration(cwd, d)) {", "  if (false) {"),
  },
  {
    name: "a timeout blocks instead of recording an abandonment",
    probe: "probe_lifecycle.ts",
    file: "resilience.ts",
    mutate: (t) => t.replace('  if (e.message.startsWith("WALLCLOCK:")) return { kind: "timeout", runId: runIdOfWallclock(e.message) };\n', ""),
  },
  {
    name: "an abandoned child stops being reported as abandoned",
    probe: "probe_lifecycle.ts",
    file: "driver.ts",
    mutate: (t) => t.replace('          "The child that was in flight was ABANDONED, not killed: this driver cannot stop a running",', '          "The child stopped.",'),
  },
  {
    name: "every block is sticky again, whatever it invalidated",
    probe: "probe_lifecycle.ts",
    file: "driver.ts",
    mutate: (t) => t.replace('        if (scope === "attempt" || (opts.resumeBlocked && opts.only === item.id)) {', "        if (opts.resumeBlocked && opts.only === item.id) {"),
  },
  {
    name: "a verdict block loses its operator-asserted exit",
    probe: "probe_fr_regression.ts",
    file: "driver.ts",
    mutate: (t) => t.replace('        if (scope === "attempt" || (opts.resumeBlocked && opts.only === item.id)) {', '        if (scope === "attempt") {'),
  },
  {
    name: "the fix budget counts rounds again instead of barren rounds",
    probe: "probe_lifecycle.ts",
    file: "driver.ts",
    mutate: (t) => t.replace("        if (barren >= q.maxFixRounds) {", "        if (round >= q.maxFixRounds) {"),
  },
  {
    name: "a rejection stops counting as progress",
    probe: "probe_lifecycle.ts",
    file: "contract.ts",
    mutate: (t) => t.replace("  return closed > 0 || rejected > 0;", "  return closed > 0;"),
  },
  {
    name: "the total round cap is removed",
    probe: "probe_lifecycle.ts",
    file: "driver.ts",
    mutate: (t) => t.replace("        if (round >= q.maxTotalRounds) {", "        if (false) {"),
  },
  {
    name: "verify findings stop being recorded",
    probe: "probe_lifecycle.ts",
    file: "driver.ts",
    mutate: (t) => t.replace("          recordOutOfScope(cwd, item, round, outOfScope, verdict.notes, verifyFindings);", "          recordOutOfScope(cwd, item, round, outOfScope, verdict.notes);"),
  },
  {
    name: "the undici connect-failure wordings are removed again",
    probe: "probe_fr_regression.ts",
    file: "resilience.ts",
    mutate: (t) => t.replace("  /socket disconnected/i,\n  /before secure TLS connection/i,\n  /pending stream (?:has been )?canceled/i,\n", ""),
  },
  {
    name: "a child that died with no output far inside its budget is a real failure again",
    probe: "probe_fr_regression.ts",
    file: "resilience.ts",
    mutate: (t) => t.replace("  return elapsedMs < budgetMs / 10;", "  return false;"),
  },
  {
    name: "the audit verdict goes back to sharing the narration's filename",
    probe: "probe_fr_regression.ts",
    file: "driver.ts",
    mutate: (t) => t.replace('            writeAtomic(verdictPath, `${JSON.stringify(structured, null, 2)}\\n`);\n', ""),
  },
  {
    name: "an item's note stops reaching the child",
    probe: "probe_fr_regression.ts",
    file: "prompts.ts",
    mutate: (t) => t.replace('  if (!n) return "";', '  return "";'),
  },
  {
    name: "the driver's own record is presented as an operator order again",
    probe: "probe_fr_regression.ts",
    file: "prompts.ts",
    mutate: (t) => t.replace('    "## What happened here before you",', '    "## Standing instruction from the operator for this item",'),
  },
  {
    name: "an all-true baseline is accepted on resume",
    probe: "probe_bug_orchestration.ts",
    file: "bug_pipeline.ts",
    mutate: (t) => t.replace('if (parsed.mode === "scenario" && Object.values(parsed.scenarios ?? {}).every((v) => v === true)) {', "if (false) {"),
  },
  {
    name: "the skipped status is not terminal, so the driver re-selects forever",
    probe: "probe_bug_orchestration.ts",
    file: "types.ts",
    mutate: (t) => t.replace('export const isDone = (s: ItemStatus): boolean => s === "committed" || s === "skipped";', 'export const isDone = (s: ItemStatus): boolean => s === "committed";'),
  },
  {
    name: "the assume-unchanged escape hatch is not checked",
    probe: "probe_bug.ts",
    file: "bug_pipeline.ts",
    mutate: (t) => t.replace('.filter((l) => l.length > 2 && !l.startsWith("H "))', ".filter(() => false)"),
  },
  {
    name: "the baseline comparison only looks at what was failing",
    probe: "probe_bug.ts",
    file: "bug_pipeline.ts",
    mutate: (t) => t.replace("    if (was && !now) c.regressions.push(name);\n", ""),
  },
  {
    name: "the comparison iterates the after-run instead of the baseline",
    probe: "probe_bug.ts",
    file: "bug_pipeline.ts",
    mutate: (t) => t.replace("      c.missing.push(name);\n", ""),
  },
  {
    name: "a well-formed non-scenario row is keyed by its absent name",
    probe: "probe_bug.ts",
    file: "bug_pipeline.ts",
    mutate: (t) =>
      t.replace(
        'if (typeof name !== "string" || !name.trim() || typeof passed !== "boolean") {',
        'if (false) {',
      ),
  },
  {
    name: "a duplicate scenario name is last-write-wins again",
    probe: "probe_bug.ts",
    file: "bug_pipeline.ts",
    mutate: (t) => t.replace("    if (Object.hasOwn(scan.scenarios, name)) {", "    if (false) {"),
  },
  {
    name: "the results sink is not deleted before a run, so a stale one is read as the verdict",
    probe: "probe_bug.ts",
    file: "bug_pipeline.ts",
    mutate: (t) => t.replace("  if (sink) rmSync(join(cwd, sink), { force: true });", ""),
  },
  {
    name: "BUG_PROTOCOL_DEFAULTS hardcodes one project's runner",
    probe: "probe_bug.ts",
    file: "types.ts",
    mutate: (t) => t.replace('  nameField: "name",', '  run: ["./bin/ange test {fixture}"],\n  nameField: "name",'),
  },
  {
    name: "`results: null` falls through and re-inherits the outer sink",
    probe: "probe_bug.ts",
    file: "store.ts",
    mutate: (t) => t.replace("    results: merged.results,", "    results: merged.results ?? (q.bugProtocol?.results as string | null) ?? null,"),
  },
  {
    name: "agent definitions are not shipped",
    probe: "probe_install.ts",
    apply: () => renameSync(join(root, "agents"), join(root, "agents.off")),
    undo: () => renameSync(join(root, "agents.off"), join(root, "agents")),
  },
  {
    name: "package.json stops declaring agents/",
    probe: "probe_install.ts",
    file: "package.json",
    mutate: (t) => JSON.stringify({ ...JSON.parse(t), "pi-subagents": undefined }, null, 2),
  },
  {
    name: "queue budgets are neither defaulted nor validated",
    probe: "probe_install.ts",
    file: "store.ts",
    mutate: (t) => t.replace(/  q\.maxFixRounds = budget[\s\S]*?q\.verifyTimeoutMs = budget\("verifyTimeoutMs", q\.verifyTimeoutMs\);\n/, ""),
  },
  {
    name: "runChild drops a completion event that arrives before the launch reply",
    probe: "probe_install.ts",
    file: "rpc.ts",
    mutate: (t) => t.replace("    if (!asyncId) {\n      early.push(raw);\n      return;\n    }", "    if (!asyncId) return;"),
  },
  {
    name: "a block message prints only summary, not the child's error",
    probe: "probe_install.ts",
    file: "driver.ts",
    mutate: (t) => t.replace(/\n    \.\.\.\(o\.error\?\.trim\(\) \? \[`error: \$\{o\.error\.trim\(\)\.slice\(0, 900\)\}`\] : \[\]\),/, ""),
  },
  {
    name: "the stream-ended transport signature is removed",
    probe: "probe_install.ts",
    file: "resilience.ts",
    mutate: (t) => t.replace("  /stream ended without a stop reason/i,\n", "").replace("  /stream (?:ended|terminated) (?:unexpectedly|prematurely|without)/i,\n", ""),
  },
  {
    name: "the supervisor channel root goes back to <tmpdir>/pi-subagents",
    probe: "probe_install.ts",
    file: "resilience.ts",
    mutate: (t) =>
      t.replace(
        /    \.\.\.\(configured \? \[join\(resolve\(configured\), "supervisor-channels"\)\] : \[\]\),\n    join\(tmpdir\(\), `pi-subagents-\$\{tempScopeId\(\)\}`, "supervisor-channels"\),/,
        '    join(tmpdir(), "pi-subagents", "supervisor-channels"),',
      ),
  },
  {
    name: "the test-matrix gate counts table separators as rows",
    probe: "probe_install.ts",
    file: "contract.ts",
    mutate: (t) => t.replace(/\n    \.filter\(\(l\) => !\/\^\\s\*\\\|\?\[\\s:\|-\]\*\\\|\[\\s:\|-\]\*\$\/\.test\(l\)\)/, ""),
  },
  {
    name: "the gitignore preflight is gone",
    probe: "probe_install.ts",
    file: "driver.ts",
    mutate: (t) => t.replace("    if (unignored.length > 0) {", "    if (false && unignored.length > 0) {"),
  },
  {
    name: "check-ignore is queried without a trailing slash",
    probe: "probe_install.ts",
    file: "driver.ts",
    mutate: (t) => t.replace('["check-ignore", "-q", `${p}/`]', '["check-ignore", "-q", p]'),
  },
  {
    name: "the scope gate matches a gap id as a bare substring",
    probe: "probe_audit2.ts",
    file: "contract.ts",
    mutate: (t) => t.replace("      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;", "      return true;"),
  },
  {
    name: "an unparseable verdict re-runs the whole verify gate",
    probe: "probe_audit2.ts",
    file: "driver.ts",
    // Drop the inner audit loop's own retry: fall back to continuing the OUTER loop, which starts
    // with runVerify — the behaviour this fix removed.
    mutate: (t) =>
      t.replace(
        "          auditAttempt++;\n          log(`  audit verdict unparseable (transport) — re-running the auditor only, ${auditAttempt}/${AUDIT_PARSE_RETRIES}`);\n        }",
        "          auditAttempt++;\n          break;\n        }\n        if ((verdict.gaps[0]?.id ?? \"\").trim() === UNPARSEABLE_GAP_ID) continue;",
      ),
  },
  {
    name: "reset no longer refuses while a driver is live",
    probe: "probe_audit2.ts",
    file: "queue_ops.ts",
    mutate: (t) => t.replace("  const live = drivers.get(cwd);\n  if (live) {", "  const live = undefined;\n  if (live) {"),
  },
  {
    name: "a status-less progress patch wipes the pause fields again",
    probe: "probe_audit2.ts",
    file: "store.ts",
    // Both retention gates, because they are one rule split by which field is safe to keep.
    mutate: (t) => t.replaceAll('...(status === "paused"', '...(patch.status === "paused"'),
  },
  {
    name: "an expired supervisor request is reported as pending",
    probe: "probe_audit2.ts",
    file: "resilience.ts",
    mutate: (t) => t.replace("          if (typeof req.expiresAt === \"number\" && req.expiresAt > 0 && req.expiresAt < Date.now()) continue;", ""),
  },
  {
    name: "prune mistakes a fixer report for the audit verdict",
    probe: "probe_audit2.ts",
    file: "store.ts",
    mutate: (t) =>
      t.replace(
        /  const roundOf = \(f: string\): number => \{[\s\S]*?\n  \};/,
        "  const roundOf = (f: string): number => Number(f.match(/-audit-(\\d+)\\.json$/)?.[1] ?? -1);",
      ),
  },
  {
    name: "tsconfig reintroduces baseUrl (removed in TS7)",
    probe: "probe_install.ts",
    file: "tsconfig.json",
    mutate: (t) => t.replace('    "typeRoots"', '    "baseUrl": ".",\n    "typeRoots"'),
  },
  {
    name: "tsconfig paths go back to non-relative (TS5090 on a current tsc)",
    probe: "probe_install.ts",
    file: "tsconfig.json",
    mutate: (t) => t.replaceAll('["./.types/', '[".types/'),
  },
];

let bad = 0;
for (const m of MUTATIONS) {
  const backup = m.file ? rd(m.file) : null;
  if (m.file) {
    const mutated = m.mutate(backup);
    if (mutated === backup) {
      console.log(`SKIP  ${m.name} — the mutation matched nothing (source drifted; update this file)`);
      bad++;
      continue;
    }
    wr(m.file, mutated);
  } else {
    m.apply();
  }
  let red = false;
  let head = "";
  try {
    execFileSync(process.execPath, [join(root, "tests", m.probe)], { encoding: "utf8", timeout: 240_000 });
  } catch (e) {
    red = true;
    head = String(e.stdout ?? "").split("\n").find((l) => l.startsWith("FAIL")) ?? "(no FAIL line)";
  }
  if (m.file) wr(m.file, backup);
  else m.undo();
  console.log(`${red ? "RED  ✓" : "GREEN ✗"}  ${m.name}${red ? ` — ${head}` : `  (${m.probe} did NOT catch it)`}`);
  if (!red) bad++;
}

// Everything restored: the suite must be green again, or a mutation leaked.
let restored = true;
try {
  execFileSync(process.execPath, [join(root, "tests", "run.mjs")], { encoding: "utf8", timeout: 600_000 });
} catch {
  restored = false;
}
console.log(restored ? "\nrestored: full suite green" : "\nRESTORE FAILED — a mutation leaked, check `git diff`");
console.log(bad === 0 && restored ? "mutation check: every fix is covered by a guard that goes red" : `mutation check: ${bad} uncovered fix(es)`);
process.exit(bad === 0 && restored ? 0 : 1);
