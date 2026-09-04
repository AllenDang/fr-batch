import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertChildConfig, assertRoleConfigs } from "./config.ts";
import { baseDir, historyPath, progressPath, queuePath, runlockPath, writeAtomic } from "./paths.ts";
import { BUG_PROTOCOL_DEFAULTS, ITEM_KINDS, QUEUE_BUDGET_DEFAULTS, TRANSIENT_DEFAULTS, TRANSIENT_QUOTA_DEFAULTS } from "./types.ts";
import type { BugProtocol, HistoryEntry, ItemKind, ItemStatus, Log, Progress, ProgressEntry, Queue, QueueItem, TransientPolicy } from "./types.ts";

export const STALE_RUNLOCK_MS = 15 * 60 * 1000;

/** How often the live driver refreshes its run lock's mtime, so a long run never looks stale. */
export const RUNLOCK_TOUCH_MS = 60 * 1000;

/**
 * One of the three numeric budgets, resolved at LOAD time: default when the queue omits it,
 * hard error when it carries something unusable.
 *
 * Both halves matter and they fail differently. An omitted `childTimeoutMs` used to travel as
 * `undefined` into `setTimeout(fn, timeoutMs + 60_000)`, i.e. `setTimeout(fn, NaN)`, which fires
 * on the next tick — so every child "exceeded undefinedms" milliseconds after launch and the
 * only clue was that word in the error text. A `"3h"` string or a `0` fails the same way with a
 * different arithmetic accident, so a present value is checked rather than coerced.
 *
 * Defaulting rather than refusing is deliberate: these are budgets, not gates. `defaultVerify`
 * refuses to default because an empty gate silently passes everything; a missing timeout has a
 * safe, statable value, and a fresh install that works is worth more than a lecture.
 */
function budget(field: "maxFixRounds" | "maxTotalRounds" | "childTimeoutMs" | "verifyTimeoutMs", raw: unknown): number {
  if (raw === undefined || raw === null) return QUEUE_BUDGET_DEFAULTS[field];
  const min = field === "maxFixRounds" ? 0 : field === "maxTotalRounds" ? 1 : 1;
  const rounds = field === "maxFixRounds" || field === "maxTotalRounds";
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || (rounds && !Number.isInteger(raw))) {
    throw new Error(
      `fr-batch: queue.${field} must be a ${rounds ? `whole number >= ${min}` : "positive number of milliseconds"}, ` +
        `got ${JSON.stringify(raw)}. Remove it to accept the default (${QUEUE_BUDGET_DEFAULTS[field]}).`,
    );
  }
  return raw;
}

export function loadQueue(cwd: string): Queue {
  const p = queuePath(cwd);
  if (!existsSync(p)) throw new Error(`fr-batch: queue not found at ${p}`);
  const q = JSON.parse(readFileSync(p, "utf8")) as Queue;
  if (!Array.isArray(q.items)) throw new Error("fr-batch: queue.items must be an array");
  if (!Array.isArray(q.defaultVerify) || q.defaultVerify.length === 0) {
    throw new Error("fr-batch: queue.defaultVerify must be a non-empty array — an empty verify gate is no gate");
  }
  const seen = new Set<string>();
  // Filled in place, so every `q.childTimeoutMs` read downstream is a number by construction.
  q.maxFixRounds = budget("maxFixRounds", q.maxFixRounds);
  q.maxTotalRounds = budget("maxTotalRounds", q.maxTotalRounds);
  q.childTimeoutMs = budget("childTimeoutMs", q.childTimeoutMs);
  q.verifyTimeoutMs = budget("verifyTimeoutMs", q.verifyTimeoutMs);
  assertChildConfig("queue", { model: q.defaultModel, thinking: q.defaultThinking });
  assertRoleConfigs("queue.roles", q.roles);
  for (const item of q.items) {
    if (!item.id || !item.plan) throw new Error(`fr-batch: every queue item needs id and plan (offender: ${JSON.stringify(item).slice(0, 120)})`);
    if (seen.has(item.id)) throw new Error(`fr-batch: duplicate queue item id "${item.id}"`);
    seen.add(item.id);
    assertChildConfig(`item "${item.id}"`, { model: item.model, thinking: item.thinking });
    assertRoleConfigs(`item "${item.id}".roles`, item.roles);
    assertItemKind(item);
  }
  // Refused HERE rather than at first use: an item that names a pipeline with no protocol behind it
  // would otherwise load clean and die several phases in, after a child had already edited the tree.
  for (const item of q.items) {
    if (kindOf(item) === "bug") assertBugProtocol(q, item);
  }
  return q;
}

/** An item's pipeline. Absent means "fr", which is what keeps every pre-existing queue working. */
export function kindOf(item: QueueItem): ItemKind {
  return item.kind ?? "fr";
}

function assertItemKind(item: QueueItem): void {
  if (item.kind !== undefined && !ITEM_KINDS.includes(item.kind)) {
    throw new Error(`fr-batch: item "${item.id}" has kind "${String(item.kind)}" — only ${ITEM_KINDS.join(", ")} are pipelines`);
  }
  if (kindOf(item) !== "bug") {
    if (item.fixture !== undefined) throw new Error(`fr-batch: item "${item.id}" sets fixture but is not kind:"bug"`);
    if (item.bugProtocol !== undefined) throw new Error(`fr-batch: item "${item.id}" sets bugProtocol but is not kind:"bug"`);
    return;
  }
  // `fr` is refused on a bug item because prompts.ts's frFor() SHORT-CIRCUITS on it: with `fr` set,
  // readsBlock hands the child a companion doc that a bug report does not have, and for a report
  // named `FIX_x_PLAN.md` the `_PLAN.md` derivation invents one that does not exist.
  if (item.fr !== undefined) {
    throw new Error(`fr-batch: item "${item.id}" is kind:"bug" and must not set fr — a bug report has no companion FR doc`);
  }
  if (item.fixture !== undefined && !item.fixture.trim()) {
    throw new Error(`fr-batch: item "${item.id}" fixture must be a non-empty string, or omitted to derive it from plan`);
  }
}

/**
 * The resolved protocol for one bug item: item over queue over defaults, FIELD BY FIELD.
 *
 * Per-field so an item can override just its `run`, or just unset `results`, without restating a
 * protocol its 171 siblings share — the same layering `verifyFor` gives `verify`/`defaultVerify`.
 */
export function bugProtocolFor(q: Queue, item: QueueItem): BugProtocol {
  const merged = { ...BUG_PROTOCOL_DEFAULTS, results: null as string | null, run: [] as string[], ...(q.bugProtocol ?? {}), ...(item.bugProtocol ?? {}) };
  return {
    run: merged.run,
    // `null` is a VALUE here, not "absent": it is how a layer says "this repo has no per-scenario
    // sink". `??` would fall back through it and re-inherit the outer path, which is the bug this
    // sentinel exists to prevent.
    results: merged.results,
    nameField: merged.nameField,
    passField: merged.passField,
    redExit: merged.redExit,
    greenExit: merged.greenExit,
    invalidExit: merged.invalidExit,
    pinPaths: merged.pinPaths,
    requirePin: merged.requirePin,
    pinPattern: merged.pinPattern,
    requireMechanismTouch: merged.requireMechanismTouch,
  };
}

function assertBugProtocol(q: Queue, item: QueueItem): void {
  const where = `item "${item.id}"`;
  if (q.bugProtocol === undefined && item.bugProtocol === undefined) {
    throw new Error(
      `fr-batch: ${where} is kind:"bug" but neither queue.bugProtocol nor its own bugProtocol is set. ` +
        `A bug item needs at least a \`run\` command — this driver knows no build system, so the protocol comes from this repo.`,
    );
  }
  const p = bugProtocolFor(q, item);
  if (!Array.isArray(p.run) || p.run.length === 0 || p.run.some((c) => typeof c !== "string" || !c.trim())) {
    throw new Error(`fr-batch: ${where} bugProtocol.run must be a non-empty array of non-empty commands — an empty runner reports every fixture green`);
  }
  if (p.results !== null && (typeof p.results !== "string" || !p.results.trim())) {
    throw new Error(`fr-batch: ${where} bugProtocol.results must be a non-empty string, or null for an exit-code-only pin`);
  }
  for (const f of ["nameField", "passField"] as const) {
    if (typeof p[f] !== "string" || !p[f].trim()) throw new Error(`fr-batch: ${where} bugProtocol.${f} must be a non-empty string`);
  }
  const seenExit = new Map<number, string>();
  for (const f of ["redExit", "greenExit", "invalidExit"] as const) {
    const codes = p[f];
    if (!Array.isArray(codes) || codes.length === 0 || codes.some((c) => !Number.isInteger(c))) {
      throw new Error(`fr-batch: ${where} bugProtocol.${f} must be a non-empty array of integer exit codes`);
    }
    for (const c of codes) {
      const prior = seenExit.get(c);
      // Disjoint or one exit code carries two verdicts, and which one wins would be an accident of
      // evaluation order rather than a decision anyone made.
      if (prior && prior !== f) throw new Error(`fr-batch: ${where} bugProtocol exit code ${c} is in both ${prior} and ${f} — the sets must be disjoint`);
      seenExit.set(c, f);
    }
  }
  if (!Array.isArray(p.pinPaths) || p.pinPaths.length === 0 || p.pinPaths.some((s) => typeof s !== "string" || !s.trim())) {
    throw new Error(
      `fr-batch: ${where} bugProtocol.pinPaths must be a non-empty array — it is the only gate between the fixer and the pin it is judged by`,
    );
  }
  // The results sink is SUBTRACTED from the immutability set, because the runner rewrites it every
  // pass. Pointing it AT a pin therefore switches that pin's protection off. A sink INSIDE the
  // fixture directory is normal and fine (ANGE's own sink lives there) — only an exact collision
  // with a pin path is refused, and it is refused here so a queue edit cannot arrange it for a
  // later item either.
  if (p.results !== null) {
    // The SAME derivation the runtime uses (bug_pipeline's fixtureOf). An earlier draft substituted
    // `item.fixture ?? ""` here, so for the documented default shape — an item that omits `fixture` —
    // the load-time check and the gate disagreed about what the paths were.
    const fx = item.fixture ?? dirname(item.plan);
    const sub = (s: string) => s.replace(/\{(fixture|plan)\}/g, (_m, k: string) => (k === "fixture" ? fx : item.plan));
    const sink = sub(p.results);
    const collision = p.pinPaths.map(sub).find((pp) => pp === sink);
    if (collision !== undefined) {
      throw new Error(
        `fr-batch: ${where} bugProtocol.results resolves to "${sink}", which is also a pinPaths entry. ` +
          `The sink is excluded from the immutability check because every run rewrites it, so this would leave that pin unprotected.`,
      );
    }
  }
  if (p.requirePin) {
    if (!p.pinPattern.trim()) throw new Error(`fr-batch: ${where} bugProtocol.requirePin is on but pinPattern is empty — nothing could ever satisfy it`);
    try {
      new RegExp(p.pinPattern);
    } catch (e) {
      // Compiled at LOAD, not at the gate: a bad pattern discovered three phases in would surface
      // after the fixer had already edited the tree.
      throw new Error(`fr-batch: ${where} bugProtocol.pinPattern is not a valid regular expression (${(e as Error).message})`);
    }
  }
}

/** Merge the queue's transient block over the defaults so an older queue.json still loads. */
export function transientPolicy(q: Queue): TransientPolicy {
  return { ...TRANSIENT_DEFAULTS, ...(q.transient ?? {}) };
}

/**
 * The QUOTA policy. `transientQuota` wins, then the quota defaults — deliberately NOT layered
 * over `transient`, because a repo that tightened `transient` for fast network failure would
 * otherwise silently tighten the quota budget too, which is the coupling this split removes.
 */
export function transientQuotaPolicy(q: Queue): TransientPolicy {
  return { ...TRANSIENT_QUOTA_DEFAULTS, ...(q.transientQuota ?? {}) };
}

// ---------------------------------------------------------------------------
// per-child model / reasoning effort
//
// Four layers, most specific first, EACH FIELD RESOLVED ON ITS OWN:
//
//   item.roles[role]  ->  item  ->  queue.roles[role]  ->  queue.default*  ->  session
//
// Per-field rather than per-object so `roles: { auditor: { thinking: "high" } }` can sit
// on top of a `defaultModel` without having to restate the model.
//
// The last layer is the supervising conversation itself, which is what "configure nothing
// and it inherits the current session" means. That layer has to be passed EXPLICITLY:
// pi-subagents inherits the parent MODEL on its own (resolveEffectiveSubagentModel) but
// NOT the parent's reasoning effort — with no `thinking` on the agent config the child
// falls back to the global default — so leaving it implicit inherits half the setting.
// ---------------------------------------------------------------------------

/** The driver's file. Written only here, always atomically, never merged with queue.json. */
export function loadProgress(cwd: string): Progress {
  const p = progressPath(cwd);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Progress;
  } catch {
    return {};
  }
}

export function setProgress(cwd: string, id: string, patch: Partial<ProgressEntry>): ProgressEntry {
  // Read-modify-write against the file, not against a snapshot: `run` is the only
  // writer, but a crash mid-batch must not lose earlier items' state.
  const all = loadProgress(cwd);
  // Resolved, not `patch.status`: a patch that omits status (a bare fixRounds bump) inherits the
  // stored one, and keying the pause block off the patch alone would then WIPE a live pause's
  // phase, child id and question — the fields `continue` needs to revive that child.
  const status = patch.status ?? all[id]?.status ?? "pending";
  const next: ProgressEntry = {
    status,
    fixRounds: patch.fixRounds ?? all[id]?.fixRounds ?? 0,
    ...(patch.barrenRounds !== undefined ? { barrenRounds: patch.barrenRounds } : all[id]?.barrenRounds !== undefined ? { barrenRounds: all[id].barrenRounds } : {}),
    updatedAt: new Date().toISOString(),
    ...(patch.note !== undefined ? { note: patch.note } : all[id]?.note ? { note: all[id].note } : {}),
    ...(patch.sha !== undefined ? { sha: patch.sha } : all[id]?.sha ? { sha: all[id].sha } : {}),
    // Meaningful only while blocked, for the same reason the pause block below is scoped: a stale
    // scope on a running item would let a plain `run` re-enter a verdict it cannot re-judge.
    ...(status === "blocked"
      ? { ...(patch.blockScope !== undefined ? { blockScope: patch.blockScope } : all[id]?.blockScope ? { blockScope: all[id].blockScope } : {}) }
      : {}),
    // WHERE an item stopped outlives the reason it stopped: both `paused` and `blocked` are re-entered
    // at that phase, so retaining this only while paused made every blocked re-entry land at verify.
    ...(status === "paused" || status === "blocked"
      ? {
          ...(patch.pausedPhase !== undefined ? { pausedPhase: patch.pausedPhase } : all[id]?.pausedPhase ? { pausedPhase: all[id].pausedPhase } : {}),
          ...(patch.pausedRound !== undefined ? { pausedRound: patch.pausedRound } : {}),
        }
      : {}),
    // The child id is different: it names a PROCESS, and a stale one must never be revived. Only a
    // paused item has a child worth resuming.
    ...(status === "paused"
      ? {
          ...(patch.pausedChildId !== undefined ? { pausedChildId: patch.pausedChildId } : all[id]?.pausedChildId ? { pausedChildId: all[id].pausedChildId } : {}),
          ...(patch.pauseKind !== undefined ? { pauseKind: patch.pauseKind } : all[id]?.pauseKind ? { pauseKind: all[id].pauseKind } : {}),
          ...(patch.pendingAsk !== undefined ? { pendingAsk: patch.pendingAsk } : all[id]?.pendingAsk ? { pendingAsk: all[id].pendingAsk } : {}),
        }
      : {}),
  };
  all[id] = next;
  writeAtomic(progressPath(cwd), `${JSON.stringify(all, null, 2)}\n`);
  return next;
}

export function statusOf(progress: Progress, id: string): ItemStatus {
  return progress[id]?.status ?? "pending";
}

// ---------------------------------------------------------------------------
// history (append-only)
//
// JSONL, not JSON, and appended rather than rewritten. Three reasons, all of which
// bite exactly when the record gets long:
//   * an append is O(1) in the size of the record, so archiving item 400 costs what
//     archiving item 1 did;
//   * a torn or hand-mangled line loses ONE item instead of failing the parse of the
//     whole file, so a bad byte can never brick the record (see loadHistory's skip);
//   * `grep '"id":"foo"'` answers the common question without loading anything.
// Nothing on the status path reads it — only countHistory, which needs a line count.
// ---------------------------------------------------------------------------

/** Malformed lines are SKIPPED, not thrown on: one bad line must not hide 400 good ones. */
export function loadHistory(cwd: string): HistoryEntry[] {
  const p = historyPath(cwd);
  if (!existsSync(p)) return [];
  const out: HistoryEntry[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as HistoryEntry;
      if (e && typeof e.id === "string") out.push(e);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * How many items are archived, without materialising them. `status` shows this number and
 * nothing else from the record, so it must not cost a parse of every line.
 *
 * A line counts when it looks like one whole object. Cheaper than JSON.parse and it agrees
 * with loadHistory on the realistic corruption — a half-written last line, which cannot end
 * in `}` — so `status` never reports a count that `history` then fails to show.
 */
export function countHistory(cwd: string): number {
  const p = historyPath(cwd);
  if (!existsSync(p)) return 0;
  let n = 0;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (t.startsWith("{") && t.endsWith("}")) n++;
  }
  return n;
}

/** One `\n`-terminated line per entry, so a crash mid-write costs at most the last line. */
export function appendHistory(cwd: string, entries: HistoryEntry[]): void {
  if (entries.length === 0) return;
  mkdirSync(baseDir(cwd), { recursive: true });
  appendFileSync(historyPath(cwd), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// frozen audit contract + gap ledger
//
// This is what makes the audit loop terminate. The auditor is adversarial by
// design and will always find one more thing to want; the fixer is told to keep
// the live PLAN truthful and may add production branches while closing a gap. Judge
// round N+1 against the live PLAN and those two facts compose into a loop with no
// fixed point. So the contract is snapshotted once and every round is judged
// against the snapshot, out-of-contract findings are demoted to notes, and the
// ledger remembers what was already adjudicated.
// ---------------------------------------------------------------------------

export function verifyFor(q: Queue, item: QueueItem): { cmds: string[]; isDefault: boolean } {
  return item.verify && item.verify.length > 0
    ? { cmds: item.verify, isDefault: false }
    : { cmds: q.defaultVerify, isDefault: true };
}

export function artifactDir(cwd: string): string {
  const d = join(cwd, ".pi-subagents", "fr-batch");
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Drop the intermediate round artifacts of an item that COMMITTED, keeping the last
 * audit verdict and the implement report. Nothing is pruned for a blocked item — those
 * files are the scene of the failure and are exactly what a human needs.
 *
 * Every child spawn also leaves ~1-2MB of transcript in pi-subagents' own artifact root,
 * which this cannot reach; set `artifactDir: "session"` in pi-subagents' settings so that
 * root is age-cleaned instead of accumulating in the working tree forever.
 */
export function pruneItemArtifacts(cwd: string, id: string, log: Log): void {
  const d = artifactDir(cwd);
  let files: string[] = [];
  try {
    files = readdirSync(d).filter((f) => f.startsWith(`${id}-`));
  } catch {
    return;
  }
  // `<id>-audit-<N>.json` ONLY. The old `/-audit-(\d+)\.json$/` also matched
  // `<id>-fix-audit-<N>.json`, so the "last verdict" it kept could be the FIXER's report while the
  // audit verdict was deleted — and that verdict is the file the commit and block messages point
  // at (`Full verdict: <path>`). Matched by prefix + suffix instead, because an item id is
  // user-supplied and would have to be regex-escaped to appear in a pattern.
  // `<id>-audit-<N>.verdict.json` ONLY. Two traps here, both paid for once already.
  //
  // The first: `/-audit-(\d+)\.json$/` also matched `<id>-fix-audit-<N>.json`, so the "last verdict"
  // it kept could be the FIXER's report while the audit verdict was deleted — and that verdict is
  // the file the block messages point at.
  //
  // The second: the audit's two outputs used to share the `.json` extension, because the child's
  // prose narration was written to a file named `.json`. That is fixed at the source (prose is `.md`
  // now, the verdict is `.verdict.json`), and this matcher follows it. Matched by prefix + suffix
  // rather than a pattern, because an item id is user-supplied and would have to be regex-escaped.
  const roundOf = (f: string): number => {
    const head = `${id}-audit-`;
    const tail = ".verdict.json";
    if (!f.startsWith(head) || !f.endsWith(tail)) return -1;
    const mid = f.slice(head.length, -tail.length);
    return /^\d+$/.test(mid) ? Number(mid) : -1;
  };
  // The narration beside the last verdict is kept too: it is what a human reads to see HOW the
  // auditor reached it, and it is useless once its verdict is gone.
  const narrationOf = (f: string): number => {
    const head = `${id}-audit-`;
    if (!f.startsWith(head) || !f.endsWith(".md")) return -1;
    const mid = f.slice(head.length, -".md".length);
    return /^\d+$/.test(mid) ? Number(mid) : -1;
  };
  const lastVerdict = files.filter((f) => roundOf(f) >= 0).sort((a, b) => roundOf(a) - roundOf(b)).pop();
  const lastNarration = files.filter((f) => narrationOf(f) >= 0).sort((a, b) => narrationOf(a) - narrationOf(b)).pop();
  // The bug pipeline produces neither an implement report nor an audit verdict, so without its own
  // keep entry every bug-fix report would be deleted at commit — and that report is the only record
  // of what the fixer changed and why. Same prefix+digits+suffix scheme, which collides with
  // nothing else generated (`-implement.md`, `-fix-verify-N.md`, `-audit-N.json`, `-fix-audit-N.json`).
  const bugRoundOf = (f: string): number => {
    const head = `${id}-bugfix-`;
    if (!f.startsWith(head) || !f.endsWith(".md")) return -1;
    const mid = f.slice(head.length, -".md".length);
    return /^\d+$/.test(mid) ? Number(mid) : -1;
  };
  const lastBugfix = files.filter((f) => bugRoundOf(f) >= 0).sort((a, b) => bugRoundOf(a) - bugRoundOf(b)).pop();
  const keep = new Set([lastVerdict, lastNarration, lastBugfix, `${id}-implement.md`, `${id}-scope.md`].filter(Boolean) as string[]);
  let freed = 0;
  for (const f of files) {
    if (keep.has(f)) continue;
    const p = join(d, f);
    try {
      freed += statSync(p).size;
      rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
  const dropped = files.filter((f) => !keep.has(f)).length;
  if (dropped > 0) log(`  pruned ${dropped} intermediate round artifact(s) (${Math.round(freed / 1024)}KB); kept ${[...keep].filter((f) => files.includes(f)).join(", ")}`);
}

// ---------------------------------------------------------------------------
// single-driver interlock
// ---------------------------------------------------------------------------

/**
 * Who holds the run lock, and whether that process is still alive.
 *
 * THE PID WAS ALWAYS ON DISK AND LIVENESS WAS DECIDED BY THE FILE'S AGE. A fact was available and a
 * fifteen-minute heuristic was used instead, so after a driver died — a crash, a `/reload`, a quit —
 * `reset` and `archive` refused for a quarter of an hour and the operator had to delete the file by
 * hand. Reported from a real batch.
 *
 * `process.kill(pid, 0)` sends no signal; it only asks whether the pid can be signalled.
 *   ESRCH   no such process         -> dead, reclaimable
 *   EPERM   alive, owned by someone else (another user, another container namespace)
 *           -> treated as ALIVE, which is the safe direction: refusing is recoverable, and two
 *              drivers in one tree is not.
 * Age survives only for a lock with no parseable pid — an older format, or a hand-written file — and
 * is no longer load-bearing.
 */
export function lockHolder(cwd: string): { text: string; pid: number | null; alive: boolean; ageMs: number } | null {
  const p = runlockPath(cwd);
  if (!existsSync(p)) return null;
  let text = "unknown";
  try {
    text = readFileSync(p, "utf8").trim();
  } catch {
    /* a lock we cannot read is still a lock */
  }
  let ageMs = 0;
  try {
    ageMs = Date.now() - statSync(p).mtimeMs;
  } catch {
    /* ignore */
  }
  const m = /\bpid\s+(\d+)\b/.exec(text);
  const pid = m ? Number(m[1]) : null;
  if (pid === null) return { text, pid: null, alive: ageMs < STALE_RUNLOCK_MS, ageMs };
  // Our own pid means the extension reloaded inside this process: the loop that held it is gone, so
  // the lock is ours to reclaim. Without this a reload could never start another run.
  if (pid === process.pid) return { text, pid, alive: false, ageMs };
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (e) {
    alive = (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
  // A live pid is not enough. Pids are RECYCLED, so an unrelated process inheriting the number would
  // make the refusal permanent — strictly worse than the fifteen-minute wait this replaced. A driver
  // that genuinely holds the lock re-touches it every RUNLOCK_TOUCH_MS, so a lock whose mtime has gone
  // stale is not held by whatever owns that pid now. This is also the ONLY reader of touchRunlock's
  // effect: without it the touch interval was a heartbeat nobody listened to.
  if (alive && ageMs >= STALE_RUNLOCK_MS) return { text, pid, alive: false, ageMs };
  return { text, pid, alive, ageMs };
}

/** One line describing a held lock, for a refusal message. */
export function describeLock(h: { text: string; pid: number | null; alive: boolean; ageMs: number }): string {
  const age = `${Math.round(h.ageMs / 1000)}s old`;
  if (h.pid === null) return `${h.text} (no pid in the lock; judged by age, ${age})`;
  return `${h.text} (pid ${h.pid} is ${h.alive ? "RUNNING" : "gone"}, ${age})`;
}

export function acquireRunlock(cwd: string): { release: () => void } | { held: string } {
  const p = runlockPath(cwd);
  const holder = lockHolder(cwd);
  if (holder) {
    if (holder.alive) return { held: describeLock(holder) };
    rmSync(p, { force: true }); // the holder is gone, whatever the file's age says
  }
  mkdirSync(dirname(p), { recursive: true });
  try {
    const fd = openSync(p, "wx");
    closeSync(fd);
    writeFileSync(p, `pid ${process.pid} since ${new Date().toISOString()}\n`, "utf8");
  } catch {
    return { held: "another process won the race" };
  }
  return { release: () => rmSync(p, { force: true }) };
}

/**
 * Keep a live driver's lock young. `acquireRunlock` treats a lock older than
 * STALE_RUNLOCK_MS as abandoned, which was safe only while a run could not outlive a
 * turn; a background batch routinely runs for hours, and without this a second session
 * would decide the first one had died and start writing the same tree.
 */
export function touchRunlock(cwd: string): void {
  const p = runlockPath(cwd);
  if (!existsSync(p)) return;
  const now = new Date();
  try {
    utimesSync(p, now, now);
    return;
  } catch {
    /* fall through to a rewrite */
  }
  // A swallowed failure here is no longer harmless. `lockHolder` treats `alive && mtime stale` as a
  // RECYCLED pid and reclaims, so a live holder that silently stops touching gets its lock taken and
  // ends up sharing the tree with a second driver. utimesSync can fail where a write succeeds (some
  // network and container filesystems refuse it), so the fallback is to rewrite the same bytes, which
  // updates mtime by definition.
  try {
    writeFileSync(p, readFileSync(p, "utf8"), "utf8");
  } catch {
    /* the lock is gone or unwritable; the next acquire reports what it finds */
  }
}

// ---------------------------------------------------------------------------
// pi-subagents RPC
// ---------------------------------------------------------------------------
