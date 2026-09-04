// End-to-end validation of fr-batch's kind:"bug" pipeline.
//
// Real git repo, real fixture copies from ANGE, a real shell running a real stub runner, and the
// REAL runBatch. The only fake is the subagent RPC bus — and its completion hook actually edits the
// tree, so each case can play a different kind of fixer: an honest one, one that launders the pin,
// one that weakens a control.
//
// LIVES OUTSIDE THE REPO IT DRIVES. An earlier draft sat inside it and case 7's `git clean -fd`
// deleted the harness mid-run — the fixture repo is reset hard between cases, so nothing untracked
// may live in it.
//
// Nothing here touches ANGE, ANGE_w1 or ANGE_w2. Two of them had live fr-batch drivers when this was
// written; the fixtures were copied read-only.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBatch } from "../driver.ts";
import { ASYNC_COMPLETE, RPC_REPLY_PREFIX, RPC_REQUEST } from "../rpc.ts";

// NOT part of tests/run.mjs: it needs a prepared fixture repo. Run by hand after touching
// bug_pipeline.ts or the driver dispatch.
const REPO = process.env.FR_E2E_REPO ?? "/tmp/fr-batch-e2e";
// Both fixture paths come from the environment: this harness runs against a repo prepared by hand
// from a consuming project's own fixtures, and that project's directory names are not this repo's
// business. tests/probe_bug_orchestration.ts is the self-contained equivalent that needs none of it.
const FX = process.env.FR_E2E_FIXTURE ?? "tests/fixtures/scenario_pin_bug";
const EXITFX = process.env.FR_E2E_EXIT_FIXTURE ?? "tests/fixtures/exit_pin_bug";

let fails = 0;
const ok = (n, c, extra = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? ` — ${extra}` : ""}`);
  if (!c) fails++;
};
const sh = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8" });

// A FIXED baseline, not HEAD: earlier cases commit, so resetting to HEAD would carry their commits
// into the next case and make any "nothing was committed" assertion meaningless.
const BASE = sh("rev-parse", "HEAD").trim();
const baseCount = sh("log", "--oneline", BASE).trim().split("\n").length;

const reset = () => {
  sh("reset", "-q", "--hard", BASE);
  sh("clean", "-qfd");
  const st = join(REPO, ".pi/fr-batch");
  for (const f of ["progress.json", ".run.lock"]) rmSync(join(st, f), { force: true });
  for (const f of execFileSync("bash", ["-lc", `ls ${st} 2>/dev/null || true`], { encoding: "utf8" }).split("\n")) {
    if (f.endsWith(".baseline.json") || f.endsWith(".siblings.md")) rmSync(join(st, f), { force: true });
  }
};

/** `fixer` runs when the fake child "completes", and is where each case's behaviour lives. */
function harness({ fixer, mode }) {
  const handlers = new Map();
  const spawned = [];
  let n = 0;
  const fire = (name, p) => [...(handlers.get(name) ?? [])].forEach((h) => h(p));
  const pi = {
    exec: async (cmd, args, o) => {
      try {
        return {
          code: 0,
          stdout: execFileSync(cmd, args, { cwd: o?.cwd ?? REPO, encoding: "utf8", env: { ...process.env, FR_E2E_MODE: mode() } }),
          stderr: "",
          killed: false,
        };
      } catch (e) {
        return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e), killed: false };
      }
    },
    events: {
      on: (name, h) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name).add(h);
        return () => handlers.get(name).delete(h);
      },
      emit: (name, payload) => {
        if (name !== RPC_REQUEST) return void fire(name, payload);
        const req = payload;
        // The agent name is recoverable ONLY through the workflowScript string, and only with the
        // key quoted — JSON.stringify writes `"agent":"x"`. An unquoted /agent:\s*"…"/ matches
        // nothing here, which would make every "which children ran" assertion vacuously green.
        const agent = /"agent":\s*"([^"]+)"/.exec(String(req.params?.workflowScript ?? ""))?.[1] ?? "?";
        spawned.push(agent);
        const asyncId = `run-${++n}`;
        fire(`${RPC_REPLY_PREFIX}${req.requestId}`, {
          version: 1,
          requestId: req.requestId,
          success: true,
          data: { text: "launched", details: { asyncId } },
        });
        setTimeout(() => {
          if (agent === "fr-bug-fixer") fixer(spawned.filter((a) => a === "fr-bug-fixer").length);
          fire(ASYNC_COMPLETE, { runId: asyncId, state: "completed", results: [{ status: "complete", summary: "done" }] });
        }, 5);
      },
    },
    appendEntry: () => {},
    sendMessage: () => {},
  };
  return { pi, ctx: { cwd: REPO, hasUI: false, ui: {} }, spawned };
}

const run = async (h, opts = {}) => runBatch(h.pi, h.ctx, { kind: "bug", background: true, ...opts }, () => {});
const progress = () => JSON.parse(readFileSync(join(REPO, ".pi/fr-batch/progress.json"), "utf8"));
const QPATH = join(REPO, ".pi/fr-batch/queue.json");
const withQueue = (mutate, fn) => {
  const saved = readFileSync(QPATH, "utf8");
  const q = JSON.parse(saved);
  mutate(q);
  writeFileSync(QPATH, `${JSON.stringify(q, null, 2)}\n`, "utf8");
  return fn().finally(() => writeFileSync(QPATH, saved, "utf8"));
};

// Arm the queue. `armed:false` is the shipped default and `run` refuses on it — proving that is
// probe_driver's job, not this file's.
{
  const q = JSON.parse(readFileSync(QPATH, "utf8"));
  q.armed = true;
  q.items = q.items.filter((i) => i.id === "x2-move-axis");
  writeFileSync(QPATH, `${JSON.stringify(q, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
console.log("\n--- 1. the honest fix commits");
reset();
{
  let phase = "red";
  const h = harness({
    mode: () => phase,
    fixer: () => {
      writeFileSync(join(REPO, "src/act_move.cpp"), "int main(){/*masked write*/return 0;}\n", "utf8");
      phase = "fixed";
    },
  });
  const out = await run(h);
  const p = progress()["x2-move-axis"];
  ok("the item committed", p?.status === "committed", `${p?.status} · ${out.split("\n")[0]}`);
  ok("...with a sha", Boolean(p?.sha), p?.sha ?? "(none)");
  ok("...after exactly one fixer", h.spawned.filter((a) => a === "fr-bug-fixer").length === 1, h.spawned.join(","));
  ok("...and the scoper ran after the gate was green", h.spawned.includes("fr-bug-scoper"), h.spawned.join(","));
  ok("the baseline was captured in scenario mode", JSON.parse(readFileSync(join(REPO, ".pi/fr-batch/x2-move-axis.baseline.json"), "utf8")).mode === "scenario");
  ok("sibling candidates were recorded", existsSync(join(REPO, ".pi/fr-batch/x2-move-axis.siblings.md")));
  ok("the fix is in the commit", sh("show", "--stat", "--oneline", "HEAD").includes("act_move.cpp"));
  ok("no fr-* FR-lane child ran", !h.spawned.some((a) => a === "fr-implementer" || a === "fr-test-auditor"), h.spawned.join(","));
  ok("no frozen contract or gap ledger was written", !existsSync(join(REPO, ".pi/fr-batch/x2-move-axis.contract.md")) && !existsSync(join(REPO, ".pi/fr-batch/x2-move-axis.gaps.json")));
}

// ---------------------------------------------------------------------------
console.log("\n--- 2. LAUNDERING: a fixer that inverts the pin is refused");
reset();
{
  let phase = "red";
  const h = harness({
    mode: () => phase,
    fixer: () => {
      // The cheat this pipeline exists to stop: green the reproduction by editing the assertion,
      // touch no source. A naive gate sees false->true and commits the destruction of the pin.
      const t = join(REPO, FX, "test.yaml");
      writeFileSync(t, readFileSync(t, "utf8").replace("!=", "=="), "utf8");
      phase = "fixed";
    },
  });
  const out = await run(h);
  const p = progress()["x2-move-axis"];
  ok("the item is BLOCKED, not committed", p?.status === "blocked", p?.status ?? "(none)");
  ok("...and the message names the pin it changed", out.includes("test.yaml"), out.split("\n").find((l) => l.includes("test.yaml")) ?? "");
  ok("...and says the report and pin ARE the specification", out.includes("specification"));
  ok("nothing was committed", sh("log", "--oneline").trim().split("\n").length === baseCount, `${sh("log", "--oneline").trim().split("\n").length} vs baseline ${baseCount}`);
  ok("the laundered pin is still in the tree for a human to see", readFileSync(join(REPO, FX, "test.yaml"), "utf8").includes("=="));
}

// ---------------------------------------------------------------------------
console.log("\n--- 3. a fixer that greens the repro by breaking a control is refused");
reset();
{
  let phase = "red";
  const h = harness({
    mode: () => phase,
    fixer: () => {
      writeFileSync(join(REPO, "src/act_move.cpp"), "int main(){/*wrong reason*/return 0;}\n", "utf8");
      phase = "weakened-control";
    },
  });
  const out = await run(h);
  const p = progress()["x2-move-axis"];
  ok("the item is BLOCKED", p?.status === "blocked", p?.status ?? "(none)");
  ok("...naming a regressed control", out.includes("control_"), out.split("\n").find((l) => l.includes("control_")) ?? "");
  ok("...and explaining what a control is for", out.includes("wrong reason"));
  ok("the fix budget was spent, not skipped", (p?.fixRounds ?? 0) >= 1, String(p?.fixRounds));
  ok("nothing was committed", sh("log", "--oneline").trim().split("\n").length === baseCount);
}

// ---------------------------------------------------------------------------
console.log("\n--- 4. an already-green pin is skipped, and the queue ADVANCES");
reset();
{
  const h = harness({ mode: () => "never-red", fixer: () => ok("no fixer should run", false) });
  const out = await run(h);
  const p = progress()["x2-move-axis"];
  ok("the item is skipped", p?.status === "skipped", p?.status ?? "(none)");
  ok("...with no child spawned at all", h.spawned.length === 0, h.spawned.join(",") || "(none)");
  // The live-lock this status exists to prevent: a non-terminal status made the driver re-select
  // the same item forever, re-running a real shell command and spawning nothing.
  ok("...and the run TERMINATED rather than re-selecting it", out.includes("finished"), out.split("\n")[0]);
  ok("...and the finished line counts it as skipped", out.includes("1 skipped"), out.split("\n")[0]);
}

// ---------------------------------------------------------------------------
console.log("\n--- 5. a runner that cannot report failure is caught at capture");
reset();
{
  const h = harness({ mode: () => "always-zero", fixer: () => ok("no fixer should run", false) });
  const out = await run(h);
  ok("the item is blocked before any child", progress()["x2-move-axis"]?.status === "blocked");
  ok("...naming the disagreement between the exit code and its own rows", out.includes("greenExit") && out.includes("report failure"), out.split("\n").find((l) => l.includes("greenExit")) ?? "");
  ok("...and no baseline was written", !existsSync(join(REPO, ".pi/fr-batch/x2-move-axis.baseline.json")));
  ok("...and no child ran", h.spawned.length === 0, h.spawned.join(",") || "(none)");
}

// ---------------------------------------------------------------------------
console.log("\n--- 6. a mid-suite crash is an incomplete run, not fixer tampering");
reset();
{
  let phase = "red";
  const h = harness({
    mode: () => phase,
    fixer: () => {
      writeFileSync(join(REPO, "src/act_move.cpp"), "int main(){return 0;}\n", "utf8");
      phase = "crash";
    },
  });
  const out = await run(h);
  ok("the item is blocked", progress()["x2-move-axis"]?.status === "blocked");
  // The distinction that matters. Asserted on the classification line rather than the whole
  // message: the explanatory prose deliberately contains the word "deleted" to draw this contrast.
  const head = out.split("\n").find((l) => l.includes("record is incomplete")) ?? "";
  ok("...reported as an incomplete RECORD", head.length > 0, head.slice(0, 130));
  ok("...and NOT as a regression", !out.includes("REGRESSED"), out.split("\n").find((l) => l.includes("REGRESSED")) ?? "no REGRESSED line");
  ok("...costing no round beyond the one that ran", (progress()["x2-move-axis"]?.fixRounds ?? 9) <= 1, String(progress()["x2-move-axis"]?.fixRounds));
}

// ---------------------------------------------------------------------------
console.log("\n--- 7. an untracked pin cannot be protected, so the run refuses");
reset();
await withQueue(
  (q) => {
    q.items = [{ id: "untracked", kind: "bug", plan: "tests/fixtures/fresh_bug/BUG_REPORT.md" }];
  },
  async () => {
    execFileSync("bash", ["-lc", `mkdir -p ${REPO}/tests/fixtures/fresh_bug && echo report > ${REPO}/tests/fixtures/fresh_bug/BUG_REPORT.md`]);
    const h = harness({ mode: () => "red", fixer: () => ok("no fixer should run", false) });
    const out = await run(h);
    // Two independent refusals cover this, and either is correct: the clean-tree guard sees the
    // untracked fixture, and capture would refuse it for having no tracked file. Both keep the
    // batch from starting against a pin it cannot protect.
    ok("a fresh, uncommitted pin does not start", out.includes("REFUSED") || out.includes("not committed"), out.split("\n")[0]);
    ok("...and no child ran", h.spawned.length === 0, h.spawned.join(",") || "(none)");
  },
);
reset();

// ---------------------------------------------------------------------------
console.log("\n--- 8. exit mode: a pin with no results sink at all");
reset();
{
  writeFileSync(join(REPO, "tools/exit_pin.sh"), 'test -f "$PWD/FIXED" && exit 0 || exit 1\n', "utf8");
  sh("add", "-A");
  // Committed only when it is actually new: the pin must be TRACKED for capture to accept it, and
  // a re-run of this harness finds it already there.
  if (sh("status", "--porcelain").trim().length > 0) sh("commit", "-qm", "exit-mode pin");
  const localBase = sh("rev-parse", "HEAD").trim();
  await withQueue(
    (q) => {
      q.items = [
        {
          id: "exitmode",
          kind: "bug",
          plan: `${EXITFX}/BUG_REPORT.md`,
          // `results: null` is the sentinel. Without it this item would inherit the queue's sink,
          // never write it, and hard-block forever — which is the whole reason the sentinel exists.
          bugProtocol: { run: ["bash tools/exit_pin.sh"], results: null },
        },
      ];
    },
    async () => {
      const h = harness({ mode: () => "red", fixer: () => writeFileSync(join(REPO, "FIXED"), "y\n", "utf8") });
      const out = await run(h);
      const p = progress()["exitmode"];
      ok("an exit-mode item commits", p?.status === "committed", `${p?.status} · ${out.split("\n")[0]}`);
      const b = JSON.parse(readFileSync(join(REPO, ".pi/fr-batch/exitmode.baseline.json"), "utf8"));
      ok("...with the mode recorded as exit", b.mode === "exit", b.mode);
      ok("...and no per-scenario map", Object.keys(b.scenarios).length === 0);
    },
  );
  sh("reset", "-q", "--hard", localBase);
  sh("clean", "-qfd");
}
reset();

// ---------------------------------------------------------------------------
console.log("\n--- 9. LAUNDERING via git: a fixer that hides its own edit is refused");
reset();
{
  let phase = "red";
  const h = harness({
    mode: () => phase,
    fixer: () => {
      // The attack the immutability diff alone cannot see: mark the pin assume-unchanged, then edit
      // it. `git status --porcelain` and `git diff HEAD` both go silent, and `git add -A` does not
      // even stage the edit — so without the ls-files check this commits green with the defect
      // intact and no record of the change anywhere.
      execFileSync("git", ["update-index", "--assume-unchanged", `${FX}/test.yaml`], { cwd: REPO });
      const f = join(REPO, FX, "test.yaml");
      writeFileSync(f, readFileSync(f, "utf8").replace("!=", "=="), "utf8");
      phase = "fixed";
    },
  });
  const out = await run(h);
  const p = progress()["x2-move-axis"];
  ok("the item is BLOCKED", p?.status === "blocked", p?.status ?? "(none)");
  ok("...naming the suppressed pin and the git letter", out.includes("test.yaml") && out.includes('letter "h"'), out.split("\n").find((l) => l.includes("letter")) ?? "");
  ok("...and telling the operator how to clear it", out.includes("--no-assume-unchanged"));
  ok("nothing was committed", sh("log", "--oneline").trim().split("\n").length === baseCount);
  execFileSync("git", ["update-index", "--no-assume-unchanged", `${FX}/test.yaml`], { cwd: REPO });
}
reset();

// ---------------------------------------------------------------------------
console.log("\n--- 10. LAUNDERING via a commit: the fixer commits its own pin edit");
reset();
{
  let phase = "red";
  const h = harness({
    mode: () => phase,
    fixer: () => {
      // Every diff-shaped check reports a CLEAN tree after this: the edit is in HEAD.
      const f = join(REPO, FX, "test.yaml");
      writeFileSync(f, readFileSync(f, "utf8").replace("!=", "=="), "utf8");
      execFileSync("git", ["add", "-A"], { cwd: REPO });
      execFileSync("git", ["-c", "user.email=x@x", "-c", "user.name=x", "commit", "-qm", "sneaky"], { cwd: REPO });
      phase = "fixed";
    },
  });
  const out = await run(h);
  ok("the item is BLOCKED", progress()["x2-move-axis"]?.status === "blocked", progress()["x2-move-axis"]?.status ?? "(none)");
  ok("...because HEAD moved", out.includes("HEAD moved"), out.split("\n").find((l) => l.includes("HEAD")) ?? "");
  ok("...naming both shas", /[0-9a-f]{9} -> [0-9a-f]{9}/.test(out), out.split("\n").find((l) => l.includes("->")) ?? "");
}
reset();

// ---------------------------------------------------------------------------
console.log("\n--- 11. LAUNDERING via a symlink: the pin is reached through a link");
reset();
{
  // The link is committed, so it is part of the pin as captured. Editing through it changes the
  // TARGET, which a path-prefix test never looks at.
  execFileSync("bash", ["-lc", `cd ${REPO} && mkdir -p real && cp ${FX}/test.yaml real/pin.yaml && rm ${FX}/test.yaml && ln -s ../../../real/pin.yaml ${FX}/test.yaml`]);
  sh("add", "-A");
  sh("-c", "user.email=x@x", "-c", "user.name=x", "commit", "-qm", "pin behind a symlink");
  const linkBase = sh("rev-parse", "HEAD").trim();
  let phase = "red";
  const h = harness({
    mode: () => phase,
    fixer: () => {
      const f = join(REPO, "real/pin.yaml");
      writeFileSync(f, readFileSync(f, "utf8").replace("!=", "=="), "utf8");
      phase = "fixed";
    },
  });
  const out = await run(h);
  ok("the item is BLOCKED", progress()["x2-move-axis"]?.status === "blocked", progress()["x2-move-axis"]?.status ?? "(none)");
  ok("...because the pin's CONTENT changed, symlink or not", out.includes("changed the pin"), out.split("\n")[2] ?? "");
  sh("reset", "-q", "--hard", `${linkBase}~1`);
  sh("clean", "-qfd");
}
reset();

// ---------------------------------------------------------------------------
console.log("\n--- 12. the diff-blinding tricks a content hash does not consult");
reset();
{
  let phase = "red";
  const h = harness({
    mode: () => phase,
    fixer: () => {
      // Silence the untracked half AND the tracked half, three ways at once.
      execFileSync("bash", ["-lc", `cd ${REPO} && echo 'test.yaml' >> .git/info/exclude && git config status.showUntrackedFiles no`]);
      const f = join(REPO, FX, "test.yaml");
      writeFileSync(f, readFileSync(f, "utf8").replace("!=", "=="), "utf8");
      phase = "fixed";
    },
  });
  const out = await run(h);
  ok("the item is BLOCKED", progress()["x2-move-axis"]?.status === "blocked", progress()["x2-move-axis"]?.status ?? "(none)");
  ok("...because a content hash consults no git configuration", out.includes("changed the pin"), out.split("\n")[2] ?? "");
  execFileSync("bash", ["-lc", `cd ${REPO} && git config --unset status.showUntrackedFiles; : > .git/info/exclude`]);
}
reset();

console.log(fails === 0 ? "\ne2e: all pass" : `\ne2e: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
