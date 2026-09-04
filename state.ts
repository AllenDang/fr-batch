import type { ItemKind } from "./types.ts";

/** Log tail kept in memory for `status`. The durable record is progress.json, not this. */
export const LOG_TAIL_LINES = 40;

/**
 * WHY THE BATCH IS NOT AWAITED BY THE TOOL CALL.
 *
 * pi delivers a queued user message only "after the current assistant turn finishes
 * executing its tool calls" (docs/rpc.md, `steer`). A tool that awaits a multi-hour
 * batch therefore freezes the supervising conversation for the whole batch: every
 * message the operator types lands in the steering queue, and none of `status`, `add`,
 * `remove` or `stop` can run — including the live append this queue was designed for.
 *
 * So `run`/`continue` start the loop and return. Nothing in the loop actually needed the
 * turn: children are already async subagent runs, and every phase transition is already
 * persisted in progress.json. The two things the turn did give are replaced explicitly —
 * esc-abort by `stop`, and the streaming card by `status`.
 *
 * One property is worth keeping from the old shape: a refusal (disarmed queue, dirty
 * tree, held lock) settles in milliseconds and belongs in the tool result, not in a
 * notification that arrives after the tool already claimed "started". Hence the grace
 * race below — settle within DETACH_GRACE_MS and the text is returned inline and NOT
 * notified; outlive it and the driver detaches and reports through the notify path.
 *
 * State is per-cwd rather than global because the run lock is per-cwd: two projects can
 * legitimately have a driver each, the same project cannot.
 */
export interface LiveDriver {
  startedAt: number;
  /** Reserved for a HARD stop. Never fired by a graceful stop — see runBatch's `shouldStop`. */
  abort: AbortController;
  stopRequested: boolean;
  hardStopped: boolean;
  /** False while the starting tool call still holds the result; true once it has detached. */
  detached: boolean;
  only?: string;
  /** Which pipeline is live, so two projects' status lines are distinguishable. */
  kind?: ItemKind;
  /**
   * Which start this driver was. A superseded driver must not report.
   *
   * The extension is an in-process loop, and a `/reload` replaces the module while the old loop's
   * timers, its run-status poller and its `sendMessage` are all still live. Reported from a real
   * batch: a completion arrived naming a `childTimeoutMs` from a queue that had since been edited,
   * and a `STOPPED at <id>` for an item the operator had already removed. Every one of those came
   * from a driver nobody had told to stop caring.
   */
  generation: number;
  /** Tail of the driver's own log, for `status`. progress.json remains the durable record. */
  lines: string[];
  settled: Promise<void>;
  touch: ReturnType<typeof setInterval> | undefined;
}

export interface FinishedRun {
  at: number;
  elapsedMs: number;
  text: string;
  failed: boolean;
}

export const drivers = new Map<string, LiveDriver>();

/**
 * Monotonic per-cwd start counter. Bumped by startDriver, compared by finishDriver.
 *
 * Module-level, so it survives for as long as the module does — which is exactly the scope that
 * matters: a reload gets a fresh module and a fresh counter, and the old module's drivers can no
 * longer match the new one's current generation.
 */
export const generations = new Map<string, number>();

export function nextGeneration(cwd: string): number {
  const g = (generations.get(cwd) ?? 0) + 1;
  generations.set(cwd, g);
  return g;
}

/** True when this driver is still the one this cwd's operator is waiting on. */
export function isCurrentGeneration(cwd: string, d: LiveDriver): boolean {
  return (generations.get(cwd) ?? 0) === d.generation;
}
export const finishedRuns = new Map<string, FinishedRun>();

export function elapsedLabel(ms: number): string {  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function lastLogLine(d: LiveDriver): string {
  for (let i = d.lines.length - 1; i >= 0; i--) {
    const l = d.lines[i].trim();
    if (l) return l;
  }
  return "starting…";
}

export function describeLive(d: LiveDriver): string {
  const state = d.hardStopped ? "hard-stopping" : d.stopRequested ? "stopping at the next phase boundary" : "running";
  const scope = d.only ? ` (only: ${d.only})` : d.kind && d.kind !== "fr" ? ` (kind: ${d.kind})` : "";
  return `${state} for ${elapsedLabel(Date.now() - d.startedAt)}${scope} — ${lastLogLine(d)}`;
}
