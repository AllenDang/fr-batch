import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { asEffort, modelLabel, normalizeChildConfig } from "./config.ts";
import { archiveDir, historyPath, itemStateFiles, progressPath, queuePath, runlockPath, writeAtomic } from "./paths.ts";
import { describeLive, drivers } from "./state.ts";
import { STALE_RUNLOCK_MS, appendHistory, countHistory, loadHistory, loadProgress, loadQueue, statusOf } from "./store.ts";
import { THINKING_EFFORTS, isDone } from "./types.ts";
import type { HistoryEntry, QueueItem } from "./types.ts";

export interface AddArgs {
  plan: string;
  id?: string;
  fr?: string;
  reads?: string[];
  verify?: string[];
  commitMsg?: string;
  after?: string;
  before?: string;
  model?: string;
  thinking?: string;
}

export function idFromPlan(plan: string): string {
  return (
    plan
      .split("/")
      .pop()!
      .replace(/^FR_/, "")
      .replace(/_PLAN\.md$/, "")
      .replace(/\.md$/, "")
      .replace(/[^A-Za-z0-9_-]/g, "-") || "item"
  );
}

export function addItem(cwd: string, args: AddArgs): string {
  const q = loadQueue(cwd);
  const progress = loadProgress(cwd);

  if (!existsSync(join(cwd, args.plan))) {
    return `fr-batch: refused — plan not found: ${args.plan}`;
  }
  const id = args.id ?? idFromPlan(args.plan);
  if (q.items.some((i) => i.id === id)) return `fr-batch: refused — an item with id "${id}" is already queued.`;
  if (args.after && args.before) return "fr-batch: refused — pass at most one of after/before.";
  // Not a refusal: re-queueing an archived id is legitimate (the PLAN grew a follow-up phase,
  // or the item is being redone). But it is never what you MEANT if you forgot it already ran,
  // and the queue itself no longer carries the evidence — so it is said out loud.
  const priorRun = loadHistory(cwd).filter((e) => e.id === id).pop();
  // Rejected here rather than at the next load: an add that writes an unusable queue.json makes
  // every later action fail on a file the operator did not knowingly edit.
  if (args.thinking !== undefined && !asEffort(args.thinking)) {
    return `fr-batch: refused — thinking "${args.thinking}" is not a reasoning effort. Use one of ${THINKING_EFFORTS.join(", ")}.`;
  }
  if (args.model !== undefined && !args.model.trim()) return "fr-batch: refused — model must be a non-empty string.";

  const cfg = normalizeChildConfig({ model: args.model, thinking: asEffort(args.thinking) });
  const item: QueueItem = {
    id,
    plan: args.plan,
    ...(args.fr ? { fr: args.fr } : {}),
    ...(args.reads?.length ? { reads: args.reads } : {}),
    ...(args.verify?.length ? { verify: args.verify } : {}),
    ...(args.commitMsg ? { commitMsg: args.commitMsg } : {}),
    ...(cfg.model ? { model: cfg.model } : {}),
    ...(cfg.thinking ? { thinking: cfg.thinking } : {}),
  };

  let index = q.items.length;
  if (args.after) {
    const at = q.items.findIndex((i) => i.id === args.after);
    if (at < 0) return `fr-batch: refused — no queued item with id "${args.after}" to insert after.`;
    index = at + 1;
  } else if (args.before) {
    const at = q.items.findIndex((i) => i.id === args.before);
    if (at < 0) return `fr-batch: refused — no queued item with id "${args.before}" to insert before.`;
    index = at;
  }

  // The driver picks the FIRST non-committed item in queue order. An insert that
  // lands only among already-committed items would never run — say so instead of
  // accepting it silently.
  const firstPendingIndex = q.items.findIndex((i) => statusOf(progress, i.id) !== "committed");
  const wouldBeSkipped = firstPendingIndex >= 0 && index <= firstPendingIndex && index < q.items.length && statusOf(progress, q.items[index]?.id ?? "") === "committed";
  if (index < firstPendingIndex || (firstPendingIndex < 0 && index < q.items.length) || wouldBeSkipped) {
    return [
      `fr-batch: refused — position ${index} sits among already-committed items, so "${id}" would never run.`,
      `Insert at or after the first uncommitted item${firstPendingIndex >= 0 ? ` ("${q.items[firstPendingIndex].id}")` : ""}, or omit after/before to append at the tail.`,
    ].join("\n");
  }

  q.items.splice(index, 0, item);
  writeAtomic(queuePath(cwd), `${JSON.stringify(q, null, 2)}\n`);

  const inFlight = q.items.find((i) => {
    const s = statusOf(progress, i.id);
    return s !== "pending" && s !== "committed";
  });
  const runningNote = inFlight
    ? `\nA run is in flight on "${inFlight.id}". The driver re-reads the queue at each item boundary, so this item is picked up without a restart.`
    : "";
  const verifyNote = item.verify?.length ? "" : "\nNo verify commands given — this item will use queue.defaultVerify.";
  const modelNote = cfg.model || cfg.thinking
    ? `\nmodel: ${modelLabel(cfg)}${cfg.model && cfg.thinking ? "" : " (the unset half is inherited: item → queue.roles → queue.default* → this session)"}`
    : "\nNo model/thinking given — this item inherits queue.roles → queue.default* → the session that runs the batch.";
  const historyNote = priorRun
    ? `\nNOTE: "${id}" is already in history — committed as ${priorRun.sha ?? "(no sha)"}, archived ${priorRun.archivedAt.slice(0, 10)}. Re-queueing it will implement it again.`
    : "";

  return `fr-batch: queued "${id}" at position ${index + 1}/${q.items.length}.${verifyNote}${modelNote}${historyNote}${runningNote}`;
}

export function removeItem(cwd: string, id: string): string {
  const q = loadQueue(cwd);
  const progress = loadProgress(cwd);
  const at = q.items.findIndex((i) => i.id === id);
  if (at < 0) return `fr-batch: no queued item with id "${id}".`;
  const s = statusOf(progress, id);
  if (s === "committed")
    return [
      `fr-batch: refused — "${id}" is already committed; removing it from the queue would not undo the commit.`,
      `To take it out of the live queue and keep the record, sweep it: fr_batch action "archive", only: "${id}".`,
    ].join("\n");
  if (s === "paused")
    return [
      `fr-batch: refused — "${id}" is paused with uncommitted work in the tree.`,
      `Dropping the queue entry would orphan those edits. Clear it first: fr_batch action "reset", only: "${id}"`,
      "(that also drops its frozen contract and ledger), then remove it.",
    ].join("\n");
  if (s !== "pending" && s !== "blocked" && s !== "skipped") {
    return [
      `fr-batch: refused — "${id}" is currently ${s}.`,
      drivers.has(cwd)
        ? 'A driver is working on it. Stop the batch first: fr_batch action "stop".'
        : `No driver is running here, so that state is stale: clear it with fr_batch action "reset", only: "${id}".`,
    ].join("\n");
  }
  q.items.splice(at, 1);
  writeAtomic(queuePath(cwd), `${JSON.stringify(q, null, 2)}\n`);
  // Take the driver's state with it. A progress entry for an id that is no longer queued
  // is unreachable by every code path here, so keeping it only grows the file.
  const hadProgress = Boolean(progress[id]);
  delete progress[id];
  writeAtomic(progressPath(cwd), `${JSON.stringify(progress, null, 2)}\n`);
  const dropped = itemStateFiles(cwd, id).filter((p) => existsSync(p));
  for (const p of dropped) rmSync(p, { force: true });
  const cleaned = [hadProgress ? "progress entry" : "", dropped.length ? `${dropped.length} state file(s)` : ""].filter(Boolean).join(" + ");
  return `fr-batch: removed "${id}" from the queue${cleaned ? `, and cleared its ${cleaned}` : ""}.`;
}

export function resetItem(cwd: string, id: string): string {
  // REFUSED WHILE A DRIVER IS LIVE, for the same reason `archive` is: this deletes from
  // progress.json, which the driver read-modify-writes at every phase transition, so a reset
  // landing between its read and its write is silently undone and leaves an orphan. `archive` had
  // this guard and `reset` did not — and reset is the one an operator is tempted to run while
  // watching a batch that looks stuck (a real session was advised to reset a RUNNING item whose
  // lock had been refreshed a minute earlier; only a human declining saved it).
  const live = drivers.get(cwd);
  if (live) {
    return [
      `fr-batch: refused — a driver is running here (${describeLive(live)}).`,
      "Resetting now can be undone by its next write, and it would strand the child that is running.",
      'Stop the batch first: fr_batch action "stop" (twice to abandon the child), then reset.',
    ].join("\n");
  }
  const lock = runlockPath(cwd);
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < STALE_RUNLOCK_MS) {
    let holder = "unknown";
    try {
      holder = readFileSync(lock, "utf8").trim();
    } catch {
      /* ignore */
    }
    return [
      `fr-batch: refused — a fresh run lock is present (${holder}), so another session may be driving this repo.`,
      `Reset once it is done, or delete ${lock} if that process is gone.`,
    ].join("\n");
  }
  const all = loadProgress(cwd);
  const dropped = itemStateFiles(cwd, id).filter((p) => existsSync(p));
  if (!all[id] && dropped.length === 0) return `fr-batch: no progress entry for "${id}".`;
  const was = all[id]?.status ?? "pending";
  delete all[id];
  writeAtomic(progressPath(cwd), `${JSON.stringify(all, null, 2)}\n`);
  // The frozen contract and the gap ledger are part of "from scratch": a re-run must
  // re-freeze against the PLAN as it reads now, not inherit the old snapshot.
  for (const p of dropped) rmSync(p, { force: true });
  return `fr-batch: reset "${id}" (was ${was})${dropped.length ? `, dropped ${dropped.length} state file(s) incl. the frozen audit contract` : ""}. It will be implemented from scratch on the next run.`;
}

/**
 * Sweep committed items out of the live pair into history.jsonl.
 *
 * EXPLICIT, not automatic on commit, and that is the point: "the driver only READS queue.json"
 * is the whole safety argument for editing the queue while a batch runs. Archiving from inside
 * the driver would make it a writer, and a driver holding a stale in-memory snapshot while the
 * operator appends is exactly the lost update the two-file split exists to prevent. So the
 * sweep runs from the tool path, which is already the single writer of queue.json.
 *
 * REFUSED WHILE A DRIVER IS LIVE, unlike add/remove. Those touch only entries the driver is
 * not looking at; this one deletes from progress.json, which the driver read-modify-writes on
 * every phase transition — so a sweep landing between its read and its write is silently
 * undone, resurrecting the entries as orphans. Waiting for the batch to end costs nothing:
 * archiving is retrospective work.
 */
export function archiveItems(cwd: string, only?: string): string {
  const live = drivers.get(cwd);
  if (live) {
    return [
      `fr-batch: refused — a driver is running here (${describeLive(live)}).`,
      "It rewrites progress.json at every phase transition, so a sweep now can be undone by its next write.",
      'Archive once the batch ends, or stop it first: fr_batch action "stop".',
    ].join("\n");
  }
  const lock = runlockPath(cwd);
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < STALE_RUNLOCK_MS) {
    let holder = "unknown";
    try {
      holder = readFileSync(lock, "utf8").trim();
    } catch {
      /* ignore */
    }
    return [
      `fr-batch: refused — a fresh run lock is present (${holder}), so another session may be driving this repo.`,
      "Archiving deletes progress entries that driver is still rewriting.",
      `Sweep once it is done, or delete ${lock} if that process is gone.`,
    ].join("\n");
  }
  const q = loadQueue(cwd);
  const progress = loadProgress(cwd);

  // `skipped` is swept alongside `committed`: it is equally at rest, it carries no sha, and leaving
  // it out would strand it in the live queue forever — `remove` is the only other exit and that
  // discards the record instead of keeping it.
  const targets = q.items.filter((i) => isDone(statusOf(progress, i.id)) && (!only || i.id === only));
  if (targets.length === 0) {
    if (only) {
      const s = q.items.some((i) => i.id === only) ? statusOf(progress, only) : "not queued";
      return `fr-batch: nothing archived — "${only}" is ${s}. Only committed or skipped items can be archived.`;
    }
    const liveCount = q.items.length;
    return `fr-batch: nothing to archive — no committed items in the queue (${liveCount} live item(s), ${countHistory(cwd)} already archived).`;
  }

  const at = new Date().toISOString();
  const entries: HistoryEntry[] = [];
  // The three per-item artifacts are the retrospective evidence for a committed item (a frozen
  // contract runs to tens of KB), so they are MOVED, not deleted — and moved into a per-id dir,
  // because a flat base dir with 3 files per item is what makes the working directory unreadable
  // at scale (19 items already put 51 files in it).
  const moves: { id: string; files: string[] }[] = [];
  for (const item of targets) {
    const p = progress[item.id];
    const files = itemStateFiles(cwd, item.id).filter((f) => existsSync(f));
    if (files.length > 0) moves.push({ id: item.id, files });
    entries.push({
      id: item.id,
      plan: item.plan,
      ...(p?.sha ? { sha: p.sha } : {}),
      ...(item.commitMsg ? { commitMsg: item.commitMsg } : {}),
      fixRounds: p?.fixRounds ?? 0,
      ...(p?.updatedAt ? { committedAt: p.updatedAt } : {}),
      archivedAt: at,
      ...(p?.note ? { note: p.note } : {}),
      // A literal separator, not join(): this string is a record field read back on any
      // platform, and a Windows-flavoured one would not resolve where it is displayed.
      ...(files.length > 0 ? { stateDir: `archive/${item.id}` } : {}),
    });
  }

  // ORDER MATTERS, and this is the order: the record is written FIRST, then the evidence is
  // moved, then the live pair is rewritten. The one outcome worth avoiding is evidence parked
  // under archive/<id>/ with no history line pointing at it — unreferenced files nobody will
  // ever look for. Every other partial failure is benign: a duplicate line on a retry, or
  // state files still sitting flat for an id no longer in the queue.
  appendHistory(cwd, entries);

  for (const m of moves) {
    const dest = archiveDir(cwd, m.id);
    mkdirSync(dest, { recursive: true });
    for (const f of m.files) renameSync(f, join(dest, basename(f)));
  }

  const ids = new Set(targets.map((i) => i.id));
  q.items = q.items.filter((i) => !ids.has(i.id));
  writeAtomic(queuePath(cwd), `${JSON.stringify(q, null, 2)}\n`);
  for (const id of ids) delete progress[id];
  writeAtomic(progressPath(cwd), `${JSON.stringify(progress, null, 2)}\n`);

  return [
    `fr-batch: archived ${entries.length} committed item(s) to ${historyPath(cwd)} — ${entries.map((e) => e.id).join(", ")}.`,
    `queue is now ${q.items.length} live item(s); ${countHistory(cwd)} archived in total.`,
    ...(moves.length > 0 ? [`Frozen contract + gap ledger moved to .pi/fr-batch/archive/<id>/ for ${moves.length} item(s).`] : []),
    'Read the record back with fr_batch action "history" (add only:<id> for one item in full).',
  ].join("\n");
}
