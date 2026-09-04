// FR-lane regression: does a queue.json written BEFORE kind:"bug" existed still load, run and commit?
//
// The existing 323 assertions already cover this implicitly — probe_batch / probe_driver /
// probe_config / probe_audit2 all drive the real runBatch against a legacy queue shape. This file
// makes it explicit and measured, because "the suite is green" and "an old queue still works" are
// different claims and only the second one is what an existing user cares about.
//
// Deliberately byte-legacy: no `kind`, no `fixture`, no `bugProtocol`, no field this change added.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBatch } from "../driver.ts";
import { transientHit, transientReason } from "../resilience.ts";
import { setProgress } from "../store.ts";
import type { ChildOutcome } from "../rpc.ts";
import { renderStatus } from "../render.ts";
import { ASYNC_COMPLETE, RPC_REPLY_PREFIX, RPC_REQUEST } from "../rpc.ts";
import { addItem, archiveItems, removeItem, resetItem } from "../queue_ops.ts";

let fails = 0;
const ok = (n: string, c: boolean, extra = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? ` — ${extra}` : ""}`);
  if (!c) fails++;
};

const GAP1 = { id: "T1", kind: "branch", what: "row 1 untested", why_missing: "no case", suggested_row: "add it" };
const GAP2 = { id: "T2", kind: "branch", what: "row 2 untested", why_missing: "no case", suggested_row: "add it" };
const GAP3 = { id: "T3", kind: "branch", what: "row 3 untested", why_missing: "no case", suggested_row: "add it" };
const GAP4 = { id: "T4", kind: "branch", what: "row 4 untested", why_missing: "no case", suggested_row: "add it" };

const PLAN = [
  "# FR: a thing",
  "",
  "## 0. Decisions (read before coding)",
  "- do the thing",
  "",
  "## Tests",
  "",
  "| id | what | proves non-vacuous |",
  "|---|---|---|",
  "| T1 | the thing happens | invert the flag |",
  "| T2 | the boundary holds | drop the clamp |",
  "",
].join("\n");

function legacyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "fr-legacy-"));
  const sh = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  sh("init", "-q");
  sh("config", "user.email", "t@t");
  sh("config", "user.name", "t");
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(join(repo, ".pi", "fr-batch"), { recursive: true });
  writeFileSync(join(repo, "docs", "FR_thing_PLAN.md"), PLAN, "utf8");
  writeFileSync(join(repo, ".gitignore"), "/.pi/\n/.pi-subagents/\n", "utf8");
  // EXACTLY the shape a queue.json had before this change. Any new key here would defeat the point.
  writeFileSync(
    join(repo, ".pi", "fr-batch", "queue.json"),
    `${JSON.stringify({ armed: true, defaultVerify: ["true"], items: [{ id: "thing", plan: "docs/FR_thing_PLAN.md" }] }, null, 2)}\n`,
    "utf8",
  );
  sh("add", "-A");
  sh("commit", "-qm", "init");
  return repo;
}

/** probe_driver.ts's pattern: a real shell, a fake subagent bus whose children edit the tree. */
function fake(repo: string, opts: { verdict?: unknown; verdicts?: unknown[] } = {}) {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const spawned: string[] = [];
  const calls: Array<{ method: string; params: unknown }> = [];
  let n = 0;
  let audits = 0;
  const fire = (name: string, p: unknown) => [...(handlers.get(name) ?? [])].forEach((h) => h(p));
  const pi: any = {
    exec: async (cmd: string, args: string[], o: any) => {
      try {
        return { code: 0, stdout: execFileSync(cmd, args, { cwd: o?.cwd ?? repo, encoding: "utf8" }), stderr: "", killed: false };
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
        calls.push({ method: String(payload.method), params: payload.params });
        const agent = /"agent":\s*"([^"]+)"/.exec(String(payload.params?.workflowScript ?? ""))?.[1] ?? "?";
        spawned.push(agent);
        const asyncId = `run-${++n}`;
        fire(`${RPC_REPLY_PREFIX}${payload.requestId}`, { version: 1, requestId: payload.requestId, success: true, data: { text: "ok", details: { asyncId } } });
        setTimeout(() => {
          // The implementer must leave changes, or the driver treats success-with-no-diff as failure.
          if (agent === "fr-implementer") writeFileSync(join(repo, "src.txt"), "implemented\n", "utf8");
          fire(ASYNC_COMPLETE, {
            runId: asyncId,
            state: "completed",
            results: [
              {
                status: "complete",
                summary: "done",
                ...(agent === "fr-test-auditor"
                  ? { structuredOutput: opts.verdicts ? (opts.verdicts[Math.min(audits++, opts.verdicts.length - 1)] ?? { verdict: "complete", gaps: [] }) : (opts.verdict ?? { verdict: "complete", gaps: [] }) }
                  : {}),
              },
            ],
          });
        }, 5);
      },
    },
    appendEntry: () => {},
    sendMessage: () => {},
  };
  return { pi, ctx: { cwd: repo, hasUI: false, ui: {} } as any, spawned, calls };
}

// ---------------------------------------------------------------------------
console.log("\n--- a legacy queue.json runs the FR pipeline unchanged");
{
  const repo = legacyRepo();
  const h = fake(repo);
  const out = await runBatch(h.pi, h.ctx, { background: true }, () => {});
  const p = JSON.parse(readFileSync(join(repo, ".pi/fr-batch/progress.json"), "utf8"));
  ok("the item committed", p.thing?.status === "committed", `${p.thing?.status} · ${out.split("\n")[0]}`);
  ok("...with a sha", Boolean(p.thing?.sha), p.thing?.sha ?? "(none)");
  ok("the FR children ran, in order", h.spawned.join(",") === "fr-implementer,fr-test-auditor", h.spawned.join(","));
  ok("...and NO bug-lane child was spawned", !h.spawned.some((a) => a.startsWith("fr-bug-")), h.spawned.join(","));
  ok("the contract was frozen", existsSync(join(repo, ".pi/fr-batch/thing.contract.md")));
  ok("...and holds the PLAN's Tests matrix, not the whole PLAN", readFileSync(join(repo, ".pi/fr-batch/thing.contract.md"), "utf8").includes("| T1 |"));
  ok("no baseline or siblings file appeared for an FR item", !existsSync(join(repo, ".pi/fr-batch/thing.baseline.json")) && !existsSync(join(repo, ".pi/fr-batch/thing.siblings.md")));
  ok("git history grew by exactly one", execFileSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" }).trim().split("\n").length === 2);
  ok("...and the commit carries the implementer's file", execFileSync("git", ["show", "--stat", "HEAD"], { cwd: repo, encoding: "utf8" }).includes("src.txt"));
  ok("the finished line names the fr kind", out.includes('kind:"fr"'), out.split("\n")[0]);
  ok("...and reports no skipped items", !out.includes("skipped"), out.split("\n")[0]);
}

// ---------------------------------------------------------------------------
console.log("\n--- the FR audit loop still blocks on an in-contract gap");
{
  const repo = legacyRepo();
  // maxFixRounds 0: the gap cannot be worked, so the item must block rather than spawn a fixer.
  const qp = join(repo, ".pi/fr-batch/queue.json");
  const q = JSON.parse(readFileSync(qp, "utf8"));
  q.maxFixRounds = 0;
  writeFileSync(qp, JSON.stringify(q, null, 2), "utf8");
  const h = fake(repo, {
    verdict: { verdict: "gaps_found", gaps: [{ id: "T1", kind: "branch", what: "untested", why_missing: "no case", suggested_row: "add it" }] },
  });
  const out = await runBatch(h.pi, h.ctx, { background: true }, () => {});
  const p = JSON.parse(readFileSync(join(repo, ".pi/fr-batch/progress.json"), "utf8"));
  ok("the item is blocked", p.thing?.status === "blocked", p.thing?.status ?? "(none)");
  ok("...naming the in-contract gap", out.includes("T1"), out.split("\n").find((l) => l.includes("T1")) ?? "");
  ok("...and no fixer was spawned at maxFixRounds 0", !h.spawned.includes("fr-gap-fixer"), h.spawned.join(","));
  ok("nothing was committed", execFileSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" }).trim().split("\n").length === 1);
}

// ---------------------------------------------------------------------------
console.log("\n--- an out-of-contract gap is still demoted, not blocking");
{
  const repo = legacyRepo();
  const h = fake(repo, {
    verdict: { verdict: "gaps_found", gaps: [{ id: "NOT-IN-CONTRACT", kind: "branch", what: "x", why_missing: "y", suggested_row: "z" }] },
  });
  await runBatch(h.pi, h.ctx, { background: true }, () => {});
  const p = JSON.parse(readFileSync(join(repo, ".pi/fr-batch/progress.json"), "utf8"));
  ok("the item still committed", p.thing?.status === "committed", p.thing?.status ?? "(none)");
  ok("...and the finding was recorded as out-of-scope", existsSync(join(repo, ".pi/fr-batch/thing.out-of-scope.md")));
}

// ---------------------------------------------------------------------------
console.log("\n--- the FR queue surfaces are unchanged");
{
  const repo = legacyRepo();
  const h = fake(repo);
  await runBatch(h.pi, h.ctx, { background: true }, () => {});

  const st = renderStatus(repo, {});
  // The summary view FOLDS items at rest — that is the O(1) render property, not a regression — so
  // the committed item shows up in the header count and in the folded line, never as a row.
  ok("the summary header counts the committed FR item", st.includes("1/1 committed"), st.split("\n")[0]);
  ok("...and all:true does list it as a row", renderStatus(repo, {}, { all: true }).includes("thing"));

  const detail = renderStatus(repo, {}, { only: "thing" });
  const stateLine = detail.split("\n").find((l) => l.includes("state:")) ?? "";
  // An FR item can never own a baseline or a siblings file, so a fixed denominator of 5 would make
  // its detail read "2/5" forever. The line reports what is present instead.
  ok("the item detail's state line does not promise files this kind cannot have", !/\/\d+ file/.test(stateLine) && /state file\(s\)/.test(stateLine), stateLine);

  ok("remove refuses a committed FR item and points at archive", removeItem(repo, "thing").includes("archive"));
  const arch = archiveItems(repo);
  ok("archive sweeps a committed FR item", arch.includes("archived 1"), arch.split("\n")[0]);
  ok("...and its contract moved rather than vanishing", existsSync(join(repo, ".pi/fr-batch/archive/thing/thing.contract.md")));
  ok("...and the history line records it", readFileSync(join(repo, ".pi/fr-batch/history.jsonl"), "utf8").includes('"id":"thing"'));

  const added = addItem(repo, { plan: "docs/FR_thing_PLAN.md" });
  ok("add still queues an FR item with no kind key", added.includes("queued"), added.split("\n")[0]);
  ok("...and writes no kind field", !readFileSync(join(repo, ".pi/fr-batch/queue.json"), "utf8").includes('"kind"'));
  ok("reset clears an FR item", resetItem(repo, "thing").includes("reset") || resetItem(repo, "thing").includes("no progress entry"));
}


// ---------------------------------------------------------------------------
console.log("\n--- incremental audit discovery is NOT treated as non-convergence");
{
  // The trajectory a strict-shrink guard blocked: round 1 raises two rows, the fixer closes BOTH,
  // and round 2 surfaces two DIFFERENT rows the auditor had not reached yet. Nothing is
  // re-litigated, the ledger's distinct-id total doubles, and two rounds of budget remain — so this
  // is the healthiest possible shape, and it used to be blocked as "the gap set is not shrinking".
  //
  // An audit is not exhaustive at round 0: coverage is established a row at a time, so a large
  // matrix takes several rounds to walk.
  const repo = legacyRepo();
  const plan = join(repo, "docs", "FR_thing_PLAN.md");
  writeFileSync(
    plan,
    PLAN.replace("| T2 | the boundary holds | drop the clamp |", "| T2 | the boundary holds | drop the clamp |\n| T3 | the clamp's other side | invert it |\n| T4 | the error code fires | delete the throw |"),
    "utf8",
  );
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "wider matrix"], { cwd: repo });
  const h = fake(repo, {
    verdicts: [
      { verdict: "gaps_found", gaps: [GAP1, GAP2] },
      { verdict: "gaps_found", gaps: [GAP3, GAP4] },
      { verdict: "complete", gaps: [] },
    ],
  });
  const out = await runBatch(h.pi, h.ctx, { background: true }, () => {});
  const p = JSON.parse(readFileSync(join(repo, ".pi/fr-batch/progress.json"), "utf8"));
  ok("the item committed rather than blocking on a flat gap count", p.thing?.status === "committed", `${p.thing?.status} \u00b7 ${out.split("\n")[0]}`);
  ok("...after two fix rounds", p.thing?.fixRounds === 2, String(p.thing?.fixRounds));
  ok("...and the message never claims the gap set failed to shrink", !out.includes("not shrinking"), out.split("\n")[0]);
  const ledger = JSON.parse(readFileSync(join(repo, ".pi/fr-batch/thing.gaps.json"), "utf8"));
  ok("the ledger records all four distinct rows, each raised once", Object.keys(ledger).sort().join(",") === "T1,T2,T3,T4", Object.keys(ledger).join(","));
  ok("...and no id was raised in more than one round", Object.values(ledger).every((e: any) => e.raisedRounds.length === 1), JSON.stringify(Object.values(ledger).map((e: any) => e.raisedRounds)));
}

// ---------------------------------------------------------------------------
console.log("\n--- but a RE-RAISED id still stops the batch");
{
  const repo = legacyRepo();
  const h = fake(repo, {
    verdicts: [
      { verdict: "gaps_found", gaps: [GAP1] },
      { verdict: "gaps_found", gaps: [GAP1] },
    ],
  });
  const out = await runBatch(h.pi, h.ctx, { background: true }, () => {});
  const p = JSON.parse(readFileSync(join(repo, ".pi/fr-batch/progress.json"), "utf8"));
  ok("the item is blocked", p.thing?.status === "blocked", p.thing?.status ?? "(none)");
  ok("...for re-litigation, naming the rounds", out.includes("already adjudicated") && out.includes("T1"), out.split("\n").find((l) => l.includes("T1")) ?? "");
}


// ---------------------------------------------------------------------------
console.log("\n--- the four defects reported from a real 27-item batch");
{
  // 1. The exact message that matched zero signatures, so the six-attempt retry loop never ran and
  //    four items lost hours each. Both halves of it are separately load-bearing: `socket hang up`
  //    is a different sentence from `socket disconnected`, and `\bTLS\b.*(handshake|alert)` does not
  //    reach `before secure TLS connection was established`.
  const reported =
    "Run 'main' failed: The pending stream has been canceled (caused by: Client network socket " +
    "disconnected before secure TLS connection was established)";
  ok("the reported undici connect failure is classified transient", transientHit(reported) !== null, String(transientHit(reported)));
  ok("...and so is the same message without the outer clause",
    transientHit("The pending stream has been canceled (caused by: Client network socket disconnected before secure TLS connection was established)") !== null);
  for (const half of ["Client network socket disconnected before secure TLS connection was established", "The pending stream has been canceled"]) {
    ok(`...and each half on its own: ${half.slice(0, 34)}…`, transientHit(half) !== null, String(transientHit(half)));
  }
  // The cause chain is matched, not just the outermost sentence: a fault named ONLY inside
  // `(caused by: …)` used to be invisible, and that is where transport faults live.
  // A fault named only inside `(caused by: …)` is found WITHOUT any chain unwrapping, because the
  // signatures are unanchored and the parenthesis is part of the string under test. Pinning this
  // stops the "unwrap the cause chain" suggestion from being re-implemented as dead code: an
  // unwrapping pass was written, and the mutation suite proved it changed no verdict.
  const inCause = "Run 'x' failed: the step did not succeed (caused by: ECONNRESET)";
  ok("a fault named only inside `caused by:` is already matched", transientHit(inCause) === "ECONNRESET", String(transientHit(inCause)));
  ok("...and the outer clause on its own carries no signature", transientHit("Run 'x' failed: the step did not succeed") === null);
  ok("...so matching the whole message is sufficient, not a simplification", transientHit("spawn failed (cause: EAI_AGAIN)") === "EAI_AGAIN");
  ok("...and a genuine failure is still not transient", transientHit("Assertion failed: expected 3, got 4") === null);

  // The wording-independent signal. A child that wrote nothing and died at 7m36s of a 3h budget is
  // not a considered failure; one that produced a report is, however early it died.
  const bare = { asyncId: "r", status: "failed", summary: "", error: "" } as ChildOutcome;
  const H3 = 3 * 3600 * 1000;
  ok("no output plus death far inside the budget is retried", transientReason(bare, H3, 456_000) !== null, String(transientReason(bare, H3, 456_000)));
  ok("...but not when the child left a report", transientReason({ ...bare, artifactPath: "/x/r.md" }, H3, 456_000) === null);
  ok("...nor when it left a summary", transientReason({ ...bare, summary: "could not build" }, H3, 456_000) === null);
  ok("...nor when it ran most of its budget", transientReason(bare, H3, Math.round(H3 * 0.9)) === null);
  ok("...and never when the driver stopped it", transientReason({ ...bare, stopped: true }, H3, 456_000) === null);
}
{
  // 2. A blocked item has a non-destructive exit now. `reset` starts over AND leaves the tree dirty,
  //    so the very next run hit the clean-tree refusal — the reporter parked 1172 verified lines in a
  //    git ref and watched a fresh child rewrite 187 that then diverged.
  const repo = legacyRepo();
  const h = fake(repo, { verdict: { verdict: "gaps_found", gaps: [GAP1] } });
  const qp = join(repo, ".pi/fr-batch/queue.json");
  const q = JSON.parse(readFileSync(qp, "utf8"));
  q.maxFixRounds = 0;
  writeFileSync(qp, JSON.stringify(q, null, 2), "utf8");
  await runBatch(h.pi, h.ctx, { background: true }, () => {});
  ok("the item is blocked", JSON.parse(readFileSync(join(repo, ".pi/fr-batch/progress.json"), "utf8")).thing?.status === "blocked");

  const bare = await runBatch(h.pi, h.ctx, { background: true }, () => {});
  ok("a bare run still refuses it (the sticky rule is unchanged)", bare.includes("STICKY"), bare.split("\n")[0]);
  ok("...and now names the work-preserving exit first", bare.includes('action "continue"') && bare.indexOf('action "continue"') < bare.indexOf('action "reset"'));
  ok("...and warns that reset leaves the tree dirty", bare.includes("does NOT clean the tree"));

  // The resumed run genuinely re-enters the pipeline: it re-audits, the auditor re-raises the same
  // id, and the re-litigation guard stops it. That is the CORRECT downstream behaviour and it is what
  // proves the resume happened at all — the sticky refusal never ran the pipeline.
  const resumed = await runBatch(h.pi, h.ctx, { only: "thing", resumeBlocked: true, background: true }, () => {});
  ok("continue on that exact id runs the pipeline instead of refusing", !resumed.includes("STICKY"), resumed.split("\n")[0]);
  ok("...and the contract was NOT re-frozen (the work is kept, not restarted)", existsSync(join(repo, ".pi/fr-batch/thing.contract.md")));
  ok("...and no fresh implementer ran over it", h.spawned.filter((a) => a === "fr-implementer").length === 1, h.spawned.join(","));
}
{
  // 3. The auditor's output file is its PROSE — it runs outputMode:"file-only" and the schema-valid
  //    verdict arrives on the completion event. Naming it `.json` made `json.load()` throw for any
  //    downstream reader.
  const repo = legacyRepo();
  const h = fake(repo);
  await runBatch(h.pi, h.ctx, { background: true }, () => {});
  const dir = join(repo, ".pi-subagents", "fr-batch");
  const listing = existsSync(dir) ? readdirSync(dir) : [];
  const verdicts = listing.filter((f) => f.startsWith("thing-audit-") && f.endsWith(".verdict.json"));
  ok("the audit verdict is written to a .verdict.json", verdicts.length > 0, listing.join(","));
  ok("...and it really parses as JSON with the schema's shape", (() => {
    const v = JSON.parse(readFileSync(join(dir, verdicts[0]), "utf8"));
    return v.verdict === "complete" && Array.isArray(v.gaps);
  })());
  ok("...and no bare thing-audit-N.json is left to be mistaken for it", !listing.some((f) => /^thing-audit-\d+\.json$/.test(f)), listing.join(","));
}
{
  // 4. A note on the item never reached the child: prompts.ts read plan/fr/reads and nothing else, so
  //    the operator's "the previous round is parked in <ref>, retrieve it" was invisible.
  const repo = legacyRepo();
  const h = fake(repo);
  setProgress(repo, "thing", { status: "pending", note: "RETRIEVE-FROM: refs/wip/thing-round-2" });
  await runBatch(h.pi, h.ctx, { background: true }, () => {});
  const spawnTasks = h.calls.filter((c) => String(c.method) === "spawn").map((c) => JSON.stringify(c.params));
  ok("the operator's note reaches the implementer's task", spawnTasks.some((s) => s.includes("RETRIEVE-FROM")), `${spawnTasks.length} spawn(s)`);
  ok("...labelled as the operator speaking, not as part of the PLAN", spawnTasks.some((s) => s.includes("Standing instruction from the operator")));
}

console.log(fails === 0 ? "\nprobe_fr_regression: all pass" : `\nprobe_fr_regression: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
