import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { runBatch } from "./driver.ts";
import { runlockPath } from "./paths.ts";
import { sleep } from "./resilience.ts";
import { LOG_TAIL_LINES, describeLive, drivers, elapsedLabel, finishedRuns, isCurrentGeneration, lastLogLine, nextGeneration } from "./state.ts";
import type { LiveDriver } from "./state.ts";
import { RUNLOCK_TOUCH_MS, touchRunlock } from "./store.ts";
import type { ItemKind, Log } from "./types.ts";

/**
 * How long `run` waits before detaching. A refusal (disarmed queue, dirty tree, held
 * lock) settles in milliseconds and belongs in the tool result; a real batch does not.
 */
export const DETACH_GRACE_MS = 2_000;

/** How a finished run should be reported: which ones need the operator, and how loudly. */
export function classifyResult(text: string): { failed: boolean; level: "info" | "warning" | "error" } {
  if (/^fr-batch: (REFUSED|STOPPED|HARD STOPPED)/.test(text) || /^fr-batch error/.test(text)) return { failed: true, level: "error" };
  if (/^fr-batch: (PAUSED|DECISION NEEDED|WAITING FOR YOUR DECISION|stopped on request)/.test(text)) return { failed: true, level: "warning" };
  return { failed: false, level: "info" };
}

/**
 * Report a finished background run. Silent when the starting tool call is still waiting on
 * the grace race: it returns the same text inline, and reporting twice would have the agent
 * relay the same refusal to the operator twice.
 */
export function finishDriver(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string, d: LiveDriver, text: string, failed: boolean): void {
  if (d.touch) clearInterval(d.touch);
  // A SUPERSEDED driver reports nothing. It may still be holding numbers from a queue that has since
  // been edited, or naming an item the operator has removed — and its message would arrive as if it
  // described the run they are actually watching. It is not silently dropped: the entry is logged, so
  // a late completion is still discoverable, just not announced.
  if (!isCurrentGeneration(cwd, d)) {
    pi.appendEntry("fr-batch", { event: "driver-finished-superseded", generation: d.generation, failed, head: text.split("\n")[0] });
    return;
  }
  drivers.delete(cwd);
  const elapsedMs = Date.now() - d.startedAt;
  finishedRuns.set(cwd, { at: Date.now(), elapsedMs, text, failed });
  pi.appendEntry("fr-batch", { event: "driver-finished", failed, elapsedMs, head: text.split("\n")[0] });
  if (!d.detached) return;

  try {
    if (ctx.hasUI) ctx.ui.notify(`fr-batch: ${text.split("\n")[0]}`, classifyResult(text).level);
  } catch {
    /* a UI that went away is not a driver failure */
  }
  // followUp + triggerTurn is the polite wake: it waits for whatever the operator is doing
  // to finish and only then starts a turn to relay this. sendUserMessage would forge a user
  // message and always trigger a turn, which is exactly the interruption this redesign was
  // meant to remove.
  try {
    pi.sendMessage(
      {
        customType: "fr-batch-result",
        content: [
          `The background fr-batch driver finished after ${elapsedLabel(elapsedMs)}. Relay its result below to the`,
          "user verbatim. If it says DECISION NEEDED, ask the user the child's question and deliver the",
          'answer with fr_batch action "continue", answer: "<decision>". Do not re-run the batch on your own.',
          "",
          text,
        ].join("\n"),
        display: true,
        details: { failed, elapsedMs },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  } catch {
    /* the result is still in `status` and in progress.json */
  }
}

export async function startDriver(pi: ExtensionAPI, ctx: ExtensionContext, opts: { only?: string; answer?: string; kind?: ItemKind; resumeBlocked?: boolean }): Promise<string> {
  const cwd = ctx.cwd;
  const running = drivers.get(cwd);
  if (running) {
    return [
      `fr-batch: a driver is already ${describeLive(running)}`,
      "",
      'Watch it with action "status", end it with action "stop". Appending with action "add" is safe',
      "while it runs — the queue is re-read at every item boundary.",
    ].join("\n");
  }

  const d: LiveDriver = {
    generation: nextGeneration(cwd),
    startedAt: Date.now(),
    abort: new AbortController(),
    stopRequested: false,
    hardStopped: false,
    detached: false,
    only: opts.only,
    kind: opts.kind,
    lines: [],
    settled: Promise.resolve(),
    touch: undefined,
  };
  const log: Log = (line) => {
    d.lines.push(line);
    if (d.lines.length > LOG_TAIL_LINES) d.lines.splice(0, d.lines.length - LOG_TAIL_LINES);
  };
  drivers.set(cwd, d);
  d.touch = setInterval(() => touchRunlock(cwd), RUNLOCK_TOUCH_MS);
  d.touch.unref?.();

  d.settled = runBatch(
    pi,
    ctx,
    { signal: d.abort.signal, only: opts.only, kind: opts.kind, answer: opts.answer, resumeBlocked: opts.resumeBlocked, background: true, shouldStop: () => d.stopRequested },
    log,
  )
    .then(
      (out) => finishDriver(pi, ctx, cwd, d, out, classifyResult(out).failed),
      (e: Error) => finishDriver(pi, ctx, cwd, d, `fr-batch error: ${e.message}`, true),
    )
    // The driver is nobody's awaited promise once it detaches, so a throw from the reporting
    // path itself must not surface as an unhandled rejection that takes the host down.
    .catch(() => void drivers.delete(cwd));

  const settledFirst = await Promise.race([d.settled.then(() => true as const), sleep(DETACH_GRACE_MS).then(() => false as const)]);
  if (settledFirst) {
    return finishedRuns.get(cwd)?.text ?? "fr-batch: the batch ended immediately without a result.";
  }
  d.detached = true;
  // The race and this flag are two steps, and a run that settles BETWEEN them would have been
  // reported by nobody: finishDriver returns early while `detached` is still false (so the
  // starting call can return the text inline), and the starting call was about to claim the batch
  // is still running. Re-check the record after flipping the flag and hand back the real result.
  const already = finishedRuns.get(cwd);
  if (already && !drivers.has(cwd)) return already.text;

  return [
    `fr-batch: running in the background${opts.only ? ` (only: ${opts.only})` : ""} — ${lastLogLine(d)}`,
    "",
    "This conversation stays free while it runs. The driver reports back here on its own when it",
    "finishes, pauses, or needs a decision — do not poll it in a loop.",
    "",
    '  status  progress + what the driver is doing right now',
    '  add     queue another PLAN; picked up at the next item boundary',
    '  stop    end the batch after the current child settles (call twice to hard-stop)',
  ].join("\n");
}

/**
 * Two-step stop, because the driver cannot kill what it launched: pi-subagents' RPC `stop`
 * refuses a running workflow ("not controlled by this extension runtime"), and children are
 * spawned as workflows. So the first stop is graceful — it lets the in-flight child finish
 * and ends the batch at the next phase boundary, which loses nothing. The second stop
 * abandons the child instead, and says so rather than pretending it was killed.
 */
export function stopDriver(pi: ExtensionAPI, cwd: string): string {
  const d = drivers.get(cwd);
  if (!d) {
    const f = finishedRuns.get(cwd);
    return [
      "fr-batch: no driver is running in this session.",
      ...(f ? ["", `The last one ended ${elapsedLabel(Date.now() - f.at)} ago: ${f.text.split("\n")[0]}`] : []),
      ...(existsSync(runlockPath(cwd))
        ? [
            "",
            `A run lock is still present: ${runlockPath(cwd)}`,
            "Another session may own it. Delete it only if that process is gone.",
          ]
        : []),
    ].join("\n");
  }

  if (!d.stopRequested) {
    d.stopRequested = true;
    pi.appendEntry("fr-batch", { event: "stop-requested", elapsedMs: Date.now() - d.startedAt });
    return [
      `fr-batch: stop requested — ${describeLive(d)}`,
      "",
      "The child that is running now is left to finish (it is bounded by queue.childTimeoutMs);",
      "the batch then ends at the next phase boundary with its progress saved, so nothing is",
      'lost and no `reset` is needed. Resume later with action "run".',
      "",
      'Call "stop" again to abandon that child instead of waiting for it.',
    ].join("\n");
  }

  if (!d.hardStopped) {
    d.hardStopped = true;
    d.abort.abort();
    pi.appendEntry("fr-batch", { event: "hard-stopped", elapsedMs: Date.now() - d.startedAt });
    return [
      "fr-batch: hard stop — the driver stopped waiting for its child.",
      "",
      "That child was ABANDONED, not killed: it may keep running and keep editing this tree for a",
      "while. Let it settle before starting another run, and expect its partial edits on disk.",
      "",
      'The item is recorded as paused, so action "run" re-enters its phase over those files.',
    ].join("\n");
  }

  return `fr-batch: already hard-stopping — ${describeLive(d)}`;
}

// ---------------------------------------------------------------------------
// queue mutation (live-append safe: only this writes queue.json)
// ---------------------------------------------------------------------------
