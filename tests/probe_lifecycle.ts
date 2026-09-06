// Run lifecycle: who is running, what a stop means for state, and what a budget counts.
//
// Covers the four root causes behind seven defects reported from a real 27-item batch. Everything
// here is headless: a real git repo, a real shell, a faked subagent bus. The one thing that cannot be
// faked is process liveness, so those rows use a genuinely live pid (this process's parent) and a pid
// far above any pid_max.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishDriver, startDriver } from "../background.ts";
import { VERIFY_DISPUTE_HEADING, extractAcceptanceSection, roundWasProductive } from "../contract.ts";
import { runBatch } from "../driver.ts";
import { classifyLaunchFailure, runIdOfWallclock } from "../resilience.ts";
import { ASYNC_COMPLETE, RPC_REPLY_PREFIX, RPC_REQUEST } from "../rpc.ts";
import { runlockPath } from "../paths.ts";
import { renderStatus } from "../render.ts";
import { acquireRunlock, describeLock, lockHolder, loadProgress, setProgress, touchRunlock } from "../store.ts";
import { drivers, generations } from "../state.ts";

let fails = 0;
const ok = (n: string, c: boolean, extra = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? ` — ${extra}` : ""}`);
  if (!c) fails++;
};

const LIVE_PID = process.ppid; // this process's parent: certainly alive while we run
const DEAD_PID = 2_000_000_000; // above any pid_max on any platform we run on

const PLAN = [
  "# FR: a thing",
  "",
  "## 0. Decisions (read before coding)",
  "- do it",
  "",
  "## 5. Tests",
  "",
  "| id | what | proves non-vacuous |",
  "|---|---|---|",
  // Eight rows, because a gap whose id is NOT in the frozen contract is demoted to non-blocking and
  // the audit then reads `complete`. A short matrix silently turns every budget row into a no-op.
  ...["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"].map((id) => `| ${id} | row ${id} | invert it |`),
  "",
  "## 6. Build, validate, test",
  "",
  "`make check` must be green, and there must be no ZONE-003 diagnostics (there was exactly 1).",
  "",
  "## 7. File-change checklist",
  "- src/thing.c",
  "",
].join("\n");

function repo(opts: { budgets?: Record<string, number> } = {}): string {
  const r = mkdtempSync(join(tmpdir(), "fr-life-"));
  const sh = (...a: string[]) => execFileSync("git", a, { cwd: r, encoding: "utf8" });
  sh("init", "-q");
  sh("config", "user.email", "t@t");
  sh("config", "user.name", "t");
  mkdirSync(join(r, "docs"), { recursive: true });
  mkdirSync(join(r, ".pi", "fr-batch"), { recursive: true });
  writeFileSync(join(r, "docs", "FR_thing_PLAN.md"), PLAN, "utf8");
  writeFileSync(join(r, ".gitignore"), "/.pi/\n/.pi-subagents/\n", "utf8");
  writeFileSync(
    join(r, ".pi", "fr-batch", "queue.json"),
    `${JSON.stringify({ armed: true, defaultVerify: ["true"], ...(opts.budgets ?? {}), items: [{ id: "thing", plan: "docs/FR_thing_PLAN.md" }] }, null, 2)}\n`,
    "utf8",
  );
  sh("add", "-A");
  sh("commit", "-qm", "init");
  return r;
}

interface FakeOpts {
  /** Verdict per audit round; the last entry repeats. */
  verdicts?: unknown[];
  /** Fixer report per fix round; the last entry repeats. */
  fixReports?: unknown[];
  /** Throw this from the launch instead of completing, once. */
  throwOnce?: Error;
  /** Report this status instead of "complete". */
  childStatus?: string;
  childError?: string;
  /** Called as soon as a child is launched, before it completes. */
  onSpawn?: () => void;
}
function fake(r: string, o: FakeOpts = {}) {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const spawned: string[] = [];
  let n = 0;
  let audits = 0;
  let fixes = 0;
  let threw = false;
  let fixReportPath: string | undefined;
  const fire = (name: string, p: unknown) => [...(handlers.get(name) ?? [])].forEach((h) => h(p));
  const pick = (arr: unknown[] | undefined, i: number) => (arr ? arr[Math.min(i, arr.length - 1)] : undefined);
  const pi: any = {
    exec: async (cmd: string, args: string[], opt: any) => {
      try {
        return { code: 0, stdout: execFileSync(cmd, args, { cwd: opt?.cwd ?? r, encoding: "utf8" }), stderr: "", killed: false };
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
        const agent = /"agent":\s*"([^"]+)"/.exec(String(payload.params?.workflowScript ?? ""))?.[1] ?? "?";
        spawned.push(agent);
        const asyncId = `run-${++n}`;
        o.onSpawn?.();
        if (o.throwOnce && !threw) {
          threw = true;
          // A launch that never replies: the RPC times out, which is the shape a hung host has.
          return;
        }
        fire(`${RPC_REPLY_PREFIX}${payload.requestId}`, { version: 1, requestId: payload.requestId, success: true, data: { text: "ok", details: { asyncId } } });
        setTimeout(() => {
          if (agent === "fr-implementer") writeFileSync(join(r, "src.txt"), "impl\n", "utf8");
          if (agent === "fr-gap-fixer") {
            const rep = pick(o.fixReports, fixes++);
            if (rep !== undefined) {
              // Written where the driver actually looks: it prefers the child's artifactPath and only
              // falls back to the path it asked for, so a report left elsewhere is silently ignored.
              const dir = join(r, ".pi-subagents", "fr-batch");
              mkdirSync(dir, { recursive: true });
              fixReportPath = join(dir, `thing-fix-audit-${fixes}.json`);
              writeFileSync(fixReportPath, JSON.stringify(rep), "utf8");
            }
          }
          fire(ASYNC_COMPLETE, {
            runId: asyncId,
            state: "completed",
            results: [
              {
                status: o.childStatus ?? "complete",
                summary: "done",
                ...(agent === "fr-gap-fixer" && fixReportPath ? { artifactPath: fixReportPath } : {}),
                ...(o.childError ? { error: o.childError } : {}),
                ...(agent === "fr-test-auditor" ? { structuredOutput: pick(o.verdicts, audits++) ?? { verdict: "complete", gaps: [] } } : {}),
              },
            ],
          });
        }, 3);
      },
    },
    appendEntry: () => {},
    sendMessage: () => {},
  };
  return { pi, ctx: { cwd: r, hasUI: false, ui: {} } as any, spawned };
}

const gap = (id: string) => ({ id, kind: "branch", what: `${id} untested`, why_missing: "no case", suggested_row: "add it" });
const run = (h: { pi: unknown; ctx: unknown }, opts: Record<string, unknown> = {}) =>
  runBatch(h.pi as never, h.ctx as never, { background: true, ...opts } as never, () => {});

// ---------------------------------------------------------------------------
console.log("\n--- L: the lock knows who holds it, by liveness not by age");
{
  const r = repo();
  const lp = runlockPath(r);

  writeFileSync(lp, `pid ${DEAD_PID} since now\n`, "utf8");
  const got = acquireRunlock(r);
  ok("L1 a lock naming a dead pid is reclaimed however fresh", "release" in got, JSON.stringify(got));
  if ("release" in got) got.release();

  writeFileSync(lp, `pid ${LIVE_PID} since now\n`, "utf8");
  const held = acquireRunlock(r);
  ok("L2 a lock naming a live pid that is still being touched is respected", "held" in held, JSON.stringify(held));
  ok("...and the refusal says which pid and that it is running", "held" in held && /RUNNING/.test(held.held), "held" in held ? held.held : "");

  // ...but a live pid ALONE does not hold it. Pids are recycled, so an unrelated process inheriting the
  // number would make the refusal permanent — worse than the fifteen-minute wait this replaced. A real
  // holder re-touches the lock every RUNLOCK_TOUCH_MS, so a stale mtime means that pid is not ours.
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const stamp = `${old.getFullYear()}${String(old.getMonth() + 1).padStart(2, "0")}${String(old.getDate()).padStart(2, "0")}${String(old.getHours()).padStart(2, "0")}${String(old.getMinutes()).padStart(2, "0")}`;
  execFileSync("touch", ["-t", stamp, lp]);
  const recycled = acquireRunlock(r);
  ok("...while the same live pid with a STALE lock is reclaimed as a recycled pid", "release" in recycled, JSON.stringify(recycled));
  // touchRunlock must ALWAYS move mtime, because a live holder that stops touching now loses its lock
  // to the recycled-pid rule and ends up sharing the tree. utimesSync can fail where a write succeeds
  // on some network and container filesystems, so there is a rewrite fallback; this pins that the
  // observable contract is "mtime is fresh afterwards", by whichever route.
  writeFileSync(lp, `pid ${LIVE_PID} since now\n`, "utf8");
  execFileSync("touch", ["-t", stamp, lp]);
  const before = statSync(lp).mtimeMs;
  touchRunlock(r);
  const after = statSync(lp).mtimeMs;
  ok("L8 touchRunlock always moves mtime forward", after > before && Date.now() - after < 5_000, `${Math.round((Date.now() - after) / 1000)}s old after the touch`);
  ok("...and leaves the holder line untouched", readFileSync(lp, "utf8").includes(`pid ${LIVE_PID}`), readFileSync(lp, "utf8").trim());
  // L8 above goes through utimesSync, so it does not exercise the REWRITE fallback. That path only
  // runs when utimesSync throws — which some network and container filesystems do where a write
  // succeeds — and it matters because a live holder that silently stops touching now loses its lock to
  // the recycled-pid rule. node:fs exports are read-only, so rather than stub the syscall this asserts
  // the fallback exists and is reachable: it is the LAST statement of touchRunlock, guarded by nothing
  // but the catch, and it rewrites the bytes it just read.
  const storeSrc = readFileSync(new URL("../store.ts", import.meta.url), "utf8");
  const fn = storeSrc.slice(storeSrc.indexOf("export function touchRunlock"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  ok("...and falls back to a rewrite when utimesSync throws", /catch \{[\s\S]*?writeFileSync\(p, readFileSync\(p, "utf8"\), "utf8"\)/.test(body), body.split("\n").filter((l) => /writeFileSync|utimesSync|catch/.test(l)).join(" | "));
  ok("...and the happy path returns before it, so the rewrite is not paid twice", /utimesSync\(p, now, now\);\n\s*return;/.test(body));
  if ("release" in recycled) recycled.release();

  writeFileSync(lp, `pid ${process.pid} since now\n`, "utf8");
  const ours = acquireRunlock(r);
  ok("L3 our OWN pid is reclaimed — the extension reloaded inside this process", "release" in ours, JSON.stringify(ours));
  if ("release" in ours) ours.release();

  writeFileSync(lp, "garbage with no pid\n", "utf8");
  const h = lockHolder(r);
  ok("L4 a lock with no parseable pid falls back to age", h?.pid === null && h?.alive === true, JSON.stringify(h));
  ok("...and describeLock says the judgement is an age one", h ? /judged by age/.test(describeLock(h)) : false, h ? describeLock(h) : "");
  rmSync(lp, { force: true });
}
{
  // L5: a superseded driver must not report. A reload leaves the old loop's timers alive, and its
  // message would arrive carrying budgets from a queue since edited.
  const r = repo();
  const sent: string[] = [];
  const pi: any = { appendEntry: () => {}, sendMessage: (m: any) => sent.push(String(m?.content ?? "")), events: { on: () => () => {}, emit: () => {} } };
  const ctx: any = { cwd: r, hasUI: false, ui: {} };
  generations.set(r, 7);
  const stale: any = { generation: 6, startedAt: Date.now(), detached: true, lines: [], abort: new AbortController(), stopRequested: false, hardStopped: false, settled: Promise.resolve(), touch: undefined };
  const current: any = { ...stale, generation: 7 };
  finishDriver(pi, ctx, r, stale, "fr-batch: finished. stale numbers", false);
  ok("L5 a superseded driver reports nothing", sent.length === 0, `${sent.length} message(s)`);
  finishDriver(pi, ctx, r, current, "fr-batch: finished. current", false);
  ok("...and the current one still does", sent.length === 1, `${sent.length} message(s)`);
  // A RETIRED driver is silent even when its generation still matches. The generation counter cannot
  // cover a reload: that hands the extension a fresh module with a fresh counter while the old loop
  // keeps running against the old one, so the old driver's generation still matches and it would
  // report as if it were current. Two failure sources, two mechanisms.
  const retired: any = { ...current, retired: true };
  finishDriver(pi, ctx, r, retired, "fr-batch: finished. from a reloaded module", false);
  ok("L6 a RETIRED driver is silent even at the current generation", sent.length === 1, `${sent.length} message(s)`);
  drivers.delete(r);
  generations.delete(r);
}

// ---------------------------------------------------------------------------
console.log("\n--- A: one abandonment path for every way supervision ends");
{
  // A hard stop is the one abandonment reachable in a probe: a real wallclock needs rpc.ts's
  // hardcoded +60s grace to elapse, which no guard suite should pay for. What matters is that all
  // three causes go through ONE path — so this exercises that path once, and A2 unit-tests the
  // classifier that routes the other two into it.
  const r = repo();
  const ac = new AbortController();
  // Aborted AFTER the first child is in flight, not before: aborting up front lands on the
  // item-boundary stop, which never enters a phase and so never abandons anything.
  const h = fake(r, { onSpawn: () => ac.abort() });
  const out = await run(h, { signal: ac.signal });
  const p = loadProgress(r).thing;
  // AND, not OR. Measured: both halves hold, so the disjunction only meant either one could rot
  // unnoticed — and "never blocked" is the claim, which needs the status, while the label is what
  // `status` later parses back out of the note.
  ok("A1 an abandoned child is recorded as paused, never blocked", p?.status === "paused" && /HARD STOPPED/.test(out), `${p?.status} · ${out.split("\n")[0]}`);
  ok("...and the message says it was ABANDONED, not killed", /ABANDONED, not killed/.test(out), out.split("\n").find((l) => /ABANDON/.test(l)) ?? out.split("\n")[0]);
  ok("...and warns its orphaned build or test run will fight yours", /orphaned build|fight yours/.test(out));
  ok("A5 ...and says a plain run re-enters the recorded phase", /re-enters/.test(out));

  // A3: the promise in that sentence, checked as BEHAVIOUR. A5 only asserts the prose, and prose is
  // exactly what was true while the re-entry silently skipped the phase it claimed to resume.
  const phase = p?.pausedPhase;
  ok("A3 the abandonment records which phase to re-enter", phase !== undefined, String(phase));
  const h2 = fake(r);
  const again = await run(h2);
  ok("...and a PLAIN run re-enters it — no operator instruction needed", !/STICKY|STOPPED —/.test(again), again.split("\n")[0]);
  ok(
    "...running the phase that was abandoned, not restarting the item",
    // The abort fires on the FIRST spawn, so the abandoned phase is always `implement` here — asserted
    // rather than branched on. The old form was `phase === "implement" ? … : length === 0 || [0] !==
    // "fr-implementer"`, whose else-branch was both unreachable AND vacuous: the second disjunct is
    // true whenever nothing was spawned, so it would have passed on a re-entry that ran nothing at all.
    phase === "implement" && h2.spawned[0] === "fr-implementer",
    `abandoned at ${phase}, then spawned: ${h2.spawned.join(", ") || "nothing"}`,
  );
}
{
  ok("A2 a WALLCLOCK message carries the run id so it can be interrupted", runIdOfWallclock("WALLCLOCK: child exceeded 5ms [run run-7]") === "run-7", String(runIdOfWallclock("WALLCLOCK: child exceeded 5ms [run run-7]")));
  ok("...and yields undefined when there is none", runIdOfWallclock("WALLCLOCK: child exceeded 5ms") === undefined);
  // The branch a real timeout would take, asserted directly: rpc.ts adds a hardcoded 60s grace to
  // every budget, so driving one would cost this suite a minute to observe one `if`.
  const wall = classifyLaunchFailure(new Error("WALLCLOCK: child exceeded 5ms [run run-9]"), false);
  ok("A4 a wallclock expiry classifies as a TIMEOUT, so it is abandoned not blocked", wall.kind === "timeout" && wall.runId === "run-9", JSON.stringify(wall));
  ok("...an operator abort classifies as stopped, whatever the error says", classifyLaunchFailure(new Error("WALLCLOCK: x"), true).kind === "stopped");
  ok("...and anything else is a real launch failure", classifyLaunchFailure(new Error("Unknown agent: fr-implementer"), false).kind === "failure");
}

// ---------------------------------------------------------------------------
console.log("\n--- B: a block says what it invalidated");
{
  // An install failure is `attempt`-scoped: the attempt never happened, so nothing was invalidated.
  const r = repo();
  const h = fake(r, { childStatus: "failed", childError: "Unknown agent: fr-implementer" });
  const out = await run(h);
  const p = loadProgress(r).thing;
  ok("B1 a child that could not run blocks with scope attempt", p?.status === "blocked" && p?.blockScope === "attempt", `${p?.status}/${p?.blockScope}`);
  ok("...and the message names the install problem", /Unknown agent/.test(out));
  // Scope alone is not enough: re-entry needs the PHASE. All four outcome-failure sites passed the
  // scope and omitted the phase, so a failed implementer was re-entered at verify — over a tree it
  // may have half-written. Scope says whether to re-enter; phase says where.
  ok("...and records the phase, so re-entry does not skip implement", p?.pausedPhase === "implement", String(p?.pausedPhase));
  const h2 = fake(r);
  const again = await run(h2);
  ok("...and a PLAIN run re-enters it, with no operator instruction", !again.includes("STICKY"), again.split("\n")[0]);
  // Proven by the SPAWN, not by a log line: the re-entry must actually run an implementer. Asserting on
  // prose let a run that skipped implement and went straight to a green verify gate pass as a re-entry.
  ok(
    "...and actually spawns an implementer rather than going straight to the gate",
    h2.spawned.includes("fr-implementer"),
    h2.spawned.join(", ") || "nothing was spawned",
  );
}
{
  // An in-contract gap at budget is `verdict`-scoped: the gate ruled, and only a human can say
  // whether their fix left the frozen contract standing.
  const r = repo({ budgets: { maxFixRounds: 0 } });
  const h = fake(r, { verdicts: [{ verdict: "gaps_found", gaps: [gap("T1")] }] });
  await run(h);
  const p = loadProgress(r).thing;
  ok("B2 a gate verdict blocks with scope verdict", p?.status === "blocked" && p?.blockScope === "verdict", `${p?.status}/${p?.blockScope}`);
  const bare = await run(fake(r, { verdicts: [{ verdict: "gaps_found", gaps: [gap("T1")] }] }));
  ok("...and a plain run still refuses it", bare.includes("STICKY"), bare.split("\n")[0]);
  ok("...naming the work-preserving exit before reset", bare.indexOf('action "continue"') < bare.indexOf('action "reset"'));
  ok("B3 ...and warning that reset leaves the tree dirty", /does NOT clean the tree/.test(bare));
}

// ---------------------------------------------------------------------------
console.log("\n--- R: the budget counts barren rounds, not rounds");
{
  // Six rounds, every one closing everything it was handed while the auditor reaches deeper. Under a
  // round counter with maxFixRounds 2 this blocks; under a barren counter it commits.
  const r = repo({ budgets: { maxFixRounds: 1 } });
  const h = fake(r, {
    verdicts: [
      { verdict: "gaps_found", gaps: [gap("T1")] },
      { verdict: "gaps_found", gaps: [gap("T2")] },
      { verdict: "gaps_found", gaps: [gap("T3")] },
      { verdict: "gaps_found", gaps: [gap("T4")] },
      { verdict: "complete", gaps: [] },
    ],
  });
  const out = await run(h);
  const p = loadProgress(r).thing;
  ok("R1 a productive item is not blocked by the round count", p?.status === "committed", `${p?.status} · ${out.split("\n")[0]}`);
  ok("...having spent more rounds than a round counter would have allowed", (p?.fixRounds ?? 0) > 1, String(p?.fixRounds));
}
{
  // The same gap every round: nothing closed, nothing rejected. The re-raise guard fires first, which
  // is the sharper signal — so barrenness is exercised with DISTINCT ids that never close.
  const r = repo({ budgets: { maxFixRounds: 2, maxTotalRounds: 20 } });
  const h = fake(r, {
    verdicts: [
      { verdict: "gaps_found", gaps: [gap("T1"), gap("T2")] },
      { verdict: "gaps_found", gaps: [gap("T1"), gap("T2"), gap("T3")] },
    ],
  });
  const out = await run(h);
  ok("R2 an item that closes nothing is stopped", loadProgress(r).thing?.status === "blocked", String(loadProgress(r).thing?.status));
  ok("...and the reason names either barrenness or re-litigation", /stuck|already adjudicated/.test(out), out.split("\n").find((l) => /stuck|adjudicated/.test(l)) ?? out.split("\n")[0]);
}
{
  // A rejection is work: it settles a gap durably, so a round that only rejected is not barren.
  const r = repo({ budgets: { maxFixRounds: 1, maxTotalRounds: 20 } });
  const h = fake(r, {
    verdicts: [{ verdict: "gaps_found", gaps: [gap("T1")] }, { verdict: "complete", gaps: [] }],
    fixReports: [{ closed: [], rejected: [{ id: "T1", why: "already covered by test_x" }] }],
  });
  const out = await run(h);
  ok("R3 an item whose fixer only rejected still commits", loadProgress(r).thing?.status === "committed", `${loadProgress(r).thing?.status} · ${out.split("\n")[0]}`);
  // The rejection has to have REACHED the ledger, or the row above passes for the wrong reason:
  // without it there is nothing for `lastRejections` to count.
  const ledger = readFileSync(join(r, ".pi/fr-batch/thing.gaps.json"), "utf8");
  ok("...and the fixer's rejection actually reached the ledger", /"rejected"/.test(ledger), ledger.replace(/\s+/g, " ").slice(0, 150));
  // The RULE, asserted directly. Driving the loop into the one state where the two terms differ needs
  // every previously-open gap to have been rejected AND the barren threshold reached before the audit
  // completes — a window narrow enough that an end-to-end row passes for other reasons.
  ok("...and a round that closed nothing but rejected something is PRODUCTIVE", roundWasProductive(0, 1));
  ok("...while a round that did neither is barren", !roundWasProductive(0, 0));
  ok("...and closures alone are productive too", roundWasProductive(2, 0));
}
{
  // An `attempt` block is re-entered WHERE IT STOPPED. `pausedPhase` used to be retained only while
  // `status === "paused"`, so a block always dropped it and every re-entry landed at verify — a failed
  // IMPLEMENTER would be re-entered by skipping implement, verifying a tree nobody had written.
  const r = repo({});
  setProgress(r, "thing", { status: "blocked", note: "the implementer failed to run", blockScope: "attempt", pausedPhase: "implement" });
  const p = loadProgress(r).thing;
  ok("B4 a block records the phase it stopped in", p?.pausedPhase === "implement", String(p?.pausedPhase));
  ok("...alongside its scope", p?.blockScope === "attempt", String(p?.blockScope));
  // The child id is NOT retained: it names a process, and a stale one must never be revived.
  setProgress(r, "thing", { status: "blocked", pausedChildId: "run-dead" });
  ok("...but never a stale child id", loadProgress(r).thing?.pausedChildId === undefined, String(loadProgress(r).thing?.pausedChildId));
  // And the phase has to be VISIBLE, or recording it on five of the six verdict sites buys nothing:
  // there it changes no routing (re-entry re-runs the verify gate, and must — an item whose gate is not
  // green cannot be audited), so provenance is its entire value and `status` hid it for blocked items.
  setProgress(r, "thing", { status: "blocked", note: "audit reached the total round cap", blockScope: "verdict", pausedPhase: "fix-audit" });
  const blockedStatus = renderStatus(r);
  ok("B8 status shows a BLOCKED item where it stopped", /at:fix-audit/.test(blockedStatus), blockedStatus.split("\n").find((l) => /thing/.test(l)) ?? "no row");
}
{
  // Status has to NAME the budget it enforces. It described the strict-shrink guard for two commits
  // after that guard was deleted, and never mentioned the cost cap at all — an operator reading it
  // would tune the wrong knob, or conclude the tool was lying to them.
  const r = repo({ budgets: { maxFixRounds: 3, maxTotalRounds: 9 } });
  setProgress(r, "thing", { status: "verifying", fixRounds: 5, barrenRounds: 2 });
  const st = renderStatus(r);
  ok("R6 status names the barren budget and the cost cap", /maxFixRounds 3 \(consecutive BARREN rounds\)/.test(st) && /maxTotalRounds 9/.test(st), st.split("\n").find((l) => /budgets:/.test(l)) ?? "no budgets line");
  ok("...and shows an item's barren count next to its rounds", /fixes:5 barren:2/.test(st), st.split("\n").find((l) => /fixes:/.test(l)) ?? "no fixes line");
  ok("...and no longer describes the deleted strict-shrink guard", !/must shrink each round/.test(st));
}
{
  // `status` must tell a hard stop from a wallclock expiry. One pauseKind covers both — what matters
  // downstream is that a child was ABANDONED, not which reason — so the cause is read back out of the
  // note the driver wrote. Reporting both as "paused by a hard stop" told an operator their own
  // keystroke did what a budget did, and sent them looking for the wrong thing.
  const r = repo({});
  setProgress(r, "thing", { status: "paused", fixRounds: 0, pauseKind: "stopped", pausedPhase: "audit", note: "TIMED OUT during audit: the auditor outlived its budget." });
  const st = renderStatus(r);
  ok("V3 status reports a timeout as a timeout", /OUTLIVED queue.childTimeoutMs/.test(st), st.split("\n").find((l) => /⏸/.test(l)) ?? "no paused line");
  ok("...and does NOT call it a hard stop", !/paused by a hard stop/.test(st));
  setProgress(r, "thing", { status: "paused", fixRounds: 0, pauseKind: "stopped", pausedPhase: "audit", note: "HARD STOPPED during audit: the operator asked for a hard stop." });
  ok("...while a real hard stop still reads as one", /paused by a hard stop/.test(renderStatus(r)) && !/OUTLIVED/.test(renderStatus(r)));
}
{
  // `status` tells a timeout from a keystroke by parsing the NOTE, which is safe only because exactly
  // ONE site writes pauseKind "stopped" and it always prefixes the note with a label. That is an
  // implicit dependency between two files, so it is pinned: a new `pauseKind: "stopped"` writer, or an
  // abandonment that stops labelling its note, silently makes every timeout read as a hard stop.
  const src = readFileSync(new URL("../driver.ts", import.meta.url), "utf8");
  // EVERY source file, not just driver.ts: the invariant is "one writer in the extension", and a new
  // writer in bug_pipeline.ts or index.ts would escape a driver-only grep while breaking status just
  // as completely.
  const allSrc = readdirSync(new URL("..", import.meta.url))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => [f, readFileSync(new URL(`../${f}`, import.meta.url), "utf8")] as [string, string]);
  const writers = allSrc.flatMap(([f, t]) => t.split("\n").map((l, n) => [f, n + 1, l] as [string, number, string]).filter(([, , l]) => /pauseKind: "stopped"/.test(l)));
  ok("V5 exactly one site in the whole extension writes pauseKind \"stopped\"", writers.length === 1, writers.map(([f, n]) => `${f}:${n}`).join(", ") || "none — status has nothing to classify");
  // These two used to pin the SHAPE of the label expression and the note template, which a rename or a
  // reflow breaks with behaviour intact — and they were the only guard of the driver -> status note
  // contract. Replaced by the contract itself, driven end to end: an abandonment's note must begin with
  // a word `status` can classify, because that prefix is the only thing carrying the cause across.
  const ac2 = new AbortController();
  const r2 = repo();
  await run(fake(r2, { onSpawn: () => ac2.abort() }), { signal: ac2.signal });
  const note = loadProgress(r2).thing?.note ?? "";
  ok("...and a real abandonment's note BEGINS with a label status can classify", /^(HARD STOPPED|TIMED OUT) during /.test(note), note.split("\n")[0] || "(empty note)");
  ok("...which status then reads back as the right kind of pause", /paused by a hard stop/.test(renderStatus(r2)) && !/OUTLIVED/.test(renderStatus(r2)));
}
{
  // The four outcome-failure blocks name their phase as a LITERAL, and a wrong literal silently
  // re-enters the wrong phase — the failure mode is invisible because everything still runs. Checked
  // structurally rather than by driving four paths: each literal must match the agent spawned above it.
  const src = readFileSync(new URL("../driver.ts", import.meta.url), "utf8");
  const lines = src.split("\n");
  const expect: Record<string, [string, string]> = {
    implFailure: ["implement", "fr-implementer"],
    fixVerifyFailure: ["fix-verify", "fr-gap-fixer"],
    auditFailure: ["audit", "fr-test-auditor"],
    fixAuditFailure: ["fix-audit", "fr-gap-fixer"],
  };
  for (const [v, [phase, agent]] of Object.entries(expect)) {
    const i2 = lines.findIndex((l) => l.includes(`if (${v}) return block(${v}, "attempt"`));
    const named = i2 >= 0 && lines[i2].includes(`"attempt", "${phase}"`);
    ok(`B5 ${v} blocks with phase "${phase}"`, named, i2 >= 0 ? lines[i2].trim() : "call site not found");
    void agent;
    // The nearest spawn above the block must be the child that phase runs. A literal one phase behind
    // is the whole failure mode, and it is invisible at runtime because everything still executes.
    const above = lines.slice(0, i2).filter((l) => /agent: "fr-[a-z-]+"/.test(l));
    const nearest = (above[above.length - 1]?.match(/agent: "(fr-[a-z-]+)"/) ?? [])[1];
    ok(`...directly below a ${agent}`, nearest === agent, `nearest spawn above it is ${nearest}`);
  }
}
{
  // EVERY block reached from inside a phase must name that phase, not just the four outcome-failure
  // sites. Scope decides whether a bare `run` may re-enter; PHASE decides where the operator's
  // `continue only:<id>` lands. Six verdict blocks omitted it and silently resumed at the verify gate
  // — including "implementer changed no files", where re-entering at verify is certainly wrong because
  // the tree is provably untouched. A per-site row would have missed them; this counts them.
  const src = readFileSync(new URL("../driver.ts", import.meta.url), "utf8");
  const lines = src.split("\n");
  // The two legitimate exceptions, by line content rather than number:
  //   the pre-flight test-matrix gate — the item has not started, so there is no phase to resume;
  //   `childLaunchFailure` — it forwards the phase it was handed, as a variable.
  const exempt = [/if \(!gate\.ok\) return block\(gate\.why\)/, /failed to run: \$\{e\.message\}`, "attempt", phase\)/, /git (add|commit) failed/];
  const missing: string[] = [];
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/\breturn block\(/.test(lines[i])) continue;
    // Scanned to where the call actually CLOSES, by paren depth. A fixed window silently exempted the
    // two longest blocks — the ones whose message is a multi-line array — which is the same class of
    // false green this row exists to prevent.
    let depth = 0;
    let call = "";
    for (let j = i; j < lines.length; j++) {
      call += lines[j] + "\n";
      for (const ch of lines[j]) {
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
      }
      if (depth <= 0) break;
    }
    seen += 1;
    if (exempt.some((re) => re.test(call))) continue;
    if (!/"(verdict|attempt)",[\s\S]*?"(implement|audit|fix-verify|fix-audit|bugfix|scope)"/.test(call)) {
      missing.push(`driver.ts:${i + 1} ${lines[i].trim().slice(0, 60)}`);
    }
  }
  // A population count, because the scan itself could break: a regex that stops matching, or a rename,
  // would leave `missing` empty and the row would pass having examined nothing. That is the shape of
  // false green this whole row exists to prevent, so it must not be the row's own failure mode.
  ok("B6 the scan actually found the block call sites", seen >= 12, `${seen} \u00b7 there are 14 in driver.ts, three of them exempt`);
  ok("...and every block inside a phase records that phase", missing.length === 0, missing.join(" | ") || "all recorded");

  // Same off-by-one class, the other family of call sites. B5 checks the four `block` literals; these
  // are the `handlePause` literals, and a phase one behind here resumes a network pause at the wrong
  // child. Both families are literals a refactor can move without the compiler noticing, because every
  // member of the union typechecks everywhere.
  const phaseOf: Record<string, string> = { "fr-implementer": "implement", "fr-test-auditor": "audit" };
  const wrong: string[] = [];
  let found = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /handlePause\("([a-z-]+)"/.exec(lines[i]);
    if (!m) continue;
    found += 1;
    const spawns = lines.slice(0, i).filter((l) => /agent: "fr-[a-z-]+"/.test(l));
    const agent = (spawns[spawns.length - 1]?.match(/agent: "(fr-[a-z-]+)"/) ?? [])[1] ?? "?";
    // The gap-fixer runs both fix phases, so it constrains the literal to that pair rather than to one.
    const okPhase = agent === "fr-gap-fixer" ? m[1] === "fix-verify" || m[1] === "fix-audit" : phaseOf[agent] === m[1];
    if (!okPhase) wrong.push(`driver.ts:${i + 1} handlePause("${m[1]}") under ${agent}`);
  }
  // Same reason as B6: "all four agree" was asserted without ever checking there were four.
  ok("B7 the scan found every handlePause literal", found === 4, `${found} \u00b7 expected the four phase literals`);
  ok("...and each names the phase its own child is running", wrong.length === 0, wrong.join(" | ") || "all four agree with the child above them");
}
{
  // A verify dispute must be DISTINGUISHABLE in status. Everything else in out-of-scope.md is coverage
  // the auditor wanted and the contract does not ask for — real follow-up, correctly ignored. A verify
  // finding is the auditor disputing the OPERATOR'S OWN gate, which nothing else reviews. Tagged the
  // same as a wish-list item, nobody opens the file on a committed item and the review has no reader.
  const r = repo({});
  const dir = join(r, ".pi/fr-batch");
  mkdirSync(dir, { recursive: true });
  setProgress(r, "thing", { status: "verifying", fixRounds: 1 });
  writeFileSync(join(dir, "thing.out-of-scope.md"), "# findings\n\n- a row the contract does not ask for\n", "utf8");
  ok("V4 an ordinary out-of-scope file is tagged, and not escalated", /out-of-scope:yes/.test(renderStatus(r)) && !/VERIFY-DISPUTED/.test(renderStatus(r)));
  writeFileSync(join(dir, "thing.out-of-scope.md"), "# findings\n\n### The project's verify gate disagrees with the PLAN's acceptance text\n\n- the gate asserts 1\n", "utf8");
  const st = renderStatus(r);
  ok("...while a dispute about the operator's own gate is called out", /VERIFY-DISPUTED/.test(st), st.split("\n").find((l) => /out-of-scope/.test(l)) ?? "no row");
  // The chip is driven by the EXPORTED heading, so writer and reader cannot drift. It used to be the
  // same sentence typed into two files, and the mutation guarding the pair only edited the reader —
  // so a change to the writer would have gone unnoticed by construction.
  ok("...keyed on the exported heading, not a substring typed twice", VERIFY_DISPUTE_HEADING.length > 0 && readFileSync(join(dir, "thing.out-of-scope.md"), "utf8").includes(VERIFY_DISPUTE_HEADING));
  const hardcoded = readdirSync(new URL("..", import.meta.url))
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8").split("\n").map((l, n) => [f, n + 1, l] as [string, number, string]))
    .filter(([f, , l]) => l.includes("verify gate disagrees") && f !== "contract.ts");
  ok("...and no file re-types that sentence", hardcoded.length === 0, hardcoded.map(([f, n]) => `${f}:${n}`).join(", "));
}
{
  // The barren counter is PERSISTED, like fixRounds. A counter living only in the loop reset on every
  // re-entry, so looping `continue` on a stuck item would hand it unlimited barren rounds — and
  // re-entry is exactly what the blocked-item escape hatch makes cheap.
  const r = repo({ budgets: { maxFixRounds: 2, maxTotalRounds: 20 } });
  setProgress(r, "thing", { status: "pending", fixRounds: 0, barrenRounds: 1 });
  ok("R5 barrenRounds survives a progress write", loadProgress(r).thing?.barrenRounds === 1, String(loadProgress(r).thing?.barrenRounds));
  setProgress(r, "thing", { status: "verifying" });
  ok("...and a patch that does not name it keeps it", loadProgress(r).thing?.barrenRounds === 1, String(loadProgress(r).thing?.barrenRounds));
}
{
  // Alternating one discovery per round never goes barren, so the total cap is what stops it.
  const r = repo({ budgets: { maxFixRounds: 4, maxTotalRounds: 3 } });
  const h = fake(r, {
    verdicts: [
      { verdict: "gaps_found", gaps: [gap("T1")] },
      { verdict: "gaps_found", gaps: [gap("T2")] },
      { verdict: "gaps_found", gaps: [gap("T3")] },
      { verdict: "gaps_found", gaps: [gap("T4")] },
      { verdict: "gaps_found", gaps: [gap("T5")] },
    ],
  });
  const out = await run(h);
  ok("R4 the total cap stops an endlessly productive loop", loadProgress(r).thing?.status === "blocked", String(loadProgress(r).thing?.status));
  ok("...calling it a cost stop rather than a verdict", /total round cap/.test(out) && /COST stop|cost stop/.test(out), out.split("\n").find((l) => /cap|cost/i.test(l)) ?? out.split("\n")[0]);
}

// ---------------------------------------------------------------------------
console.log("\n--- V: the verify gate gets a reviewer");
{
  ok("V2 the PLAN's acceptance section is extractable", /make check/.test(extractAcceptanceSection(PLAN)), extractAcceptanceSection(PLAN).split("\n")[0]);
  ok("...and a PLAN without one yields empty", extractAcceptanceSection("# x\n\n## Tests\n\n| a |\n|---|\n| b |\n") === "");
}
{
  const r = repo();
  const h = fake(r, {
    verdicts: [
      {
        verdict: "complete",
        gaps: [],
        verify_findings: [{ command: "test $(count ZONE-003) -eq 1", what: "asserts 1 ZONE-003 while the PLAN says there must be none (there was exactly 1 before)" }],
      },
    ],
  });
  const out = await run(h);
  ok("V1 a verify disagreement does not block the item", loadProgress(r).thing?.status === "committed", `${loadProgress(r).thing?.status} · ${out.split("\n")[0]}`);
  const oos = join(r, ".pi/fr-batch/thing.out-of-scope.md");
  ok("...and is recorded on disk", existsSync(oos) && /ZONE-003/.test(readFileSync(oos, "utf8")));
  ok("...under a heading that says it is non-blocking", existsSync(oos) && /Non-blocking/.test(readFileSync(oos, "utf8")));
}

console.log(fails === 0 ? "\nprobe_lifecycle: all pass" : `\nprobe_lifecycle: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
