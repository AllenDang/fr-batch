// Guard probes for the SECOND audit wave: defects found by reading fr-batch against
// pi-subagents' and git's actual behaviour rather than against its own constants.
//
// Every block below names the failure it prevents, and every one was verified to turn RED when
// its fix is reverted. What they have in common with probe_install.ts: they assert against a rule
// established OUTSIDE this repo (git's check-ignore semantics, pi-subagents' temp-root layout) or
// against a behaviour the old code could not exhibit, so none of them can pass vacuously.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { partitionGaps } from "../contract.ts";
import { findPendingAsks, supervisorChannelRoots } from "../resilience.ts";
import { loadProgress, pruneItemArtifacts, setProgress } from "../store.ts";
import { resetItem } from "../queue_ops.ts";
import { drivers } from "../state.ts";
import type { AuditGap } from "../types.ts";

let fails = 0;
const ok = (n: string, c: boolean, extra = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? ` — ${extra}` : ""}`);
  if (!c) fails++;
};
const gap = (id: string): AuditGap => ({ id, kind: "branch", what: "w", why_missing: "m", suggested_row: "r" });

// ---------------------------------------------------------------------------
// 1. scope gate: an id is in contract only as a TOKEN
//
// `hay.includes(id)` let a short or invented id match almost any contract text — `T1` is inside
// `T10`, and `A` is inside every word containing an "a". An out-of-contract gap that passes the
// scope gate BLOCKS the item, which is the single thing this gate exists to prevent.
// ---------------------------------------------------------------------------
{
  const contract = "| T10 | clamps below range | invert the min |\n| B-2 | bare form | drop the map arm |\n";
  const { blocking, outOfScope } = partitionGaps([gap("T10"), gap("T1"), gap("B-2"), gap("B-2x"), gap("NEW-1")], contract);
  const ids = (l: AuditGap[]) => l.map((g) => g.id).join(",");
  ok("a real row id blocks", blocking.some((g) => g.id === "T10") && blocking.some((g) => g.id === "B-2"), ids(blocking));
  ok("T1 does NOT count as in-contract just because T10 exists", !blocking.some((g) => g.id === "T1"), ids(blocking));
  ok("...nor does B-2x", !blocking.some((g) => g.id === "B-2x"), ids(blocking));
  ok("a NEW- prefixed id is still out of scope", outOfScope.some((g) => g.id === "NEW-1"));
  ok("every gap lands on exactly one side", blocking.length + outOfScope.length === 5);
  // A row id at the very start/end of the contract text still has to match.
  ok("an id at the contract's first byte matches", partitionGaps([gap("T10")], "T10 | x |").blocking.length === 1);
  ok("...and one at its last byte", partitionGaps([gap("T99")], "| x | T99").blocking.length === 1);
  ok("case is ignored, as before", partitionGaps([gap("t10")], contract).blocking.length === 1);
}

// ---------------------------------------------------------------------------
// 2. an unparseable verdict must re-run the AUDITOR ONLY, never the verify gate
//
// The retry used to `continue` the outer loop, whose first act is runVerify — so one transport
// hiccup in the auditor re-spent a full compile-and-test pass (verifyTimeoutMs is per COMMAND)
// twice before giving up. Counted here from the driver's real loop with a fake RPC.
// ---------------------------------------------------------------------------
{
  const { runBatch } = await import("../driver.ts");
  const { RPC_REQUEST, RPC_REPLY_PREFIX, ASYNC_COMPLETE } = await import("../rpc.ts");
  const repo = mkdtempSync(join(tmpdir(), "fr-batch-auditretry-"));
  const sh = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  mkdirSync(join(repo, ".pi/fr-batch"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "/.pi/\n/.pi-subagents/\n");
  writeFileSync(join(repo, "P.md"), "## Tests\n\n| id | what | proves |\n|---|---|---|\n| T1 | a | edit a |\n| T2 | b | edit b |\n");
  sh(["init", "-q"]);
  sh(["config", "user.email", "t@t"]);
  sh(["config", "user.name", "t"]);
  sh(["add", "-A"]);
  sh(["commit", "-qm", "init"]);
  writeFileSync(
    join(repo, ".pi/fr-batch/queue.json"),
    JSON.stringify({ armed: true, maxFixRounds: 2, childTimeoutMs: 60_000, verifyTimeoutMs: 60_000, defaultVerify: ["true"], items: [{ id: "x", plan: "P.md" }] }),
  );

  let verifyRuns = 0;
  let auditRuns = 0;
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const fire = (n: string, p: unknown) => {
    for (const h of [...(handlers.get(n) ?? [])]) h(p);
  };
  let n = 0;
  const pi: any = {
    exec: async (cmd: string, args: string[], o: any) => {
      if (cmd === "bash") verifyRuns++;
      try {
        return { code: 0, stdout: execFileSync(cmd, args, { cwd: o?.cwd ?? repo, encoding: "utf8" }), stderr: "" };
      } catch (e: any) {
        return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e) };
      }
    },
    events: {
      on: (name: string, h: (d: unknown) => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(h);
        return () => handlers.get(name)!.delete(h);
      },
      emit: (name: string, payload: unknown) => {
        if (name !== RPC_REQUEST) return void fire(name, payload);
        const req = payload as { requestId: string; params: any };
        const asyncId = `run-${++n}`;
        const script = String(req.params?.workflowScript ?? "");
        const child = JSON.parse(script.slice(script.indexOf("{"), script.lastIndexOf("}") + 1));
        if (child.agent === "fr-test-auditor") auditRuns++;
        fire(`${RPC_REPLY_PREFIX}${req.requestId}`, { version: 1, requestId: req.requestId, success: true, data: { text: "ok", details: { asyncId } } });
        setTimeout(() => {
          writeFileSync(join(repo, "impl.txt"), `work ${n}\n`);
          // The auditor answers with PROSE for its first two runs (the transport failure this
          // retry exists for), then a valid verdict.
          const structured =
            child.agent === "fr-test-auditor"
              ? auditRuns > 2
                ? { verdict: "complete", gaps: [] }
                : undefined
              : undefined;
          fire(ASYNC_COMPLETE, {
            runId: asyncId,
            state: "completed",
            results: [{ status: "complete", summary: child.agent === "fr-test-auditor" ? "I have completed the audit. Let me verify..." : "done", ...(structured ? { structuredOutput: structured } : {}) }],
          });
        }, 5);
      },
    },
    appendEntry: () => {},
  };
  const out = await runBatch(pi, { cwd: repo, hasUI: false, ui: {} } as any, { background: true }, () => {});
  ok("the item still commits after two unparseable verdicts", /finished/.test(out), out.split("\n")[0]);
  ok("the auditor ran three times (two transport failures + one good verdict)", auditRuns === 3, `auditRuns=${auditRuns}`);
  ok("...and the verify gate ran ONCE, not once per audit attempt", verifyRuns === 1, `verifyRuns=${verifyRuns}`);
  // Non-vacuous only because the two rows above pin auditRuns === 3: without them "the ledger is
  // absent" would also be satisfied by an item that never reached the audit at all. Stated, because
  // the coupling is invisible from this line.
  ok("...and no gap reached the ledger", !existsSync(join(repo, ".pi/fr-batch/x.gaps.json")) || readFileSync(join(repo, ".pi/fr-batch/x.gaps.json"), "utf8").trim() === "{}");
}

// ---------------------------------------------------------------------------
// 3. reset refuses while a driver is live (archive already did; reset did not)
// ---------------------------------------------------------------------------
{
  const repo = mkdtempSync(join(tmpdir(), "fr-batch-reset-"));
  mkdirSync(join(repo, ".pi/fr-batch"), { recursive: true });
  writeFileSync(join(repo, ".pi/fr-batch/progress.json"), JSON.stringify({ x: { status: "implementing", fixRounds: 0, updatedAt: "now" } }));
  drivers.set(repo, {
    startedAt: Date.now(),
    abort: new AbortController(),
    stopRequested: false,
    hardStopped: false,
    detached: true,
    lines: ["  implement…"],
    settled: Promise.resolve(),
    touch: undefined,
  });
  const refused = resetItem(repo, "x");
  ok("reset is refused while a driver runs here", /refused/i.test(refused) && /stop/.test(refused), refused.split("\n")[0]);
  ok("...and the progress entry survives", loadProgress(repo).x?.status === "implementing");
  drivers.delete(repo);
  // A lock naming a LIVE process means another session may be driving: same hazard, same refusal.
  // Liveness is the test now, not the file's age — the pid was always in the lock and age was a
  // fifteen-minute guess that left a crashed driver's item unclearable for a quarter of an hour.
  writeFileSync(join(repo, ".pi/fr-batch/.run.lock"), `pid ${process.ppid} since now\n`);
  const lockRefused = resetItem(repo, "x");
  ok("reset is refused while the lock names a LIVE pid", /refused/i.test(lockRefused) && /run lock/.test(lockRefused), lockRefused.split("\n")[0]);
  ok("...naming the pid and that it is running", /RUNNING/.test(lockRefused), lockRefused.split("\n")[0]);
  ok("...and still nothing was deleted", Boolean(loadProgress(repo).x));
  // A lock naming a DEAD pid must not block, however fresh the file is. `pid 2` on a mac/linux is
  // either init's neighbour or absent; the probe uses a pid it just observed to be gone instead.
  const deadPid = 2_000_000_000; // far above any pid_max
  writeFileSync(join(repo, ".pi/fr-batch/.run.lock"), `pid ${deadPid} since now\n`);
  const done = resetItem(repo, "x");
  ok("a lock naming a DEAD pid does not block a reset, however fresh", /reset "x"/.test(done), done.split("\n")[0]);
  ok("...and the entry is gone", !loadProgress(repo).x);
}

// ---------------------------------------------------------------------------
// 4. a patch that omits `status` must not wipe a live pause's revival fields
// ---------------------------------------------------------------------------
{
  const repo = mkdtempSync(join(tmpdir(), "fr-batch-progress-"));
  mkdirSync(join(repo, ".pi/fr-batch"), { recursive: true });
  setProgress(repo, "x", {
    status: "paused",
    pauseKind: "decision",
    pausedPhase: "implement",
    pausedChildId: "run-7",
    pendingAsk: "which option?",
    note: "needs a decision",
  });
  setProgress(repo, "x", { fixRounds: 2 }); // a bare bump, no status
  const e = loadProgress(repo).x!;
  ok("a status-less patch keeps the pause kind", e.pauseKind === "decision", JSON.stringify(e));
  ok("...the child id `continue` needs to revive it", e.pausedChildId === "run-7");
  ok("...and the question", e.pendingAsk === "which option?");
  ok("...while still applying the patch", e.fixRounds === 2 && e.status === "paused");
  // Leaving the pause DOES clear them, as before — a stale child id must never be revivable.
  setProgress(repo, "x", { status: "verifying" });
  const g = loadProgress(repo).x!;
  ok("leaving the pause clears the revival fields", !g.pausedChildId && !g.pendingAsk && !g.pauseKind, JSON.stringify(g));
}

// ---------------------------------------------------------------------------
// 5. an EXPIRED supervisor request is not reported as a pending question
// ---------------------------------------------------------------------------
{
  const root = supervisorChannelRoots()[supervisorChannelRoots().length - 1];
  const runId = `probe-exp-${process.pid}`;
  const chan = join(root, `${runId}-fr-implementer-0`);
  mkdirSync(join(chan, "requests"), { recursive: true });
  mkdirSync(join(chan, "replies"), { recursive: true });
  writeFileSync(join(chan, "requests", "live.json"), JSON.stringify({ reason: "need_decision", message: "still asking", expiresAt: Date.now() + 600_000 }));
  writeFileSync(join(chan, "requests", "dead.json"), JSON.stringify({ reason: "need_decision", message: "gave up long ago", expiresAt: Date.now() - 1_000 }));
  writeFileSync(join(chan, "requests", "noexp.json"), JSON.stringify({ reason: "need_decision", message: "no deadline recorded" }));
  const found = findPendingAsks(runId).map((a) => a.requestId).sort();
  ok("an unexpired ask is reported", found.includes("live"), found.join(","));
  ok("a request with no expiry is reported (absence is not expiry)", found.includes("noexp"), found.join(","));
  ok("an EXPIRED ask is not \u2014 the child stopped polling it", !found.includes("dead"), found.join(","));
}

// ---------------------------------------------------------------------------
// 6. prune keeps the AUDIT verdict AND its narration, and reports what it deleted
//
// Two traps. `-audit-(\d+)\.json$` also matched `-fix-audit-1.json`, so the "last verdict" the prune
// kept could be the FIXER's report while the audit verdict — the file every commit and block message
// points at as `Full verdict: <path>` — was deleted.
//
// And the audit now writes TWO files per round: the child's prose narration (`.md`, which is what
// `outputMode: "file-only"` actually delivers) and the schema-valid verdict (`.verdict.json`). Both
// halves of the last round are kept, because a verdict with no narration cannot be reviewed and a
// narration with no verdict cannot be trusted.
// ---------------------------------------------------------------------------
{
  const repo = mkdtempSync(join(tmpdir(), "fr-batch-prune-"));
  const dir = join(repo, ".pi-subagents", "fr-batch");
  mkdirSync(dir, { recursive: true });
  // No `x-implement.md` on disk: it is in `keep`, so the old `files.length - keep.size` undercounted.
  const all = [
    "x-audit-0.md",
    "x-audit-0.verdict.json",
    "x-audit-1.md",
    "x-audit-1.verdict.json",
    "x-fix-audit-1.json",
  ];
  for (const f of all) writeFileSync(join(dir, f), "{}");
  const lines: string[] = [];
  pruneItemArtifacts(repo, "x", (l) => lines.push(l));
  const said = Number(/pruned (\d+) intermediate/.exec(lines.join("\n"))?.[1] ?? -1);
  const left = all.filter((f) => existsSync(join(dir, f)));
  ok("the last AUDIT verdict is kept", left.includes("x-audit-1.verdict.json"), left.join(","));
  ok("...and its narration with it", left.includes("x-audit-1.md"), left.join(","));
  ok("...and a fixer report is not mistaken for the verdict", !left.includes("x-fix-audit-1.json"), left.join(","));
  ok("...and the earlier round is gone, both halves", !left.includes("x-audit-0.verdict.json") && !left.includes("x-audit-0.md"), left.join(","));
  ok("the count it reports equals the number it deleted", said === all.length - left.length, `said ${said}, deleted ${all.length - left.length}`);
  ok("...and it does not claim to have kept a file that is not there", !/x-implement\.md/.test(lines.join("\n")), lines.join(" | "));
}

console.log(fails === 0 ? "\nprobe_audit2: all pass" : `\nprobe_audit2: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
