import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { itemModelLabel, modelLabel } from "./config.ts";
import { VERIFY_DISPUTE_HEADING, extractTestsSection, loadLedger } from "./contract.ts";
import { contractPath, historyPath, itemStateFiles, outOfScopePath, progressPath, queuePath, runlockPath } from "./paths.ts";
import { describeLive, drivers, elapsedLabel, finishedRuns } from "./state.ts";
import { countHistory, loadHistory, loadProgress, loadQueue, statusOf, transientPolicy, transientQuotaPolicy, verifyFor } from "./store.ts";
import { isDone } from "./types.ts";
import type { ChildConfig, ItemStatus, Progress, Queue, QueueItem } from "./types.ts";

/** Default number of archived items `history` lists, newest first. */
export const HISTORY_ROWS = 20;

/**
 * The record, newest first. Bounded by `limit` because the whole point of archiving is that
 * the finished record never has to be paid for in full.
 */
export function renderHistory(cwd: string, only: string | undefined, limit: number): string {
  const all = loadHistory(cwd);
  if (all.length === 0) {
    return [
      `fr-batch: no history yet (${historyPath(cwd)} does not exist).`,
      'Committed items stay in the queue until you sweep them with fr_batch action "archive".',
    ].join("\n");
  }
  if (only) {
    const hits = all.filter((e) => e.id === only);
    if (hits.length === 0) return `fr-batch: no archived item with id "${only}" (${all.length} archived).`;
    return hits
      .map((e) =>
        [
          `${e.id}  ${e.sha ?? "(no sha)"}`,
          `  plan:       ${e.plan}`,
          ...(e.commitMsg ? [`  commit:     ${e.commitMsg}`] : []),
          `  fixRounds:  ${e.fixRounds}`,
          `  committed:  ${e.committedAt ?? "unknown"}   archived: ${e.archivedAt}`,
          ...(e.stateDir ? [`  evidence:   .pi/fr-batch/${e.stateDir}/`] : []),
          ...(e.note ? ["  note:", ...e.note.split("\n").map((l) => `    ${l}`)] : []),
        ].join("\n"),
      )
      .join("\n\n");
  }
  const shown = all.slice(-limit).reverse();
  return [
    `fr-batch history — ${all.length} archived item(s), newest ${shown.length} shown:`,
    ...shown.map((e) => `  ${(e.sha ?? "").slice(0, 9).padEnd(9)} ${e.id.padEnd(24)} fixes:${e.fixRounds} ${(e.archivedAt ?? "").slice(0, 10)}`),
    ...(all.length > shown.length ? [`  ⋯ ${all.length - shown.length} older item(s) — raise limit, or grep ${historyPath(cwd)}`] : []),
    "",
    'One item in full (incl. its closing note): fr_batch action "history", only: "<id>".',
  ].join("\n");
}


/**
 * How many upcoming `pending` rows the default status view shows. Everything IN FLIGHT is
 * always shown; the pending tail is a preview, and three of it is enough to see the order.
 */
export const STATUS_PENDING_WINDOW = 3;

/** Orphan ids listed inline before the list itself becomes the O(n) it is warning about. */
export const STATUS_ORPHAN_LIST = 8;

/**
 * How many committed items may sit in the queue before `status` says to sweep them. Not 1:
 * an item committed thirty seconds ago is still the thing the operator is looking at, and a
 * line telling them to file it away is noise on every render of a short batch.
 */
export const STATUS_ARCHIVE_NAG = 3;

/**
 * What `status` renders. The DEFAULT IS A SUMMARY, and that is a token budget decision, not
 * a cosmetic one: the old view was one line per queue item, so asking "how is it going" on a
 * 300-item queue cost ~300 lines every time, of which at most a handful were actionable.
 * `all` restores the full listing; `only` trades the listing for one item in depth.
 */
export interface StatusView {
  all?: boolean;
  only?: string;
}

/** The trailing chips on one status row — shared with the `only` detail view so they cannot drift. */
export function itemChips(q: Queue, item: QueueItem, progress: Progress, session: ChildConfig, baselineModel: string, cwd: string): string {
  const p = progress[item.id];
  const s = statusOf(progress, item.id);
  return [
    p?.sha ? p.sha : "",
    p?.fixRounds ? `fixes:${p.fixRounds}${p.barrenRounds ? ` barren:${p.barrenRounds}` : ""}` : "",
    // Shown for BLOCKED too, not only paused. The phase is recorded on every block, and for five of the
    // six verdict sites it changes no routing — re-entry correctly re-runs the verify gate, because you
    // cannot audit an item whose gate is not green. So its whole value is telling the operator where the
    // item stopped, and hiding it for blocked items left it recorded and unreadable.
    (s === "paused" || s === "blocked") && p?.pausedPhase ? `at:${p.pausedPhase}` : "",
    s === "paused" ? `pause:${p?.pauseKind ?? "network"}` : "",
    verifyFor(q, item).isDefault ? "verify:default" : "",
    itemModelLabel(q, item, session) !== baselineModel ? `model:${itemModelLabel(q, item, session)}` : "",
    contractDriftTag(cwd, item),
    outOfScopeTag(cwd, item),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * One item in full. This is the answer to "why would I read queue.json by hand" — the row
 * chips are abbreviations, and a blocked item's note is the one field worth its whole length.
 */
export function renderItemDetail(cwd: string, id: string, session: ChildConfig): string {
  const q = loadQueue(cwd);
  const progress = loadProgress(cwd);
  const at = q.items.findIndex((i) => i.id === id);
  if (at < 0) {
    const hist = loadHistory(cwd).filter((e) => e.id === id);
    if (hist.length > 0) return `fr-batch: "${id}" is not in the live queue — it is archived.\n\n${renderHistory(cwd, id, 1)}`;
    return `fr-batch: no queued item with id "${id}" (${q.items.length} live item(s), ${countHistory(cwd)} archived).`;
  }
  const item = q.items[at];
  const p = progress[id];
  const v = verifyFor(q, item);
  const ledger = loadLedger(cwd, id);
  const gaps = Object.entries(ledger);
  const open = gaps.filter(([, g]) => g.state === "open");
  return [
    `fr-batch — item "${id}"  (${at + 1}/${q.items.length})`,
    `status:    ${statusOf(progress, id)}${p?.fixRounds ? `  fixRounds:${p.fixRounds}` : ""}${p?.sha ? `  sha:${p.sha}` : ""}`,
    `plan:      ${item.plan}`,
    ...(item.fr ? [`fr:        ${item.fr}`] : []),
    ...(item.reads?.length ? [`reads:     ${item.reads.join(", ")}`] : []),
    `verify:    ${v.isDefault ? "(queue.defaultVerify)" : ""}`,
    ...v.cmds.map((c) => `           ${c}`),
    `model:     ${itemModelLabel(q, item, session)}`,
    ...(gaps.length > 0 ? [`gaps:      ${gaps.length} adjudicated, ${open.length} open${open.length ? ` (${open.map(([k]) => k).join(", ")})` : ""}`] : []),
    // Present-count only, no denominator. itemStateFiles is the UNION over both kinds, so a fixed
    // denominator makes every item's detail read as incomplete forever: an FR item can never own a
    // baseline or a siblings file, and a bug item can never own a contract or a gap ledger.
    `state:     ${itemStateFiles(cwd, id).filter((f) => existsSync(f)).length} state file(s) in .pi/fr-batch/`,
    ...(p?.pendingAsk ? ["", "pending question (verbatim):", p.pendingAsk] : []),
    ...(p?.note ? ["", "note:", ...p.note.split("\n").map((l) => `  ${l}`)] : []),
  ].join("\n");
}

/**
 * `session` is the inherit layer, so the caller passes the live one. It defaults to empty for
 * a caller that has no ExtensionContext (the guard tests), where every row then reads
 * "inherit" — which is exactly what an unresolvable session means.
 */

/**
 * `out-of-scope:yes` is not enough, and the difference matters for exactly one class of finding.
 *
 * Everything else in that file is coverage the auditor WANTED and the frozen contract does not ask
 * for: real follow-up material, but the item is right to ignore it. A `verify_findings` entry is the
 * opposite — the auditor is disputing the OPERATOR'S OWN gate, e.g. an assertion encoding a value
 * from before the change, which nothing else in the pipeline reviews. Recorded non-blocking is
 * correct; recorded and indistinguishable from ordinary wish-list items means nobody opens the file
 * on a committed item and the review is a self-report with no reader.
 */
function outOfScopeTag(cwd: string, item: QueueItem): string {
  const p = outOfScopePath(cwd, item.id);
  if (!existsSync(p)) return "";
  let text = "";
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return "out-of-scope:yes";
  }
  // The HEADING, imported, not a substring guessed at. A loose match on part of that sentence
  // could also be forged by the auditor's own prose: `verdict.notes` is appended verbatim to this same
  // file, so an auditor merely REMARKING on the verify gate would raise a dispute chip nobody filed.
  return text.includes(VERIFY_DISPUTE_HEADING) ? "out-of-scope:yes VERIFY-DISPUTED" : "out-of-scope:yes";
}

/**
 * `contract:frozen`, or `contract:DRIFTED` when the on-disk PLAN's `## Tests` section no longer
 * matches the frozen one.
 *
 * WHY THIS WARNS RATHER THAN BLOCKS. The frozen copy governs grading, and that is correct — an
 * implementer must not widen its own contract mid-item. But NOTHING told the supervisor when the
 * source PLAN was edited underneath a live item, and the two copies then answer "what does this row
 * require?" differently: the auditor grades the frozen text while a fixer reading the PLAN sees the
 * edited one. Measured cost: on `delete-cpu-ops` the §0 was rewritten while `## Tests` was left
 * stale, and TWO consecutive audit rounds reached the same unanswerable question before anyone
 * noticed the contract and its premise had separated. Two copies of a decision is how the copies
 * drift; this makes the separation visible at the one moment it matters.
 */
function contractDriftTag(cwd: string, item: QueueItem): string {
  const p = contractPath(cwd, item.id);
  if (!existsSync(p)) return "";
  let frozen = "";
  try {
    frozen = readFileSync(p, "utf8");
  } catch {
    return "contract:frozen";
  }
  const plan = join(cwd, item.plan);
  if (!existsSync(plan)) return "contract:frozen";
  let live = "";
  try {
    live = readFileSync(plan, "utf8");
  } catch {
    return "contract:frozen";
  }
  const liveTests = extractTestsSection(live);
  if (!liveTests) return "contract:frozen";
  // The frozen file is the header comment plus the section; compare only the section's own text,
  // normalised for trailing whitespace so a reflow is not reported as a semantic change.
  const norm = (t: string) =>
    t.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").trim();
  const frozenBody = norm(frozen.replace(/^<!--[\s\S]*?-->\s*/, ""));
  return norm(liveTests) === frozenBody ? "contract:frozen" : "contract:DRIFTED";
}

export function renderStatus(cwd: string, session: ChildConfig = {}, view: StatusView = {}): string {
  if (view.only) return renderItemDetail(cwd, view.only, session);
  const q = loadQueue(cwd);
  const progress = loadProgress(cwd);
  const locked = existsSync(runlockPath(cwd));
  const live = drivers.get(cwd);
  const last = finishedRuns.get(cwd);
  // Rows only carry a model chip when they DIFFER from this, so the common case stays quiet.
  const baselineModel = itemModelLabel(q, { id: "", plan: "" }, session);

  // Which rows earn their tokens: everything not at rest, plus a short preview of what is next.
  // `committed` and the deep pending tail are the two O(n) classes, and neither is actionable.
  const previewPending = new Set(
    q.items
      .filter((i) => statusOf(progress, i.id) === "pending")
      .slice(0, STATUS_PENDING_WINDOW)
      .map((i) => i.id),
  );
  const isShown = (i: QueueItem): boolean => {
    if (view.all) return true;
    const s = statusOf(progress, i.id);
    // `skipped` folds with `committed`: both are at rest, and an unfolded skipped row would make the
    // summary grow with the queue again, which is the one property this view exists to keep.
    if (isDone(s)) return false;
    if (s === "pending") return previewPending.has(i.id);
    return true;
  };

  // Queue order is preserved and every hidden RUN is replaced by one line that says what it
  // held, so the view never silently omits work — it says how much it folded and of what kind.
  const rows: string[] = [];
  let hiddenTotal = 0;
  let run: ItemStatus[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const byStatus = [...new Set(run)].map((s) => `${run.filter((x) => x === s).length} ${s}`).join(", ");
    rows.push(`  ⋯ ${String(run.length).padStart(2)}  hidden — ${byStatus}`);
    hiddenTotal += run.length;
    run = [];
  };
  q.items.forEach((i, n) => {
    const s = statusOf(progress, i.id);
    if (!isShown(i)) {
      run.push(s);
      return;
    }
    flush();
    // `skipped` gets its own glyph rather than falling into the in-flight `…`: an item the driver
    // decided needs no work must not read as one it is working on. probe_scale.ts's row regex
    // carries the same glyph class, so both move together or its row count silently goes to 0.
    const mark = s === "committed" ? "✓" : s === "skipped" ? "○" : s === "blocked" ? "✗" : s === "paused" ? "⏸" : s === "pending" ? " " : "…";
    const note = (s === "blocked" || s === "paused") && progress[i.id]?.note ? `\n         ${progress[i.id]!.note!.split("\n")[0]}` : "";
    rows.push(`  ${mark} ${String(n + 1).padStart(2)}. ${i.id.padEnd(24)} ${s.padEnd(13)} ${itemChips(q, i, progress, session, baselineModel, cwd)}${note}`);
  });
  flush();

  const done = q.items.filter((i) => statusOf(progress, i.id) === "committed").length;
  const skipped = q.items.filter((i) => statusOf(progress, i.id) === "skipped").length;
  const paused = q.items.filter((i) => statusOf(progress, i.id) === "paused");
  const waiting = paused.filter((i) => progress[i.id]?.pauseKind === "decision");
  const stopped = paused.filter((i) => progress[i.id]?.pauseKind === "stopped");
  // One pauseKind covers a hard stop and a wallclock expiry, so the CAUSE is read back out of the note
  // the driver wrote. Reporting both as "paused by a hard stop" told an operator their own keystroke
  // did something a budget did, which sends them looking for the wrong thing.
  const timedOut = stopped.filter((i) => (progress[i.id]?.note ?? "").startsWith("TIMED OUT"));
  const hardStopped = stopped.filter((i) => !(progress[i.id]?.note ?? "").startsWith("TIMED OUT"));
  const outage = paused.filter((i) => (progress[i.id]?.pauseKind ?? "network") === "network");
  const orphans = Object.keys(progress).filter((id) => !q.items.some((i) => i.id === id));
  const archived = countHistory(cwd);
  const pol = transientPolicy(q);
  const qpol = transientQuotaPolicy(q);
  return [
    `fr-batch — armed: ${q.armed} · barren/total rounds: ${q.maxFixRounds}/${q.maxTotalRounds} · ${done}/${q.items.length} committed${skipped ? `, ${skipped} skipped` : ""}${archived ? ` · ${archived} archived` : ""}`,
    `model: ${baselineModel}${session.model ? ` · session inherit: ${modelLabel(session)}` : " · session model unknown"}`,
    ...(live
      ? [`driver: ${describeLive(live)}`]
      : locked
        ? [`driver: none in this session, but a run lock is present (${runlockPath(cwd)}) — another session may own it`]
        : ["driver: idle"]),
    ...(!live && last ? [`last run: ended ${elapsedLabel(Date.now() - last.at)} ago after ${elapsedLabel(last.elapsedMs)} — ${last.text.split("\n")[0]}`] : []),
    ...rows,
    ...(hiddenTotal > 0
      ? [`  (summary view: in-flight + next ${STATUS_PENDING_WINDOW} pending. all:true = every row, only:"<id>" = one item in full.)`]
      : []),
    "",
    ...(done >= STATUS_ARCHIVE_NAG && !view.all && !live && !locked
      ? [
          `${done} committed item(s) still sit in the queue. Sweep them into history.jsonl with fr_batch action "archive" — the queue is re-read at every item boundary and rendered on every status, so keeping it at the size of the OPEN batch is what stops a long project from paying for its whole history on each look.`,
          "",
        ]
      : []),
    ...(waiting.length > 0
      ? waiting.flatMap((i) => [
          `⏸ ${i.id} is WAITING FOR A DECISION. Its child asked, verbatim:`,
          progress[i.id]?.pendingAsk ?? "  (question not recorded)",
          `Deliver it with: fr_batch action "continue", only: "${i.id}", answer: "<your decision>"`,
          "",
        ])
      : []),
    ...(outage.length > 0
      ? [`⏸ ${outage.length} item(s) paused on a network outage. When the connection is back: fr_batch action "continue".`, ""]
      : []),
    ...(hardStopped.length > 0
      ? [
          `⏸ ${hardStopped.length} item(s) paused by a hard stop. Their abandoned child may have left partial edits;`,
          `  fr_batch action "run" re-enters the recorded phase over them, action "reset" starts the item over.`,
          "",
        ]
      : []),
    ...(timedOut.length > 0
      ? [
          `⏸ ${timedOut.length} item(s) paused because a child OUTLIVED queue.childTimeoutMs. It was not killed —`,
          `  this driver cannot stop a running workflow, so it may still be editing the tree. Each item's note`,
          `  carries a \`subagent interrupt <run>\` line. Then action "run" re-enters, or raise childTimeoutMs.`,
          "",
        ]
      : []),
    ...(orphans.length > 0
      ? [
          `${orphans.length} progress entr(ies) for id(s) no longer queued: ${orphans.slice(0, STATUS_ORPHAN_LIST).join(", ")}${orphans.length > STATUS_ORPHAN_LIST ? `, +${orphans.length - STATUS_ORPHAN_LIST} more` : ""}. Clear with fr_batch action "reset", only:<id>.`,
          "",
        ]
      : []),
    "audit: frozen contract per item, out-of-contract findings non-blocking, budget counts BARREN rounds (nothing closed, nothing rejected)",
    `network retry: ${pol.maxRetries} attempt(s), ${Math.round(pol.baseDelayMs / 1000)}s→${Math.round(pol.maxDelayMs / 1000)}s backoff${pol.probeUrl ? `, probe ${pol.probeUrl}` : ", no probe"}${pol.resumeOnRetry ? ", resume-on-retry" : ", respawn-on-retry"}`,
    // Rendered as its OWN line, not folded into the one above: the two budgets are counted
    // separately, so a reader who sees only "6 attempts" would draw the wrong conclusion
    // about what happens on a 429.
    `quota retry:   ${qpol.maxRetries} attempt(s), ${Math.round(qpol.baseDelayMs / 1000)}s→${Math.round(qpol.maxDelayMs / 1000)}s backoff (429 / insufficient_quota / rate limit — counted apart from network)`,
    // Rendered because they are RESOLVED values, not the file's: loadQueue fills any budget the
    // queue omits, and a reader has to be able to tell a configured 3h from a defaulted one
    // without diffing queue.json against the defaults.
    `budgets: child ${elapsedLabel(q.childTimeoutMs)} · verify ${elapsedLabel(q.verifyTimeoutMs)} per gate run · maxFixRounds ${q.maxFixRounds} (consecutive BARREN rounds) · maxTotalRounds ${q.maxTotalRounds}`,
    `queue (yours):     ${queuePath(cwd)}`,
    `progress (driver): ${progressPath(cwd)}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
