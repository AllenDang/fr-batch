// The kind:"bug" pipeline's ORCHESTRATION, in the automated suite.
//
// probe_bug.ts covers the pure functions and the git primitives. This file covers `runBugItem`
// itself — capture, the gate, the scope phase, the driver dispatch — because nothing else did:
// before it, `grep -l runBugItem tests/*.ts` matched nothing, so `node tests/run.mjs` could go
// green with the whole pipeline broken.
//
// SELF-CONTAINED ON PURPOSE. The end-to-end harness (tests/e2e_bug_kind.mjs) drives the same code
// against read-only copies of a real project's fixtures, which is why it needs a hand-prepared
// repo and cannot live in PROBES. Here the pin is synthesised: a shell script that writes a JSONL
// sink, driven by a mode file. No engine, no network, no fixture corpus, no preparation.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBatch } from "../driver.ts";
import { ASYNC_COMPLETE, RPC_REPLY_PREFIX, RPC_REQUEST } from "../rpc.ts";

let fails = 0;
const ok = (n: string, c: boolean, extra = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? ` — ${extra}` : ""}`);
  if (!c) fails++;
};

const REPROS = ["repro_a", "repro_b"];
const CONTROLS = ["control_a", "control_b"];

/** A pin: a script that emits one JSONL row per scenario, and an exit code, from a mode file. */
const RUNNER = `#!/usr/bin/env bash
set -u
FIX="\${1:?}"
OUT="$FIX/.results.jsonl"
MODE="\${FR_MODE:-$(cat "$FIX/.mode" 2>/dev/null || echo red)}"
rows() { : > "$OUT"; for r in ${REPROS.join(" ")}; do printf '{"name":"%s","passed":%s}\\n' "$r" "$1" >> "$OUT"; done
         for c in ${CONTROLS.join(" ")}; do printf '{"name":"%s","passed":%s}\\n' "$c" "$2" >> "$OUT"; done; }
case "$MODE" in
  red)              rows false true;  exit 1 ;;
  green)            rows true  true;  exit 0 ;;
  unfixed)          rows false true;  exit 1 ;;
  weakened)         rows true  false; exit 1 ;;
  nosink)           rm -f "$OUT";     exit 1 ;;
  exit-red)         rm -f "$OUT";     exit 1 ;;
  exit-green)       rm -f "$OUT";     exit 0 ;;
  *) echo "unknown FR_MODE '$MODE'" >&2; exit 3 ;;
esac
`;

interface RepoOpts {
  /** Leave the pin untracked-but-gitignored, so the tree is CLEAN and capture's own gate is reached. */
  ignorePin?: boolean;
  results?: string | null;
  run?: string[];
  requirePin?: boolean;
  pinPattern?: string;
  maxFixRounds?: number;
}

function repoWithPin(o: RepoOpts = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "fr-bugorch-"));
  const sh = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  sh("init", "-q");
  sh("config", "user.email", "t@t");
  sh("config", "user.name", "t");
  mkdirSync(join(repo, "pin"), { recursive: true });
  mkdirSync(join(repo, ".pi", "fr-batch"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "runner.sh"), RUNNER, { mode: 0o755 });
  writeFileSync(join(repo, "pin", "REPORT.md"), "# Bug\n\n## Root Cause\n\n`src/thing.c:12` drops the value.\n", "utf8");
  writeFileSync(join(repo, "pin", "spec.yaml"), "assert: value != 0\n", "utf8");
  writeFileSync(join(repo, "pin", ".mode"), "red\n", "utf8");
  writeFileSync(join(repo, "src", "thing.c"), "int f(void){return 0;}\n", "utf8");
  writeFileSync(
    join(repo, ".gitignore"),
    ["/.pi/", "/.pi-subagents/", "pin/.results.jsonl", "pin/.mode", ...(o.ignorePin ? ["/pin/"] : [])].join("\n") + "\n",
    "utf8",
  );
  writeFileSync(
    join(repo, ".pi", "fr-batch", "queue.json"),
    `${JSON.stringify(
      {
        armed: true,
        defaultVerify: ["true"],
        ...(o.maxFixRounds !== undefined ? { maxFixRounds: o.maxFixRounds } : {}),
        bugProtocol: {
          run: o.run ?? ["bash runner.sh {fixture}"],
          results: o.results === undefined ? "{fixture}/.results.jsonl" : o.results,
          ...(o.requirePin ? { requirePin: true, pinPattern: o.pinPattern ?? "^src/test_.*\\.c$" } : {}),
        },
        items: [{ id: "b1", kind: "bug", plan: "pin/REPORT.md" }],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  sh("add", "-A");
  sh("commit", "-qm", "init");
  return repo;
}

/** `fixer` runs when the fake child completes, and is where each case's behaviour lives. */
function harness(repo: string, fixer: (round: number) => void) {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const spawned: string[] = [];
  let n = 0;
  const fire = (name: string, p: unknown) => [...(handlers.get(name) ?? [])].forEach((h) => h(p));
  const pi: any = {
    exec: async (cmd: string, args: string[], opt: any) => {
      try {
        return { code: 0, stdout: execFileSync(cmd, args, { cwd: opt?.cwd ?? repo, encoding: "utf8" }), stderr: "", killed: false };
      } catch (e: any) {
        return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e), killed: false };
      }
    },
    events: {
      on: (name: string, h: (d: unknown) => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(h);
        return () => handlers.get(name)!.delete(h);
      },
      emit: (name: string, payload: any) => {
        if (name !== RPC_REQUEST) return void fire(name, payload);
        // The agent name is only recoverable from the workflowScript string, and only with the key
        // QUOTED — JSON.stringify writes `"agent":"x"`. An unquoted pattern matches nothing here.
        const agent = /"agent":\s*"([^"]+)"/.exec(String(payload.params?.workflowScript ?? ""))?.[1] ?? "?";
        spawned.push(agent);
        const asyncId = `run-${++n}`;
        fire(`${RPC_REPLY_PREFIX}${payload.requestId}`, { version: 1, requestId: payload.requestId, success: true, data: { text: "ok", details: { asyncId } } });
        setTimeout(() => {
          if (agent === "fr-bug-fixer") fixer(spawned.filter((a) => a === "fr-bug-fixer").length);
          fire(ASYNC_COMPLETE, { runId: asyncId, state: "completed", results: [{ status: "complete", summary: "done" }] });
        }, 3);
      },
    },
    appendEntry: () => {},
    sendMessage: () => {},
  };
  return { pi, ctx: { cwd: repo, hasUI: false, ui: {} } as any, spawned };
}

const mode = (repo: string, m: string) => writeFileSync(join(repo, "pin", ".mode"), `${m}\n`, "utf8");
const prog = (repo: string) => JSON.parse(readFileSync(join(repo, ".pi/fr-batch/progress.json"), "utf8"));
const commits = (repo: string) => execFileSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" }).trim().split("\n").length;

/**
 * Drive one run with a HARD DEADLINE.
 *
 * The deadline is the point. The live-lock this pipeline's `skipped` status exists to prevent makes
 * `runBatch` re-select the same item forever — and a test without a timeout does not FAIL on that,
 * it hangs with no output at all, which is indistinguishable from a slow machine in CI.
 */
async function runBounded(h: { pi: unknown; ctx: unknown }, ms = 20_000): Promise<string> {
  return Promise.race([
    runBatch(h.pi as never, h.ctx as never, { kind: "bug", background: true }, () => {}),
    new Promise<string>((_r, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms — the driver never returned (live-lock?)`)), ms).unref?.()),
  ]);
}

// ---------------------------------------------------------------------------
console.log("\n--- the honest fix commits");
{
  const repo = repoWithPin();
  const h = harness(repo, () => {
    writeFileSync(join(repo, "src", "thing.c"), "int f(void){return 1;}\n", "utf8");
    mode(repo, "green");
  });
  const out = await runBounded(h);
  ok("the item committed", prog(repo).b1?.status === "committed", `${prog(repo).b1?.status} · ${out.split("\n")[0]}`);
  ok("...after one fixer, then the scoper", h.spawned.join(",") === "fr-bug-fixer,fr-bug-scoper", h.spawned.join(","));
  ok("...and no FR-lane child ran", !h.spawned.some((a) => a === "fr-implementer" || a === "fr-test-auditor"));
  ok("the baseline recorded scenario mode, HEAD and the pin digest", (() => {
    const b = JSON.parse(readFileSync(join(repo, ".pi/fr-batch/b1.baseline.json"), "utf8"));
    return b.mode === "scenario" && Boolean(b.head) && Object.keys(b.pins).length > 0 && Object.values(b.scenarios).filter((v) => v === false).length === 2;
  })());
  ok("no contract or gap ledger was written", !existsSync(join(repo, ".pi/fr-batch/b1.contract.md")) && !existsSync(join(repo, ".pi/fr-batch/b1.gaps.json")));
  ok("sibling candidates were recorded", existsSync(join(repo, ".pi/fr-batch/b1.siblings.md")));
  ok("the fix is in the commit", execFileSync("git", ["show", "--stat", "HEAD"], { cwd: repo, encoding: "utf8" }).includes("thing.c"));
}

// ---------------------------------------------------------------------------
console.log("\n--- editing the pin is refused, and nothing is committed");
{
  const repo = repoWithPin();
  const base = commits(repo);
  const h = harness(repo, () => {
    writeFileSync(join(repo, "pin", "spec.yaml"), "assert: value == 0\n", "utf8");
    mode(repo, "green");
  });
  const out = await runBounded(h);
  ok("the item is blocked", prog(repo).b1?.status === "blocked", prog(repo).b1?.status ?? "(none)");
  ok("...naming the pin file", out.includes("pin/spec.yaml"), out.split("\n").find((l) => l.includes("spec.yaml")) ?? "");
  ok("...and nothing was committed", commits(repo) === base);
}

// ---------------------------------------------------------------------------
console.log("\n--- greening the reproduction by breaking a control is refused");
{
  const repo = repoWithPin({ maxFixRounds: 1 });
  const h = harness(repo, () => {
    writeFileSync(join(repo, "src", "thing.c"), "int f(void){return 1;}\n", "utf8");
    mode(repo, "weakened");
  });
  const out = await runBounded(h);
  ok("the item is blocked", prog(repo).b1?.status === "blocked", prog(repo).b1?.status ?? "(none)");
  ok("...naming the regressed control", out.includes("control_a"), out.split("\n").find((l) => l.includes("control_")) ?? "");
  ok("...and the round was spent", (prog(repo).b1?.fixRounds ?? 0) >= 1, String(prog(repo).b1?.fixRounds));
}

// ---------------------------------------------------------------------------
console.log("\n--- an unfixed reproduction is bounded by maxFixRounds");
{
  const repo = repoWithPin({ maxFixRounds: 2 });
  const h = harness(repo, () => writeFileSync(join(repo, "src", "thing.c"), "int f(void){return 0;}\n", "utf8"));
  const out = await runBounded(h);
  ok("the item is blocked", prog(repo).b1?.status === "blocked", prog(repo).b1?.status ?? "(none)");
  ok("...after exactly maxFixRounds fixers", h.spawned.filter((a) => a === "fr-bug-fixer").length === 2, h.spawned.join(","));
  ok("...and the scoper never ran on a red gate", !h.spawned.includes("fr-bug-scoper"), h.spawned.join(","));
}

// ---------------------------------------------------------------------------
console.log("\n--- an already-green pin is skipped AND the run terminates");
{
  const repo = repoWithPin();
  mode(repo, "green");
  const h = harness(repo, () => ok("no fixer should run", false));
  let out = "";
  try {
    out = await runBounded(h);
  } catch (e) {
    // The live-lock's signature. Without the deadline this is a hang, not a failure.
    ok("the run terminated rather than re-selecting the skipped item", false, (e as Error).message);
  }
  ok("the item is skipped", prog(repo).b1?.status === "skipped", prog(repo).b1?.status ?? "(none)");
  ok("...with no child spawned", h.spawned.length === 0, h.spawned.join(",") || "(none)");
  ok("...and the run reported finishing", out.includes("finished") && out.includes("1 skipped"), out.split("\n")[0]);
}

// ---------------------------------------------------------------------------
console.log("\n--- an untracked pin is refused BY CAPTURE, on a clean tree");
{
  // Gitignoring the pin is what makes this reachable: the tree is clean, so the pre-lock dirty-tree
  // guard does not fire first, and capture's own `git ls-files` check is the thing under test. The
  // end-to-end harness cannot reach it — there the untracked pin makes the tree dirty.
  const repo = repoWithPin({ ignorePin: true });
  ok("the tree really is clean", execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim() === "");
  const h = harness(repo, () => ok("no fixer should run", false));
  const out = await runBounded(h);
  ok("the item is blocked by capture", prog(repo).b1?.status === "blocked", prog(repo).b1?.status ?? "(none)");
  ok("...saying the pin is not committed", out.includes("not committed"), out.split("\n").find((l) => l.includes("commit")) ?? "");
  ok("...and no child ran", h.spawned.length === 0, h.spawned.join(",") || "(none)");
  ok("...and no baseline was written", !existsSync(join(repo, ".pi/fr-batch/b1.baseline.json")));
}

// ---------------------------------------------------------------------------
console.log("\n--- a fixer that hides its edit, or commits it, is refused");
{
  const repo = repoWithPin();
  const h = harness(repo, () => {
    execFileSync("git", ["update-index", "--assume-unchanged", "pin/spec.yaml"], { cwd: repo });
    writeFileSync(join(repo, "pin", "spec.yaml"), "assert: value == 0\n", "utf8");
    mode(repo, "green");
  });
  const out = await runBounded(h);
  ok("assume-unchanged on the pin is caught", prog(repo).b1?.status === "blocked" && out.includes("stop reporting changes"), out.split("\n")[1] ?? "");
  execFileSync("git", ["update-index", "--no-assume-unchanged", "pin/spec.yaml"], { cwd: repo });
}
{
  const repo = repoWithPin();
  const h = harness(repo, () => {
    writeFileSync(join(repo, "pin", "spec.yaml"), "assert: value == 0\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=x@x", "-c", "user.name=x", "commit", "-qm", "sneaky"], { cwd: repo });
    mode(repo, "green");
  });
  const out = await runBounded(h);
  ok("a commit made by the fixer is caught", prog(repo).b1?.status === "blocked" && out.includes("HEAD moved"), out.split("\n")[1] ?? "");
}

// ---------------------------------------------------------------------------
console.log("\n--- a tampered baseline cannot make the gate vacuous");
{
  // `.pi/fr-batch/` is gitignored in a consuming repo, so no git check can see a write to it, and
  // the fixer holds `write`. Two exposures, and they are different:
  //
  //   MID-ITEM  inert by construction — the baseline is read once at capture and the gate compares
  //             against the in-memory copy, so a write to the file cannot reach this run's verdict.
  //   ON RESUME real — the next run reads the file back, so a tamper survives.
  const repo = repoWithPin();
  const h = harness(repo, () => {
    const bp = join(repo, ".pi/fr-batch/b1.baseline.json");
    const b = JSON.parse(readFileSync(bp, "utf8"));
    for (const k of Object.keys(b.scenarios)) b.scenarios[k] = true;
    writeFileSync(bp, JSON.stringify(b, null, 2), "utf8");
    writeFileSync(join(repo, "src", "thing.c"), "int f(void){return 1;}\n", "utf8");
    mode(repo, "green");
  });
  await runBounded(h);
  ok("a mid-item tamper is inert: the gate used the in-memory baseline", prog(repo).b1?.status === "committed", prog(repo).b1?.status ?? "(none)");
}
{
  // The resume path, reached by pre-seeding the file the way a previous round would have left it.
  // Capture CANNOT produce an all-green baseline — it refuses an already-green pin — so a baseline
  // with no failing row is invalid on its face, and that is cheap to check.
  const repo = repoWithPin();
  mkdirSync(join(repo, ".pi/fr-batch"), { recursive: true });
  writeFileSync(
    join(repo, ".pi/fr-batch/b1.baseline.json"),
    JSON.stringify({ capturedAt: "t", mode: "scenario", fixture: "pin", plan: "pin/REPORT.md", exitCode: 1, head: "", pins: {}, scenarios: { repro_a: true, control_a: true } }, null, 2),
    "utf8",
  );
  const h = harness(repo, () => ok("no fixer should run against an invalid baseline", false));
  const out = await runBounded(h);
  ok("a baseline with no failing scenario is refused on resume", prog(repo).b1?.status === "blocked", prog(repo).b1?.status ?? "(none)");
  ok("...naming the baseline", out.toLowerCase().includes("baseline"), out.split("\n").find((l) => l.toLowerCase().includes("baseline")) ?? "");
  ok("...and no child ran", h.spawned.length === 0, h.spawned.join(",") || "(none)");
}

// ---------------------------------------------------------------------------
console.log("\n--- exit mode: a pin with no per-scenario record");
{
  const repo = repoWithPin({ results: null, run: ["bash runner.sh {fixture}"] });
  mode(repo, "exit-red");
  const h = harness(repo, () => {
    // The source edit matters: without it the tree is clean and the commit fails, which looks like
    // a gate failure but is not one.
    writeFileSync(join(repo, "src", "thing.c"), "int f(void){return 1;}\n", "utf8");
    mode(repo, "exit-green");
  });
  const out = await runBounded(h);
  ok("an exit-mode item commits", prog(repo).b1?.status === "committed", `${prog(repo).b1?.status} · ${out.split("\n")[0]}`);
  const b = JSON.parse(readFileSync(join(repo, ".pi/fr-batch/b1.baseline.json"), "utf8"));
  ok("...with the mode recorded as exit and no scenario map", b.mode === "exit" && Object.keys(b.scenarios).length === 0);
}

// ---------------------------------------------------------------------------
console.log("\n--- requirePin: a fix with no permanent regression test is red");
{
  const repo = repoWithPin({ requirePin: true, maxFixRounds: 1 });
  const h = harness(repo, () => {
    writeFileSync(join(repo, "src", "thing.c"), "int f(void){return 1;}\n", "utf8");
    mode(repo, "green");
  });
  const out = await runBounded(h);
  ok("the item is blocked for the missing pin", prog(repo).b1?.status === "blocked" && out.includes("regression pin"), out.split("\n").find((l) => l.includes("pin")) ?? "");
}
{
  const repo = repoWithPin({ requirePin: true });
  const h = harness(repo, () => {
    writeFileSync(join(repo, "src", "thing.c"), "int f(void){return 1;}\n", "utf8");
    // Untracked until the driver's own `git add -A`, which is why the changed-path set has to
    // include untracked files or this would red every correct fix.
    writeFileSync(join(repo, "src", "test_thing.c"), "/* asserts the fix */\n", "utf8");
    mode(repo, "green");
  });
  const out = await runBounded(h);
  ok("...and an added, still-untracked pin satisfies it", prog(repo).b1?.status === "committed", `${prog(repo).b1?.status} · ${out.split("\n")[0]}`);
}

console.log(fails === 0 ? "\nprobe_bug_orchestration: all pass" : `\nprobe_bug_orchestration: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
