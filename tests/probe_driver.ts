// Guard probes for the BACKGROUND DRIVER: `run` must not hold the turn, the queue must stay
// editable while it runs, `stop` must be graceful first and honest second, and a fast refusal
// must still come back inline instead of arriving later as a notification.
//
// Everything here is driven through a fake pi-subagents RPC bus, so no real child is spawned.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, utimesSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDriver, stopDriver } from "../background.ts";
import { drivers, finishedRuns } from "../state.ts";
import { renderStatus } from "../render.ts";
import { addItem } from "../queue_ops.ts";
import { touchRunlock } from "../store.ts";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = "subagents:rpc:v1:reply:";
const ASYNC_COMPLETE = "subagent:async-complete";

let fails = 0;
const ok = (n: string, c: boolean, extra = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? ` — ${extra}` : ""}`);
  if (!c) fails++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PLAN = "# FR x\n\n## 5. Tests — the branch matrix\n\n| id | what | proves non-vacuous |\n|---|---|---|\n| T1 | a | edit a |\n";

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "fr-batch-driver-"));
  const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: repo, encoding: "utf8" });
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(join(repo, ".pi/fr-batch"), { recursive: true });
  writeFileSync(join(repo, "docs/FR_x_PLAN.md"), PLAN);
  writeFileSync(join(repo, ".gitignore"), "/.pi/\n/.pi-subagents/\n"); // both trees are the driver's own; runBatch refuses if either is committable
  sh("git", ["init", "-q"]);
  sh("git", ["config", "user.email", "t@t"]);
  sh("git", ["config", "user.name", "t"]);
  sh("git", ["add", "-A"]);
  sh("git", ["commit", "-qm", "init"]);
  return repo;
}

function writeQueue(repo: string, extra: Record<string, unknown> = {}, items: unknown[] = [{ id: "x", plan: "docs/FR_x_PLAN.md" }]) {
  writeFileSync(
    join(repo, ".pi/fr-batch/queue.json"),
    JSON.stringify(
      {
        armed: true,
        maxFixRounds: 3,
        childTimeoutMs: 60_000,
        verifyTimeoutMs: 5_000,
        defaultVerify: ["true"],
        transient: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, probeUrl: "" },
        items,
        ...extra,
      },
      null,
      2,
    ),
  );
}

/**
 * A fake RPC bus. `childDelayMs: null` means the child never completes — the shape a hard
 * stop has to survive.
 */
function makeFake(repo: string, opts: { childDelayMs: number | null; beforeComplete?: () => void }) {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const calls: Array<{ method: string; params: unknown }> = [];
  const messages: Array<{ content: string; opts: unknown }> = [];
  let n = 0;
  const fire = (name: string, payload: unknown) => {
    for (const h of [...(handlers.get(name) ?? [])]) h(payload);
  };
  const pi: any = {
    exec: async (cmd: string, args: string[], o: any) => {
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
        const req = payload as { requestId: string; method: string; params: unknown };
        calls.push({ method: req.method, params: req.params });
        const asyncId = `run-${++n}`;
        fire(`${RPC_REPLY}${req.requestId}`, { version: 1, requestId: req.requestId, success: true, data: { text: "launched", details: { asyncId } } });
        if (opts.childDelayMs === null) return;
        setTimeout(() => {
          opts.beforeComplete?.();
          fire(ASYNC_COMPLETE, { runId: asyncId, state: "completed", results: [{ status: "complete", summary: "did the work" }] });
        }, opts.childDelayMs);
      },
    },
    appendEntry: () => {},
    sendMessage: (m: any, o: any) => void messages.push({ content: String(m?.content ?? ""), opts: o }),
  };
  const ctx: any = { cwd: repo, hasUI: false, ui: {} };
  return { pi, ctx, calls, messages };
}

// ---------------------------------------------------------------------------
// 1. run returns while the batch keeps going, and the queue stays editable
// ---------------------------------------------------------------------------
{
  const repo = makeRepo();
  writeQueue(repo);
  // The child "does work" by touching a file, so the implement post-check sees a dirty tree.
  const f = makeFake(repo, { childDelayMs: 3_000, beforeComplete: () => writeFileSync(join(repo, "impl.txt"), "work\n") });

  const t0 = Date.now();
  const started = await startDriver(f.pi, f.ctx, {});
  const tookMs = Date.now() - t0;

  ok("run returns while the batch is still going", /running in the background/.test(started), started.split("\n")[0]);
  ok("...and it returns in seconds, not in child time", tookMs < 6_000, `${tookMs}ms`);
  ok("...and the driver is live afterwards", drivers.has(repo));
  ok("...and it tells the agent not to poll", /do not poll it in a loop/.test(started));
  ok("...and nothing was notified yet (the tool result carries no result)", f.messages.length === 0);

  const status = renderStatus(repo);
  ok("status reports the live driver", /driver: running for /.test(status), status.split("\n")[1]);

  const added = addItem(repo, { plan: "docs/FR_x_PLAN.md", id: "y" });
  ok("add works mid-run", /queued "y"/.test(added), added.split("\n")[0]);
  ok("...and says the running driver will pick it up", /in flight/.test(added));

  const first = stopDriver(f.pi, repo);
  ok("first stop is graceful", /stop requested/.test(first), first.split("\n")[0]);
  ok("...and says the running child is left to finish", /left to finish/.test(first));
  ok("...and the driver is still live (the child was NOT aborted)", drivers.has(repo));
  ok("...and status shows it is stopping", /stopping at the next phase boundary/.test(renderStatus(repo)));

  for (let i = 0; i < 100 && drivers.has(repo); i++) await sleep(200);
  const done = finishedRuns.get(repo);
  ok("the graceful stop lands at the next phase boundary", Boolean(done) && /stopped on request/.test(done!.text), done?.text.split("\n")[0] ?? "never settled");
  ok("...after the child had actually run", existsSync(join(repo, "impl.txt")));
  ok("...and it says progress is safe without a reset", /progress is saved/.test(done?.text ?? ""));
  ok("...and exactly one result was reported back to the conversation", f.messages.length === 1, `${f.messages.length}`);
  ok("...as a followUp that wakes an idle turn", (f.messages[0]?.opts as any)?.deliverAs === "followUp" && (f.messages[0]?.opts as any)?.triggerTurn === true);
  ok("...carrying the verbatim result plus relay instructions", /stopped on request/.test(f.messages[0]?.content ?? "") && /verbatim/.test(f.messages[0]?.content ?? ""));
  ok("...and progress kept the phase it stopped in", ["implementing", "verifying"].includes(JSON.parse(readFileSync(join(repo, ".pi/fr-batch/progress.json"), "utf8")).x?.status));
}

// ---------------------------------------------------------------------------
// 2. a refusal settles inside the grace window: inline, and NOT notified twice
// ---------------------------------------------------------------------------
{
  const repo = makeRepo();
  writeQueue(repo, { armed: false });
  const f = makeFake(repo, { childDelayMs: 100 });
  const out = await startDriver(f.pi, f.ctx, {});
  ok("a disarmed queue refuses inline", /REFUSED — queue is not armed/.test(out), out.split("\n")[0]);
  ok("...and does not leave a driver behind", !drivers.has(repo));
  ok("...and is not also pushed into the conversation", f.messages.length === 0, `${f.messages.length}`);
  ok("...and no child was ever spawned", f.calls.length === 0);
}

// ---------------------------------------------------------------------------
// 3. a second run while one is live is refused, not started twice
// ---------------------------------------------------------------------------
{
  const repo = makeRepo();
  writeQueue(repo);
  const f = makeFake(repo, { childDelayMs: null });
  await startDriver(f.pi, f.ctx, {});
  const second = await startDriver(f.pi, f.ctx, {});
  ok("a second run is refused while one is live", /a driver is already running/.test(second), second.split("\n")[0]);
  ok("...and only one child was spawned", f.calls.length === 1, `${f.calls.length}`);
  ok("...and it points at status/stop/add instead", /action "stop"/.test(second) && /action "status"/.test(second));
  stopDriver(f.pi, repo);
  stopDriver(f.pi, repo);
  for (let i = 0; i < 50 && drivers.has(repo); i++) await sleep(100);
}

// ---------------------------------------------------------------------------
// 4. second stop hard-stops: resumable pause, and honest about the orphan child
// ---------------------------------------------------------------------------
{
  const repo = makeRepo();
  writeQueue(repo);
  const f = makeFake(repo, { childDelayMs: null }); // a child that never comes back
  await startDriver(f.pi, f.ctx, {});
  ok("driver is live before stopping", drivers.has(repo));

  stopDriver(f.pi, repo);
  const hard = stopDriver(f.pi, repo);
  ok("the second stop stops waiting on the child", /hard stop/.test(hard), hard.split("\n")[0]);
  ok("...and says the child was abandoned, not killed", /ABANDONED, not killed/.test(hard));

  for (let i = 0; i < 100 && drivers.has(repo); i++) await sleep(100);
  const done = finishedRuns.get(repo);
  ok("a hard stop ends the batch promptly", Boolean(done), done?.text.split("\n")[0] ?? "never settled");
  ok("...reported as a hard stop at the phase it was in", /HARD STOPPED at x \(implement\)/.test(done?.text ?? ""), done?.text.split("\n")[0] ?? "");

  const p = JSON.parse(readFileSync(join(repo, ".pi/fr-batch/progress.json"), "utf8")).x;
  ok("...recorded as a resumable pause, not a block", p?.status === "paused", JSON.stringify(p?.status));
  ok("...tagged as a stop rather than an outage", p?.pauseKind === "stopped", JSON.stringify(p?.pauseKind));
  ok("...keeping the phase to re-enter", p?.pausedPhase === "implement");
  ok("...and deliberately keeping NO child id to revive", p?.pausedChildId === undefined, JSON.stringify(p?.pausedChildId));
  ok("status explains the hard-stopped item", /paused by a hard stop/.test(renderStatus(repo)));
}

// ---------------------------------------------------------------------------
// 5. resuming a hard-stopped item spawns a fresh child instead of reviving the orphan
// ---------------------------------------------------------------------------
{
  const repo = makeRepo();
  writeQueue(repo);
  writeFileSync(
    join(repo, ".pi/fr-batch/progress.json"),
    JSON.stringify({ x: { status: "paused", fixRounds: 0, updatedAt: "now", pauseKind: "stopped", pausedPhase: "implement", pausedChildId: "run-orphan" } }, null, 2),
  );
  writeFileSync(join(repo, "left-behind.txt"), "partial work\n"); // a stopped item legitimately has a dirty tree
  const f = makeFake(repo, { childDelayMs: null });
  await startDriver(f.pi, f.ctx, {});
  for (let i = 0; i < 50 && f.calls.length === 0; i++) await sleep(100);
  ok("a stopped pause spawns a fresh child", f.calls[0]?.method === "spawn", JSON.stringify(f.calls[0]?.method));
  stopDriver(f.pi, repo);
  stopDriver(f.pi, repo);
  for (let i = 0; i < 50 && drivers.has(repo); i++) await sleep(100);
}

// ---------------------------------------------------------------------------
// 6. the run lock is kept young, so a long run is never mistaken for a dead one
// ---------------------------------------------------------------------------
{
  const repo = makeRepo();
  const lock = join(repo, ".pi/fr-batch/.run.lock");
  writeFileSync(lock, "pid 1 since then\n");
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(lock, old, old);
  touchRunlock(repo);
  const ageMs = Date.now() - statSync(lock).mtimeMs;
  ok("touchRunlock refreshes the lock's mtime", ageMs < 5_000, `${Math.round(ageMs / 1000)}s old`);
  ok("...and keeps the holder line intact", /pid 1 since then/.test(readFileSync(lock, "utf8")));
  // `true` here used to stand in for "the line above did not throw", which reads as a check and is
  // not one. The observable claim is that touching a path with no lock creates nothing.
  const absent = join(repo, "nope");
  touchRunlock(absent);
  ok("...and touching a missing lock creates nothing", !existsSync(join(absent, ".pi/fr-batch/.run.lock")) && !existsSync(absent));
}

console.log(fails === 0 ? "\nprobe_driver: all pass" : `\nprobe_driver: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
