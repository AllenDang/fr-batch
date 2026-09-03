// Guard tests for the kind:"bug" pipeline. Run: node tests/probe_bug.ts
//
// Everything here is headless: `pi.exec` is faked, and where git's own behaviour is the thing under
// test a throwaway repo is created and driven with execFileSync. No engine, no network, no subagent.
//
// The rows that matter most are in "the gate" below. This pipeline exists because a bug fixer holds
// edit/write over a tree that contains the very pin it is judged by, and every one of those rows is
// a specific way that fact could have produced a false green.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildRunCommand,
  changedPaths,
  citedFiles,
  compareToBaseline,
  fixtureOf,
  parseResults,
  runFixture,
  shellQuote,
  suppressedPins,
  substituteTokens,
  underPath,
} from "../bug_pipeline.ts";
import { bugProtocolFor, loadQueue } from "../store.ts";
import { BUG_PROTOCOL_DEFAULTS } from "../types.ts";
import type { Baseline, BugProtocol, Queue, QueueItem } from "../types.ts";

let fails = 0;
const ok = (n: string, c: boolean, extra = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? ` — ${extra}` : ""}`);
  if (!c) fails++;
};
const threw = (n: string, fn: () => unknown, needle: string) => {
  try {
    fn();
    ok(n, false, "did not throw");
  } catch (e) {
    const m = (e as Error).message;
    ok(n, m.includes(needle), m.slice(0, 160));
  }
};

const proto = (over: Partial<BugProtocol> = {}): BugProtocol => ({
  ...BUG_PROTOCOL_DEFAULTS,
  run: ["run {fixture}"],
  results: "{fixture}/.r.jsonl",
  ...over,
});

// ---------------------------------------------------------------------------
// A. queue validation
// ---------------------------------------------------------------------------
const qdir = (q: unknown): string => {
  const d = mkdtempSync(join(tmpdir(), "fr-bug-q-"));
  mkdirSync(join(d, ".pi", "fr-batch"), { recursive: true });
  writeFileSync(join(d, ".pi", "fr-batch", "queue.json"), JSON.stringify(q), "utf8");
  return d;
};
const baseQ = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  armed: false,
  defaultVerify: ["true"],
  ...extra,
  items,
});
const BUGP = { run: ["run {fixture}"], results: "{fixture}/.r.jsonl" };

threw(
  "an unknown kind is refused at load, naming the legal set",
  () => loadQueue(qdir(baseQ([{ id: "x", plan: "p.md", kind: "banana" }]))),
  "only fr, bug are pipelines",
);
ok(
  "an item with no kind loads as fr and needs no bugProtocol",
  loadQueue(qdir(baseQ([{ id: "x", plan: "p.md" }]))).items[0].kind === undefined,
);
threw(
  "a bug item with no protocol at any level is refused, naming bugProtocol",
  () => loadQueue(qdir(baseQ([{ id: "x", plan: "p.md", kind: "bug" }]))),
  "bugProtocol",
);
threw(
  "an empty run array is refused",
  () => loadQueue(qdir(baseQ([{ id: "x", plan: "p.md", kind: "bug" }], { bugProtocol: { run: [] } }))),
  "run must be a non-empty array",
);
threw(
  "fr on a bug item is refused (frFor short-circuits on it)",
  () => loadQueue(qdir(baseQ([{ id: "x", plan: "p.md", kind: "bug", fr: "y.md" }], { bugProtocol: BUGP }))),
  "must not set fr",
);
threw(
  "fixture on a non-bug item is refused",
  () => loadQueue(qdir(baseQ([{ id: "x", plan: "p.md", fixture: "f" }]))),
  "sets fixture but is not",
);
threw(
  "overlapping exit-code sets are refused, naming both",
  () => loadQueue(qdir(baseQ([{ id: "x", plan: "p.md", kind: "bug" }], { bugProtocol: { ...BUGP, redExit: [1], invalidExit: [1] } }))),
  "must be disjoint",
);
threw(
  "requirePin with an uncompilable pinPattern is refused AT LOAD",
  () => loadQueue(qdir(baseQ([{ id: "x", plan: "p.md", kind: "bug" }], { bugProtocol: { ...BUGP, requirePin: true, pinPattern: "(" } }))),
  "not a valid regular expression",
);
threw(
  "requirePin with an empty pinPattern is refused (nothing could satisfy it)",
  () => loadQueue(qdir(baseQ([{ id: "x", plan: "p.md", kind: "bug" }], { bugProtocol: { ...BUGP, requirePin: true } }))),
  "pinPattern is empty",
);
threw(
  "an empty pinPaths is refused (it would disable the immutability gate)",
  () => loadQueue(qdir(baseQ([{ id: "x", plan: "p.md", kind: "bug" }], { bugProtocol: { ...BUGP, pinPaths: [] } }))),
  "pinPaths must be a non-empty array",
);

threw(
  "a results sink that collides with a pin path is refused (it would unprotect that pin)",
  () =>
    loadQueue(
      qdir(
        baseQ([{ id: "x", plan: "fx/BUG_REPORT.md", kind: "bug", fixture: "fx" }], {
          bugProtocol: { run: ["r {fixture}"], results: "{fixture}/test.yaml", pinPaths: ["{fixture}/test.yaml"] },
        }),
      ),
    ),
  "also a pinPaths entry",
);
ok(
  "...but a sink merely INSIDE the fixture dir is fine (that is the normal shape)",
  bugProtocolFor(
    loadQueue(qdir(baseQ([{ id: "x", plan: "fx/BUG_REPORT.md", kind: "bug", fixture: "fx" }], { bugProtocol: { run: ["r"], results: "{fixture}/.r.jsonl" } }))),
    { id: "x", plan: "fx/BUG_REPORT.md", kind: "bug", fixture: "fx" } as QueueItem,
  ).results === "{fixture}/.r.jsonl",
);

// per-item override, and the null sentinel
{
  const q = loadQueue(
    qdir(
      baseQ(
        [
          { id: "a", plan: "fx/BUG_REPORT.md", kind: "bug" },
          { id: "b", plan: "fx2/BUG_REPORT.md", kind: "bug", bugProtocol: { run: ["other {fixture}"], results: null } },
        ],
        { bugProtocol: { ...BUGP, requirePin: false } },
      ),
    ),
  );
  const a = bugProtocolFor(q, q.items[0]);
  const b = bugProtocolFor(q, q.items[1]);
  ok("a bug item inherits the queue's protocol field by field", a.run[0] === "run {fixture}" && a.results === "{fixture}/.r.jsonl");
  ok("...and a per-item override replaces only the fields it names", b.run[0] === "other {fixture}");
  // THE ROW THIS SENTINEL EXISTS FOR. A field-by-field merge has no spelling for "absent", so
  // without `null` an exit-code-only fixture in a queue whose other fixtures have a results sink
  // would inherit that path, never write it, and hard-block forever.
  ok("...and `results: null` UNSETS the queue's sink, putting the item in exit mode", b.results === null);
  ok("fixture defaults to the report's own directory", fixtureOf(q.items[0]) === "fx");
  ok(
    "...and an explicit fixture wins (a report under docs/ beside a pin under tests/)",
    fixtureOf({ id: "c", plan: "docs/FIX_x.md", fixture: "tests/fixtures/x_bug" } as QueueItem) === "tests/fixtures/x_bug",
  );
}
ok(
  "BUG_PROTOCOL_DEFAULTS names no runner and no sink (a default would hardcode one project)",
  !("run" in BUG_PROTOCOL_DEFAULTS) && !("results" in BUG_PROTOCOL_DEFAULTS),
  Object.keys(BUG_PROTOCOL_DEFAULTS).join(","),
);

// ---------------------------------------------------------------------------
// B. substitution and result parsing
// ---------------------------------------------------------------------------
ok(
  "every {fixture} occurrence is substituted, not just the first",
  substituteTokens("a {fixture} b {fixture}", "F", "P") === "a F b F",
  substituteTokens("a {fixture} b {fixture}", "F", "P"),
);
ok("{plan} is substituted too", substituteTokens("{plan}", "F", "P") === "P");
ok(
  "substitution is ONE pass — a fixture path containing the token is not re-expanded",
  substituteTokens("x {fixture}", "{fixture}", "P") === "x {fixture}",
  substituteTokens("x {fixture}", "{fixture}", "P"),
);
ok("a path with a space is shell-quoted", shellQuote("a b") === "'a b'", shellQuote("a b"));
ok("...and an embedded single quote cannot break out", shellQuote("a'b").startsWith("'a") && shellQuote("a'b").includes("\\'"), shellQuote("a'b"));
{
  // Not "one argument reaches the runner" measured through a fake exec — a fake sees one opaque
  // string and cannot count arguments. A real shell can.
  const cmd = buildRunCommand("printf '%s' $#", "tests/fix a", "p.md");
  const argc = execFileSync("bash", ["-lc", `set -- ${shellQuote("tests/fix a")}; printf '%s' $#`], { encoding: "utf8" });
  ok("a quoted fixture path arrives as ONE shell word", argc === "1", `$#=${argc} · ${cmd}`);
}

{
  const p = proto();
  const rows = (s: string) => parseResults(s, p);
  const good = rows('{"name":"a","passed":true}\n{"name":"b","passed":false}\n');
  ok("two scenario rows parse", !("error" in good) && Object.keys(good.scenarios).length === 2);
  const torn = rows('{"name":"a","passed":true}\n{"name":"b",\n{"name":"c","passed":false}\n');
  ok("a torn line is skipped and counted, not fatal", !("error" in torn) && Object.keys(torn.scenarios).length === 2 && torn.torn === 1);
  // A runner that dies mid-suite appends a WELL-FORMED row that is not a scenario. Keyed by an
  // absent name it would become "new coverage" and turn a segfault into a green gate.
  const crash = rows('{"name":"a","passed":true}\n{"suite_crash":true,"kind":"segv","last_scenario":"b"}\n');
  ok(
    "a well-formed NON-scenario row contributes no scenario and is counted",
    !("error" in crash) && Object.keys(crash.scenarios).length === 1 && crash.skipped === 1,
  );
  for (const bad of ['"false"', "1", "null"]) {
    const r = rows(`{"name":"a","passed":${bad}}\n`);
    ok(`a non-boolean pass field (${bad}) is skipped, never coerced`, !("error" in r) && Object.keys(r.scenarios).length === 0 && r.skipped === 1);
  }
  const empty = rows('{"name":"","passed":false}\n');
  ok("an empty scenario name is skipped", !("error" in empty) && Object.keys(empty.scenarios).length === 0);
  const dup = rows('{"name":"a","passed":false}\n{"name":"a","passed":true}\n');
  ok("a duplicate scenario name is a hard error, never last-write-wins", "error" in dup && dup.error.includes("twice"), JSON.stringify(dup).slice(0, 90));
}

// ---------------------------------------------------------------------------
// runFixture, against a fake exec
// ---------------------------------------------------------------------------
interface FakeRun {
  code?: number;
  killed?: boolean;
  writes?: string | null;
}
const fakePi = (cwd: string, plan: FakeRun[]) => {
  let n = 0;
  const calls: string[] = [];
  return {
    calls,
    pi: {
      exec: async (_c: string, args: string[]) => {
        const step = plan[Math.min(n, plan.length - 1)];
        n++;
        calls.push(args[args.length - 1]);
        if (step.writes !== undefined && step.writes !== null) {
          const p = join(cwd, ".r.jsonl");
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, step.writes, "utf8");
        }
        return { stdout: "", stderr: "", code: step.code ?? 0, killed: step.killed ?? false };
      },
    } as never,
  };
};

{
  const cwd = mkdtempSync(join(tmpdir(), "fr-bug-run-"));
  const p = proto({ results: ".r.jsonl" });

  // The sink is deleted before the run, so a STALE file plus a runner that stops writing cannot
  // read as a clean pass.
  writeFileSync(join(cwd, ".r.jsonl"), '{"name":"stale","passed":true}\n', "utf8");
  const { pi } = fakePi(cwd, [{ code: 0 }]);
  const stale = await runFixture(pi, cwd, p, ".", "p.md", 1000, () => {});
  ok(
    "a stale sink cannot survive a run that writes none",
    stale.ok === false && stale.why.includes("wrote none"),
    stale.ok ? "reported ok" : stale.why.split("\n")[0],
  );

  const { pi: pi2 } = fakePi(cwd, [{ code: 1, writes: '{"name":"a","passed":false}\n' }]);
  const red = await runFixture(pi2, cwd, p, ".", "p.md", 1000, () => {});
  ok("a red run parses its sink", red.ok === true && red.exitCode === 1 && red.scan?.scenarios.a === false);

  // FIRST non-zero wins: keeping the last command's code lets a red build followed by `true` read
  // as exit 0, which disables the exit-code half of every gate.
  const { pi: pi3 } = fakePi(cwd, [{ code: 3, writes: '{"name":"a","passed":false}\n' }, { code: 0 }]);
  const multi = await runFixture(pi3, cwd, proto({ results: ".r.jsonl", run: ["a", "b"] }), ".", "p.md", 1000, () => {});
  ok("a multi-command run reports the FIRST non-zero exit", multi.ok === true && multi.exitCode === 3, JSON.stringify(multi).slice(0, 80));

  const { pi: pi4 } = fakePi(cwd, [{ code: 143, killed: true }]);
  const killed = await runFixture(pi4, cwd, p, ".", "p.md", 1000, () => {});
  ok(
    "a killed runner blocks, naming verifyTimeoutMs, instead of judging a partial sink",
    killed.ok === false && killed.why.includes("verifyTimeoutMs"),
    killed.ok ? "reported ok" : killed.why.slice(0, 80),
  );

  const { pi: pi5 } = fakePi(cwd, [{ code: 1, writes: "\n" }]);
  const zero = await runFixture(pi5, cwd, p, ".", "p.md", 1000, () => {});
  ok("a sink with zero usable rows is the same hard failure as an absent one", zero.ok === false && zero.why.includes("no usable scenario"));

  const { pi: pi6 } = fakePi(cwd, [{ code: 1 }]);
  const exitMode = await runFixture(pi6, cwd, proto({ results: null }), ".", "p.md", 1000, () => {});
  ok("exit mode needs no sink at all", exitMode.ok === true && exitMode.scan === null && exitMode.exitCode === 1);
}

// ---------------------------------------------------------------------------
// D. the comparison — this is the anti-cheat
// ---------------------------------------------------------------------------
const bl = (scenarios: Record<string, boolean>): Baseline => ({
  capturedAt: "t",
  mode: "scenario",
  fixture: "fx",
  plan: "fx/BUG_REPORT.md",
  exitCode: 1,
  scenarios,
});
{
  const base = bl({ repro: false, control: true });
  const fixed = compareToBaseline(base, { repro: true, control: true });
  ok("false->true and true->true is a clean pass", fixed.unfixed.length + fixed.regressions.length + fixed.missing.length === 0);

  const unfixed = compareToBaseline(base, { repro: false, control: true });
  ok("false->false is reported as unfixed", unfixed.unfixed.join() === "repro");

  // THE CHEAT THE PIN'S AUTHOR WARNED ABOUT: greening the reproduction by breaking a control that
  // exists precisely to catch a fix that satisfies it for the wrong reason.
  const weakened = compareToBaseline(base, { repro: true, control: false });
  ok("true->false is reported as a REGRESSION (a weakened control)", weakened.regressions.join() === "control");

  // Keyed on the BASELINE. Iterating the after-set instead makes deleting a scenario invisible.
  const deleted = compareToBaseline(base, { repro: true });
  ok("a baseline scenario absent from the after-run is reported as missing", deleted.missing.join() === "control");

  const added = compareToBaseline(base, { repro: true, control: true, extra: false });
  ok("a NEW scenario is reported separately and is not a failure", added.added.join() === "extra" && added.regressions.length === 0);
}

// ---------------------------------------------------------------------------
// the changed-path set, against a real git repo
// ---------------------------------------------------------------------------
{
  const repo = mkdtempSync(join(tmpdir(), "fr-bug-git-"));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  sh("init", "-q");
  sh("config", "user.email", "t@t");
  sh("config", "user.name", "t");
  mkdirSync(join(repo, "fx"), { recursive: true });
  writeFileSync(join(repo, "fx", "test.yaml"), "assert: x != 0\n", "utf8");
  writeFileSync(join(repo, "fx", "BUG_REPORT.md"), "see src/a.cpp:12 and src/b.h:3\n", "utf8");
  writeFileSync(join(repo, ".gitignore"), "fx/.r.jsonl\n", "utf8");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.cpp"), "int main(){}\n", "utf8");
  sh("add", "-A");
  sh("commit", "-qm", "init");

  const realPi = { exec: async (c: string, args: string[]) => ({ stdout: execFileSync(c, args, { cwd: repo, encoding: "utf8" }), stderr: "", code: 0, killed: false }) } as never;

  writeFileSync(join(repo, "fx", ".r.jsonl"), '{"name":"a","passed":false}\n', "utf8"); // gitignored
  ok("a gitignored sink is not a changed path", !(await changedPaths(realPi, repo)).some((p) => p.includes(".r.jsonl")), (await changedPaths(realPi, repo)).join(","));

  writeFileSync(join(repo, "fx", "test.yaml"), "assert: x == 0\n", "utf8"); // the laundering edit
  writeFileSync(join(repo, "fx", "extra.yaml"), "second pin\n", "utf8"); // an untracked ADD
  writeFileSync(join(repo, "tests_test_new.cpp"), "CHECK(true);\n", "utf8"); // an untracked new pin
  const changed = await changedPaths(realPi, repo);
  ok("a tracked edit inside the fixture is seen", changed.includes("fx/test.yaml"), changed.join(","));
  // `git diff --name-only HEAD` reports ONLY the tracked edit. Both of the next two rows are the
  // reason this uses `git status --porcelain` instead.
  ok("an UNTRACKED add inside the fixture is seen (laundering via a second pin)", changed.includes("fx/extra.yaml"), changed.join(","));
  ok("an UNTRACKED new in-suite pin is seen (or requirePin reds every correct fix)", changed.includes("tests_test_new.cpp"), changed.join(","));

  ok("underPath sees a file inside the fixture", underPath(repo, "fx/test.yaml", "fx"));
  ok("...and the fixture dir itself", underPath(repo, "fx", "fx"));
  ok("...and rejects a sibling that merely shares a prefix", !underPath(repo, "fxx/test.yaml", "fx"));
  ok("...and rejects a path outside it", !underPath(repo, "src/a.cpp", "fx"));

  // A tracked pin whose changes git has been told to stop reporting is as unprotected as an
  // untracked one: `--porcelain` AND `diff HEAD` both go silent, and `git add -A` does not stage
  // the edit either — so the item would commit green with the defect intact and no record.
  ok("a normal tracked pin is not reported as suppressed", (await suppressedPins(realPi, repo, ["fx"])).length === 0);
  execFileSync("git", ["update-index", "--assume-unchanged", "fx/test.yaml"], { cwd: repo });
  const supp = await suppressedPins(realPi, repo, ["fx"]);
  ok("assume-unchanged on the pin IS detected", supp.length === 1 && supp[0].includes("fx/test.yaml"), supp.join(","));
  ok("...and neither ordinary probe can see the edit it hides", !(await changedPaths(realPi, repo)).includes("fx/test.yaml"));
  execFileSync("git", ["update-index", "--no-assume-unchanged", "fx/test.yaml"], { cwd: repo });

  const cited = citedFiles(readFileSync(join(repo, "fx", "BUG_REPORT.md"), "utf8"));
  ok("file:line citations are extracted from the report", cited.sort().join(",") === "src/a.cpp,src/b.h", cited.join(","));
  ok("a report with no citations yields none", citedFiles("no citations here at all").length === 0);
}

console.log(fails === 0 ? "\nprobe_bug: all pass" : `\nprobe_bug: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
