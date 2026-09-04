import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runBugItem } from "./bug_pipeline.ts";
import { childSpawnParams, effortUndeliverable, itemModelLabel, modelLabel, resolveChildConfig, sessionChildConfig } from "./config.ts";
import { AUDIT_PARSE_RETRIES, extractAcceptanceSection, freezeContract, loadLedger, parseFixReport, parseVerdict, partitionGaps, planTestGate, readPlanText, recordOutOfScope, roundWasProductive, saveLedger } from "./contract.ts";
import { contractPath, ledgerPath, queuePath, runlockPath, writeAtomic } from "./paths.ts";
import { auditTask, fixTask, implementTask, noteBlock, readsBlock, rulesBlock } from "./prompts.ts";
import { INTERCOM_DETACH_MARK, NetworkPause, classifyLaunchFailure, formatAsk, runChildResilient } from "./resilience.ts";
import { makeRpc } from "./rpc.ts";
import type { ChildOutcome } from "./rpc.ts";
import { acquireRunlock, artifactDir, kindOf, loadProgress, loadQueue, pruneItemArtifacts, setProgress, statusOf, transientPolicy, transientQuotaPolicy, verifyFor } from "./store.ts";
import { AUDIT_SCHEMA, CHILD_ROLES, FIX_SCHEMA, UNPARSEABLE_GAP_ID, isDone } from "./types.ts";
import type { AuditVerdict, ChildConfig, ChildRole, ItemKind, LedgerEntry, Log, Phase, QueueItem } from "./types.ts";

/** Rows a dry run prints before it starts counting instead of listing. */
export const DRYRUN_ROWS = 20;

/**
 * What to say when pi-subagents cannot find one of the three agents this driver spawns.
 *
 * The failure used to be unreadable from here: the run died 37ms after launch with `Unknown
 * agent: fr-implementer`, that text lived only in the run's own status.json, and the driver
 * reported `implementing` for 51 minutes. Both halves are fixed — rpc.ts settles from the run's
 * state, and this names the cause — because a fresh install hitting this needs the fix, not a
 * diagnosis.
 */
export const UNKNOWN_AGENT_HINT = [
  "This is an INSTALL problem, not a PLAN problem: pi-subagents could not find one of the three",
  "agent definitions this driver spawns (fr-implementer, fr-test-auditor, fr-gap-fixer).",
  "They ship inside this extension's own `agents/` directory, declared by package.json",
  '`"pi-subagents": { "agents": ["./agents"] }`. Seeing this means the installed copy predates that,',
  "or the package filter dropped it. Update the extension (`pi update`) and /reload, or copy the",
  "three files into ~/.pi/agent/agents/ as a stopgap. `/subagents` lists what pi-subagents can see.",
].join("\n");

/**
 * A launched child that did not end in a success state, rendered for a `block` message — or null
 * when it succeeded.
 *
 * `error` is included because that is where a launch failure lives; the old message printed only
 * `summary`, which for a workflow that never started is the empty string. "Implementer ended with
 * status failed. Summary:" was the whole report.
 */
export function childOutcomeFailure(role: string, o: ChildOutcome): string | null {
  if (o.status === "complete" || o.status === "completed" || o.status === "success") return null;
  const both = `${o.error ?? ""} ${o.summary ?? ""}`;
  return [
    `${role} ended with status "${o.status}".`,
    ...(o.error?.trim() ? [`error: ${o.error.trim().slice(0, 900)}`] : []),
    ...(o.summary?.trim() ? [`summary: ${o.summary.trim().slice(0, 900)}`] : []),
    ...(o.artifactPath ? [`report: ${o.artifactPath}`] : []),
    ...(/unknown agent/i.test(both) ? ["", UNKNOWN_AGENT_HINT] : []),
  ].join("\n");
}

export async function runVerify(
  pi: ExtensionAPI,
  cwd: string,
  cmds: string[],
  timeoutMs: number,
  log: Log,
): Promise<{ ok: true } | { ok: false; cmd: string; code: number; tail: string }> {
  for (const cmd of cmds) {
    log(`  verify: ${cmd}`);
    const r = await pi.exec("bash", ["-lc", cmd], { cwd, timeout: timeoutMs });
    if (r.code !== 0) {
      const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-40).join("\n");
      return { ok: false, cmd, code: r.code ?? -1, tail };
    }
  }
  return { ok: true };
}

export async function runBatch(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  opts: {
    signal?: AbortSignal;
    only?: string;
    /** Which pipeline to drive. Absent means "fr", so an existing caller is unchanged. */
    kind?: ItemKind;
    dryRun?: boolean;
    answer?: string;
    /**
     * The operator asserting that a BLOCKED item's cause is dealt with, so the recorded phase may be
     * re-entered over the files already on disk.
     *
     * The sticky rule stays for a bare `run`: the driver genuinely cannot tell whether a human's fix
     * invalidated the recorded phase or the frozen contract. But "only reset clears it" made that
     * judgment cost the work, because `reset` starts over AND leaves the tree dirty, so the very
     * next `run` hits the clean-tree refusal. Reported from a real batch: a verified implementation
     * (21 files, 1172 lines, its fixture lane green) had to be parked in a git ref while a fresh
     * child rewrote 187 lines that then diverged from it.
     *
     * So the judgment becomes an explicit operator act instead of an unavoidable loss.
     */
    resumeBlocked?: boolean;
    /**
     * True when the loop is driven by the background driver rather than by a tool call
     * that is still holding a turn open. It changes exactly one behaviour: a pause asks
     * nobody. A modal confirm made sense while the turn was frozen anyway; from a
     * background driver it would steal the TUI out from under a live conversation, and
     * the operator can already see the pause via `status` and clear it via `continue`.
     */
    background?: boolean;
    /**
     * Graceful stop, read at every phase boundary. Distinct from `signal`: a stop must
     * not abort the child that is already running — pi-subagents cannot stop a workflow
     * run from here, so aborting only abandons it while it keeps editing the tree. The
     * signal is reserved for the operator's second, explicit hard stop.
     */
    shouldStop?: () => boolean;
  },
  log: Log,
): Promise<string> {
  const cwd = ctx.cwd;
  const rpc = makeRpc(pi);
  // Snapshotted here, not read per child: a batch runs for hours and the operator may switch
  // the conversation's model mid-run. "Inherit the current session" has to mean the session
  // that STARTED the run, or two children of one item silently disagree.
  const session = sessionChildConfig(ctx);

  /**
   * Which pipeline this run drives. One kind per invocation, and the reason is one-writer-per-tree:
   * two pipelines alternating in the same working tree means one item's `git add -A` can swallow
   * the other's half-finished state. `opts.only` overrides it — an explicit id is unambiguous, and
   * without that override every `continue` / `reset` command a bug item's own messages print would
   * filter that item out and report "finished. 0 of 0".
   */
  const inScope = (i: QueueItem): boolean => (opts.only ? i.id === opts.only : kindOf(i) === (opts.kind ?? "fr"));

  if (opts.dryRun) {
    const q = loadQueue(cwd);
    const progress = loadProgress(cwd);
    const todo = q.items.filter((i) => !isDone(statusOf(progress, i.id)) && inScope(i));
    if (todo.length === 0) return `fr-batch: nothing to do — every kind:"${opts.kind ?? "fr"}" item is committed or skipped.`;
    // Capped for the same reason `status` is: a long queue's dry run is read to check the
    // NEXT few items and the config, never to re-read row 200.
    const shown = todo.slice(0, DRYRUN_ROWS);
    return [
      `fr-batch: dry run — ${todo.length} item(s) would run, in this order${shown.length < todo.length ? ` (first ${shown.length} shown)` : ""}:`,
      ...shown.map((i, n) => {
        const v = verifyFor(q, i);
        return `  ${n + 1}. ${i.id}  [${statusOf(progress, i.id)}]  ${kindOf(i) === "bug" ? "bug " : ""}${i.plan}  verify:${v.isDefault ? "default" : `${v.cmds.length} cmd(s)`}  model:${itemModelLabel(q, i, session)}`;
      }),
      ...(shown.length < todo.length ? [`  ⋯ ${todo.length - shown.length} more, ending at ${todo[todo.length - 1].id}`] : []),
      "",
      `armed: ${q.armed} · maxFixRounds: ${q.maxFixRounds} · childTimeoutMs: ${q.childTimeoutMs}`,
      `session inherit: ${modelLabel(session)}`,
      "",
      "The queue is re-read at every item boundary, so items appended while this runs are picked up.",
    ].join("\n");
  }

  if (!loadQueue(cwd).armed) {
    return [
      "fr-batch: REFUSED — queue is not armed.",
      "",
      `Set \`"armed": true\` in ${queuePath(cwd)} when you actually want the batch`,
      "to write to this repo, and make sure no other session is working in it (the implementer edits",
      "the tree in place; two writers corrupt each other).",
    ].join("\n");
  }

  // Clean-tree guard, but ONLY when nothing is mid-flight. A paused or partially
  // processed item legitimately leaves its changes in the tree — that is exactly
  // what makes `continue` able to pick up where it stopped instead of redoing the
  // work. Enforcing cleanliness there would make a network pause unrecoverable.
  {
    const q0 = loadQueue(cwd);
    const p0 = loadProgress(cwd);
    // THE SAME TWO PREDICATES AS THE LOOP BELOW, and both halves are load-bearing.
    //
    // `inScope`: without it, an item of the OTHER kind that is paused or blocked becomes `next`,
    // `nextStatus` is not "pending", the dirty-tree refusal is skipped, and this run's first item
    // implements over that item's abandoned edits — which `git add -A` then commits under this
    // item's message. Symmetrically, an other-kind item legitimately resuming gets refused.
    //
    // `isDone`: a `skipped` item is at rest but is not "committed", so a `!== "committed"` find
    // stops on it and reports its status as `nextStatus`, skipping the refusal the same way.
    const next = q0.items.filter(inScope).find((i) => !isDone(statusOf(p0, i.id)));
    const nextStatus = next ? statusOf(p0, next.id) : "pending";
    if (nextStatus === "pending") {
      const status0 = await pi.exec("git", ["status", "--porcelain"], { cwd });
      if ((status0.stdout ?? "").trim().length > 0) {
        return [
          "fr-batch: REFUSED — working tree is dirty.",
          "",
          "Each item commits exactly its own PLAN's changes, so the tree must be clean before a",
          "fresh item starts. Commit, stash, or discard the current changes first.",
          "",
          (status0.stdout ?? "").trim().split("\n").slice(0, 20).join("\n"),
        ].join("\n");
      }
    } else {
      // Resuming: the tree is expected to hold this item's in-progress work.
    }
  }

  const lock = acquireRunlock(cwd);
  if ("held" in lock) {
    return `fr-batch: REFUSED — another driver holds the run lock (${lock.held}). Delete ${runlockPath(cwd)} if that process is gone.`;
  }

  // EACH ITEM COMMITS WITH `git add -A`, so anything this driver writes inside the repo lands in
  // the user's history unless the repo ignores it. Both trees are ours and neither belongs in a
  // PLAN's commit: `.pi/fr-batch/` holds the queue, the progress file, the frozen contract and the
  // ledger; `.pi-subagents/` holds child transcripts at ~1-2MB each. Checked once per run, before
  // anything is written, because a commit that already swallowed them cannot be un-made by this
  // driver.
  {
    const unignored: string[] = [];
    for (const p of [".pi", ".pi-subagents"]) {
      // Queried WITH a trailing slash, which is not cosmetic: `git check-ignore .pi-subagents`
      // exits 1 against a `/.pi-subagents/` rule while the directory does not exist yet, because
      // git cannot know a nonexistent path is a directory and a dir-only pattern then cannot
      // match. Measured on ange, whose .gitignore has exactly that rule. A trailing slash matches
      // both spellings of the rule (`/.pi` and `/.pi/`), so it is the correct probe in all cases.
      const r = await pi.exec("git", ["check-ignore", "-q", `${p}/`], { cwd });
      if (r.code !== 0) unignored.push(p);
    }
    if (unignored.length > 0) {
      lock.release();
      return [
        `fr-batch: REFUSED — this repo does not ignore ${unignored.join(" or ")}.`,
        "",
        "Every item commits with `git add -A`, so the driver's own state would be committed into",
        "your history: the queue and progress files, each item's frozen audit contract and gap",
        "ledger, and every child's transcript (~1-2MB per spawn).",
        "",
        "Fix, once:",
        ...unignored.map((p) => `  echo '/${p}/' >> .gitignore`),
        "",
        "Then commit that .gitignore change and re-run.",
      ].join("\n");
    }
  }

  const dir = artifactDir(cwd);
  let committed = 0;

  /** Non-null at a phase boundary the operator asked us not to cross. */
  const stopNow = (where: string): string | null => {
    if (opts.signal?.aborted) {
      return [
        `fr-batch: HARD STOPPED ${where}. ${committed} item(s) committed.`,
        "",
        "Progress is saved, so the next run resumes from the recorded phase.",
      ].join("\n");
    }
    if (opts.shouldStop?.()) {
      return [
        `fr-batch: stopped on request ${where}. ${committed} item(s) committed.`,
        "",
        'Nothing was lost — progress is saved. Resume with fr_batch action "run".',
      ].join("\n");
    }
    return null;
  };

  try {
    // The outer loop re-reads queue.json every iteration. That is what makes a
    // live append work: a new item added while an earlier one is running is
    // simply present the next time we look.
    for (;;) {
      {
        const s = stopNow("at an item boundary");
        if (s) return s;
      }

      const q = loadQueue(cwd);
      const policy = transientPolicy(q);
      // A quota/rate-limit refusal gets its OWN budget: it recovers when a window rolls over,
      // not in the seconds a transport fault takes, and sharing one budget paused the batch
      // for a condition that fixes itself.
      const quotaPolicy = transientQuotaPolicy(q);
      if (!q.armed) {
        return `fr-batch: graceful stop — queue was disarmed mid-run. ${committed} item(s) committed. Re-arm and re-run to continue.`;
      }

      // Re-read after the re-entry below, not mutated in place: that path WRITES a new status and
      // everything after it reads this snapshot. Letting the two drift meant a re-entered item was
      // still `blocked` here, so `st === "pending" || "implementing"` was false and implement was
      // skipped entirely — the phase was recorded correctly and then never consulted.
      let progress = loadProgress(cwd);
      const candidates = q.items.filter(inScope);
      const item = candidates.find((i) => !isDone(statusOf(progress, i.id)));
      if (!item) {
        const total = candidates.length;
        const skipped = candidates.filter((i) => statusOf(progress, i.id) === "skipped").length;
        const kindLabel = opts.only ? `matching only:"${opts.only}"` : `kind:"${opts.kind ?? "fr"}"`;
        return (
          `fr-batch: finished. ${committed} item(s) committed this run; ` +
          `${total - skipped} of ${total} ${kindLabel} item(s) are committed${skipped ? `, ${skipped} skipped` : ""}.`
        );
      }
      if (statusOf(progress, item.id) === "blocked" && (progress[item.id]?.note ?? "").length > 0) {
        const spec = kindOf(item) === "bug" ? "captured baseline" : "frozen contract";
        const scope = progress[item.id]?.blockScope ?? "verdict";
        // An `attempt`-scoped block is re-entered by a PLAIN run: nothing about the contract or the
        // phase was invalidated, the attempt simply did not happen. Only a `verdict` block needs the
        // operator to assert that their fix left the spec standing.
        if (scope === "attempt" || (opts.resumeBlocked && opts.only === item.id)) {
          // Not a silent retry: the operator named this exact item and asserted the cause is dealt
          // with. The phase and the spec are still on disk, so this re-enters where it stopped.
          log(
            scope === "attempt"
              ? `  re-entering a blocked item whose ATTEMPT failed (nothing was invalidated) over the files on disk`
              : `  resuming a blocked item on the operator's instruction — re-entering over the files on disk`,
          );
          setProgress(cwd, item.id, {
            status: progress[item.id]?.pausedPhase === "implement" ? "implementing" : "verifying",
            note: `${scope === "attempt" ? "Re-entered after a failed attempt" : "Resumed by the operator after a block"}. Previous note: ${progress[item.id]?.note ?? ""}`.slice(0, 4000),
          });
          progress = loadProgress(cwd);
        } else {
          return [
            `fr-batch: STOPPED — ${item.id} is blocked from an earlier run.`,
            "",
            progress[item.id]?.note ?? "",
            "",
            "A block is STICKY: re-running does not retry it, because the recorded phase and this",
            `item's ${spec} are still on disk and the driver will not guess which of them the`,
            "fix invalidated. Once you have fixed the cause, choose deliberately:",
            "",
            `  fr_batch action "continue", only: "${item.id}"   — KEEPS the work: re-enters the recorded`,
            "       phase over the files already in the tree. Use this when you fixed the cause and the",
            `       ${spec} still describes what you want.`,
            `  fr_batch action "reset", only: "${item.id}"      — starts over and re-captures the ${spec}.`,
            "       It does NOT clean the tree, so commit, stash or discard this item's changes first or",
            "       the next run refuses them as a dirty tree.",
            `  fr_batch action "remove", only: "${item.id}"     — drops it from the queue instead.`,
          ].join("\n");
        }
      }

      log(`\n=== ${item.id} — ${item.plan}`);
      // Model + effort resolved ONCE per item, so the log, the four spawns and `status` cannot
      // disagree. An item that configures nothing lands on the session snapshot.
      const roleCfg = (role: ChildRole): ChildConfig => resolveChildConfig(q, item, role, session);
      const spawnFor = (role: ChildRole): { model?: string } => childSpawnParams(roleCfg(role));
      log(`  model: ${itemModelLabel(q, item, session)}`);
      // A bug item spawns only the fixer and the scoper (which reuses the `auditor` role), so warning
      // about `implementer` would name a child that never runs. Roles are model/effort selectors
      // shared between the two pipelines; this is the one place that difference is visible.
      const rolesInPlay = kindOf(item) === "bug" ? CHILD_ROLES.filter((r) => r !== "implementer") : CHILD_ROLES;
      for (const role of rolesInPlay) {
        const cfg = roleCfg(role);
        if (effortUndeliverable(cfg)) {
          log(`  WARNING: ${role} thinking:${cfg.thinking} is NOT applied — no model resolved to carry it. Set queue.defaultModel.`);
        }
      }
      const block = (why: string, scope: "verdict" | "attempt" = "verdict", phase?: Phase): string => {
        // The phase is recorded because an `attempt` block is re-entered WHERE IT STOPPED. Without it
        // every re-entry landed at verify, so a failed IMPLEMENTER was re-entered by skipping implement
        // entirely — the item would verify a tree nobody had written.
        setProgress(cwd, item.id, { status: "blocked", note: why, blockScope: scope, ...(phase ? { pausedPhase: phase } : {}) });
        pi.appendEntry("fr-batch", { item: item.id, status: "blocked", note: why });
        log(`  BLOCKED: ${why}`);
        return [
          `fr-batch: STOPPED at ${item.id}. ${committed} item(s) committed before it.`,
          "",
          why,
          "",
          "The working tree still holds this item's changes — nothing was committed.",
          "Later items were not started (they depend on this one landing).",
          `Fix, then re-run. To redo from scratch: fr_batch action "reset", only: "${item.id}".`,
        ].join("\n");
      };

      const st = statusOf(progress, item.id);
      const fixRoundsSoFar = progress[item.id]?.fixRounds ?? 0;
      const wasPaused = st === "paused";
      const pausedPhase = progress[item.id]?.pausedPhase;
      const pausedChildId = progress[item.id]?.pausedChildId;
      const pauseKind = progress[item.id]?.pauseKind ?? "network";

      // A DECISION pause cannot resume itself. Reviving the child without the answer it asked
      // for makes it ask the same question again and burn another child, so the answer is a
      // precondition and the question is restated here rather than being left in a file.
      if (wasPaused && pauseKind === "decision" && !opts.answer?.trim()) {
        return [
          `fr-batch: WAITING FOR YOUR DECISION on ${item.id} (paused at "${pausedPhase}").`,
          "",
          "The child stopped because it hit a question it is not allowed to guess at. Its question:",
          "",
          progress[item.id]?.pendingAsk ?? "(question not recorded)",
          "",
          (progress[item.id]?.note ?? "").trim(),
          "",
          "Nothing was committed and the child's session is preserved. Decide, then deliver it:",
          `  fr_batch action "continue", only: "${item.id}", answer: "<your decision>"`,
          "",
          "The answer revives THAT child with its context and its already-written files intact.",
          `If the PLAN itself is wrong, fix the PLAN and redo the item: fr_batch action "reset", only: "${item.id}".`,
        ]
          .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
          .join("\n");
      }
      if (wasPaused) {
        log(`  continuing from a ${pauseKind} pause at "${pausedPhase}"${pausedChildId ? ` (reviving child ${pausedChildId})` : ""}`);
        if (pauseKind === "decision") log("  delivering the supervisor's decision to the revived child");
      }

      // Pre-flight: a PLAN with no test matrix is refused BEFORE any child is spawned. Once the
      // contract is frozen the freeze is the authority, so this only gates a fresh item.
      // FR ONLY: a bug item's spec is a report plus an already-red pin, and it has its own
      // pre-flight inside runBugItem — running this one would block every bug item for lacking a
      // test matrix it is not supposed to have.
      if (kindOf(item) === "fr" && !existsSync(contractPath(cwd, item.id))) {
        const gate = await planTestGate(pi, cwd, item);
        if (!gate.ok) return block(gate.why);
      }

      /**
       * Persist the pause and ask the human. An attended TUI session continues
       * immediately; an unattended one degrades to a resumable pause rather than
       * silently holding the turn open forever.
       *
       * Returns true when the operator said continue, so the caller retries.
       */
      const handlePause = async (phase: Phase, e: NetworkPause, round: number): Promise<boolean> => {
        setProgress(cwd, item.id, {
          status: "paused",
          fixRounds: round,
          pausedPhase: phase,
          pausedChildId: e.childId,
          pausedRound: round,
          pauseKind: "network",
          note: `Network unreachable during ${phase}: ${e.message}`,
        });
        pi.appendEntry("fr-batch", { item: item.id, status: "paused", phase, reason: e.message });
        log(`  PAUSED: ${e.message}`);
        if (!ctx.hasUI || opts.background) return false;
        const ok = await ctx.ui.confirm(
          `fr-batch paused — ${item.id}`,
          `${e.message}\n\nPhase: ${phase}. Nothing was committed and the child's work is preserved.\nFix the connection, then choose Continue to restart the retry process.`,
          { timeout: 10 * 60 * 1000 },
        );
        if (ok) log("  operator said continue — restarting the retry process");
        return ok;
      };

      const pausedReturn = (phase: Phase): string =>
        [
          `fr-batch: PAUSED at ${item.id} (${phase}). ${committed} item(s) committed before it.`,
          "",
          // Read back from disk, not from the snapshot this iteration started with: the note that
          // explains the pause was written by handlePause AFTER that snapshot was taken, so the
          // in-memory copy still holds the pre-pause note (usually none) and this message used to
          // fall back to a generic line that named no signature.
          loadProgress(cwd)[item.id]?.note ?? "Network unreachable after the configured retries.",
          "",
          "Nothing was committed. The child's session is preserved, so continuing revives it",
          "instead of redoing the work.",
          "",
          `When the network is back: fr_batch action "continue"  (or /fr-batch run).`,
        ].join("\n");

      /**
       * The driver has stopped supervising a child that may still be alive.
       *
       * ONE PATH FOR BOTH WAYS THAT HAPPENS — an operator's hard stop and the wallclock expiring — because
       * the correct response is identical and only the hard stop had it. (A `/reload` is a third cause
       * but not a third path: it aborts, so it arrives here as a stop.) The
       * timeout used to `block()`, which is sticky, says nothing about the loose child, and invites an
       * immediate re-run into a tree two children are writing. Reported from a real batch four times:
       * an abandoned child still editing the tree, its orphaned build colliding with the operator's
       * over one `build/` directory, a 40-minute test run competing for the same result files, and two
       * orphans at 2h47m and 48m burning CPU. Their parent was pid 1; the driver could not see them.
       *
       * The driver CANNOT kill them: pi-subagents' RPC `stop` refuses a running workflow and children
       * are workflows. So what it owes is the truth and the handle — `runId` is the one thing that
       * works (`subagent interrupt <id>`), and the operator had to hunt PIDs for want of it.
       *
       * NO `pausedChildId` is recorded, deliberately: reviving a child that may still be alive would
       * put two writers in one tree.
       */
      const abandonChild = (
        phase: Phase,
        round: number,
        // No "reload" case: a reload does not reach here. index.ts aborts the loop and RETIRES the
        // driver, so the abort arrives as a hard stop — see LiveDriver.retired for why the two cannot
        // share one mechanism. A third label would only be a name for a path nothing takes.
        cause: { kind: "stopped" | "timeout"; detail: string; runId?: string },
      ): string => {
        // The label is the ONLY place the cause survives: one pauseKind covers both, because what matters
        // downstream is that a child was ABANDONED rather than asked to stop. `status` reads this word back
        // out of the note to tell a budget expiring from the operator's keystroke — a contract, not prose.
        const label = cause.kind === "stopped" ? "HARD STOPPED" : "TIMED OUT";
        setProgress(cwd, item.id, {
          status: "paused",
          fixRounds: round,
          pausedPhase: phase,
          pausedRound: round,
          // One kind for all three: what matters downstream is that a child was abandoned rather than
          // asked to stop, and `resumeFor` must not revive it.
          pauseKind: "stopped",
          note: [
            `${label} during ${phase}: ${cause.detail}`,
            "The child was ABANDONED, not killed — this driver cannot stop a running workflow, so it may",
            "still be editing this tree.",
            ...(cause.runId ? [`Stop it with:  subagent interrupt ${cause.runId}`] : []),
          ].join("\n"),
        });
        pi.appendEntry("fr-batch", { item: item.id, status: "paused", phase, reason: cause.kind, runId: cause.runId });
        log(`  ${label} during ${phase} — child abandoned${cause.runId ? ` (${cause.runId})` : ""}`);
        return [
          `fr-batch: ${label} at ${item.id} (${phase}). ${committed} item(s) committed before it.`,
          "",
          cause.detail,
          "",
          "The child that was in flight was ABANDONED, not killed: this driver cannot stop a running",
          "workflow, so it may keep running and keep writing to this tree. Let it settle before starting",
          "another run — two children in one tree corrupt each other, and its orphaned build or test run",
          "will fight yours over the same output directories.",
          ...(cause.runId
            ? ["", `To stop it now:  subagent interrupt ${cause.runId}`]
            : ["", "No run id was captured, so find it with `/subagents` or by process."]),
          "",
          `Nothing was committed. Resume with fr_batch action "run" — it re-enters "${phase}" over the`,
          `files already on disk. To start the item over instead: fr_batch action "reset", only: "${item.id}".`,
        ].join("\n");
      };

      /**
       * A child never produced an outcome. THREE cases, decided once here rather than four times at
       * the call sites, which is how the timeout came to behave differently from the hard stop.
       *
       *   the operator hard-stopped   -> abandoned (paused, resumable)
       *   the wallclock expired       -> abandoned (paused, resumable). The child is STILL RUNNING;
       *                                  blocking here was the reported defect, because a block is
       *                                  sticky and says nothing about the loose process.
       *   anything else               -> a real launch failure: the attempt did not happen, so it is
       *                                  an `attempt`-scoped block that a plain `run` may re-enter.
       */
      const childLaunchFailure = (phase: Phase, round: number, who: string, e: Error): string => {
        const c = classifyLaunchFailure(e, Boolean(opts.signal?.aborted));
        if (c.kind === "stopped") return abandonChild(phase, round, { kind: "stopped", detail: "The operator asked for a hard stop." });
        if (c.kind === "timeout") {
          return abandonChild(phase, round, {
            kind: "timeout",
            detail: `${who} outlived its budget (queue.childTimeoutMs). Nothing stopped it.`,
            runId: c.runId,
          });
        }
        return block(`${who} failed to run: ${e.message}`, "attempt", phase);
      };

      /**
       * A child asked for a decision, or was detached waiting for one. Pause the item and
       * return the QUESTION — this is the notification path that was missing: previously the
       * child was detached by pi-subagents with `status: "paused"`, the driver blocked the item
       * with `Implementer ended with status "paused"`, and the question existed only inside the
       * child's own report.
       *
       * Returns null when the child raised no decision ask, so callers can chain it.
       */
      const decisionStop = (phase: Phase, o: ChildOutcome, round: number): string | null => {
        const asks = o.decisionAsks ?? [];
        const detached = INTERCOM_DETACH_MARK.test(`${o.error ?? ""} ${o.summary ?? ""}`) || o.status === "detached";
        if (asks.length === 0 && !detached) return null;
        const question =
          asks.length > 0
            ? asks.map(formatAsk).join("\n\n")
            : "  (the child was detached waiting for the supervisor, and its request file was already gone —\n  read its report below for the question)";
        const reportHint = o.artifactPath ? `Child's report: ${o.artifactPath}` : "";
        setProgress(cwd, item.id, {
          status: "paused",
          fixRounds: round,
          pausedPhase: phase,
          pausedChildId: o.asyncId,
          pausedRound: round,
          pauseKind: "decision",
          pendingAsk: question,
          note: `The ${phase} child needs a supervisor decision it is not allowed to guess at.`,
        });
        pi.appendEntry("fr-batch", { item: item.id, status: "paused", phase, reason: "decision-needed", question: question.slice(0, 2000) });
        log(`  DECISION NEEDED at ${phase} — batch stopped, question surfaced`);
        return [
          `fr-batch: DECISION NEEDED at ${item.id} (${phase}). ${committed} item(s) committed before it.`,
          "",
          "The child stopped because it hit a question only you can answer. Verbatim:",
          "",
          question,
          "",
          `Child status: ${o.status}. ${o.summary ? o.summary.slice(0, 400) : ""}`,
          reportHint,
          "",
          "Nothing was committed; the child's work is in the working tree and its session is preserved.",
          "",
          "Answer it — this revives that exact child, it does not redo the work:",
          `  fr_batch action "continue", only: "${item.id}", answer: "<your decision>"`,
          "",
          `If the PLAN is what is wrong, fix the PLAN first, then: fr_batch action "reset", only: "${item.id}".`,
        ]
          .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
          .join("\n");
      };

      /**
       * Resume options for a child of `phase`. Carries the operator's answer on a decision
       * pause, so the revived child is told the decision instead of being told the network is
       * back — which is what it would have heard before, and it would simply ask again.
       */
      const resumeFor = (phase: Phase): { resumeOf?: string; resumeMessage?: string } => {
        if (!wasPaused || pausedPhase !== phase || !pausedChildId) return {};
        if (pauseKind === "stopped") return {}; // see abandonChild: that child was abandoned, not resumable
        if (pauseKind !== "decision") return { resumeOf: pausedChildId };
        return {
          resumeOf: pausedChildId,
          resumeMessage: [
            "SUPERVISOR DECISION — this is the answer to the question you stopped on:",
            "",
            (opts.answer ?? "").trim(),
            "",
            "It is binding. Continue exactly where you left off; do not restart the task and do not",
            "re-derive the decision. If it makes a PLAN row unsatisfiable, say so in your report.",
          ].join("\n"),
        };
      };

      // ---- kind:"bug" takes the whole per-item pipeline -------------------
      //
      // Shared by both pipelines so the commit block can report it.
      let round = fixRoundsSoFar;
      //
      // Dispatch follows THE ITEM'S kind, never `opts.kind`. Those are different questions:
      // `opts.kind` chose which items this run considers, and `only` overrides it — so an
      // `only:"<bug id>"` run started by that item's own `continue` command arrives here with
      // `opts.kind === "fr"` and must still get the bug pipeline.
      if (kindOf(item) === "bug") {
        const r = await runBugItem({
          pi,
          rpc,
          cwd,
          item,
          q,
          log,
          dir,
          policy,
          quotaPolicy,
          signal: opts.signal,
          fixRoundsSoFar,
          spawnFor,
          block,
          handlePause,
          pausedReturn,
          childLaunchFailure,
          decisionStop,
          resumeFor,
          stopNow,
          // Passed rather than imported: this file must import bug_pipeline.ts, so the reverse edge
          // would be a cycle probe_modules.ts fails the suite on. Neither is a closure — they are
          // module-level exports here — but moving them to a leaf would make mutation.mjs's
          // childOutcomeFailure row match nothing and exit 1.
          runVerify,
          childOutcomeFailure,
        });
        if (r.outcome === "return") return r.text;
        if (r.outcome === "skipped") continue;
        round = r.rounds;
        // falls through to the shared commit block
      } else {

      // ---- 1. implement (skip if a previous run already got past it) ------
      if (st === "pending" || st === "implementing" || (wasPaused && pausedPhase === "implement")) {
        setProgress(cwd, item.id, { status: "implementing" });
        log("  implement…");
        let impl: ChildOutcome | undefined;
        for (;;) {
          try {
            impl = await runChildResilient(
              pi,
              rpc,
              // `loadProgress`, not the loop's snapshot: the re-entry above WRITES a note ("Re-entered after a
              // failed attempt. Previous note: …") and this is the child that most needs to read it. The two
              // sibling call sites already re-read; this one did not, so an implementer re-entering a half-written
              // tree was the only child told nothing about why.
              { agent: "fr-implementer", ...spawnFor("implementer"), task: implementTask(item, q, loadProgress(cwd)[item.id]?.note), context: "fresh", output: join(dir, `${item.id}-implement.md`) },
              q.childTimeoutMs,
              opts.signal,
              policy,
              log,
              { ...resumeFor("implement"), quotaPolicy },
            );
            break;
          } catch (e) {
            if (e instanceof NetworkPause) {
              if (await handlePause("implement", e, fixRoundsSoFar)) continue;
              return pausedReturn("implement");
            }
            return childLaunchFailure("implement", fixRoundsSoFar, "The implementer", e as Error);
          }
        }
        // A decision ask outranks the status check: a child told to stop and write its question
        // down ends "complete" with the work unfinished, and blocking on the status alone would
        // report "changed no files" or a green item instead of the question.
        const implDecision = decisionStop("implement", impl, fixRoundsSoFar);
        if (implDecision) return implDecision;
        const implFailure = childOutcomeFailure("Implementer", impl);
        if (implFailure) return block(implFailure, "attempt", "implement");
        const after = await pi.exec("git", ["status", "--porcelain"], { cwd });
        if ((after.stdout ?? "").trim().length === 0) {
          // Phase recorded even though this is a VERDICT block. Scope decides whether a bare `run` may
          // re-enter; phase decides WHERE the operator's `continue only:<id>` lands. Without it this one
          // resumed at the verify gate over a tree the implementer had provably not touched — the one case
          // where re-entering at verify is certainly wrong.
          return block("Implementer reported success but changed no files. Treating as a failure, not a no-op success.", "verdict", "implement");
        }
      } else {
        log(`  resuming at "${st}" (${fixRoundsSoFar} fix round(s) already spent)`);
      }

      // ---- 2. verify → 3. audit → bounded fix loop ------------------------
      const { cmds: verifyCmds, isDefault } = verifyFor(q, item);
      if (isDefault) log(`  (using queue.defaultVerify — ${verifyCmds.length} cmd(s))`);

      round = fixRoundsSoFar;
      // Frozen before the first audit and reused for every round after it. This is the
      // whole convergence mechanism: the checklist cannot grow while it is being audited.
      const contract = await freezeContract(pi, cwd, item, log);
      // Read-only context for the auditor's second job: nobody reviews the verify commands today, so
      // a line asserting a pre-change value cannot be contradicted by anything.
      const acceptance = extractAcceptanceSection((await readPlanText(pi, cwd, item.plan)).text);
      // Consecutive unparseable-verdict retries at the CURRENT round. Reset on any
      // parseable verdict; never consumes a fix round.
      let auditAttempt = 0;
      // Consecutive rounds whose fixer closed nothing and rejected nothing. THIS is what the budget
      // bounds — see Queue.maxFixRounds. A productive round resets it to zero.
      //
      // Read from progress and written back every round, like fixRounds: a counter that lived only
      // here reset on every re-entry, so looping `continue` on a stuck item would hand it unlimited
      // barren rounds — and re-entry is exactly what the blocked-item escape hatch makes cheap.
      let barren = progress[item.id]?.barrenRounds ?? 0;
      // Rejections the PREVIOUS round's fixer recorded. A rejection is work: it settles a gap
      // durably, so a round that only rejected is not barren.
      let lastRejections = 0;
      for (;;) {
        {
          const s = stopNow(`inside ${item.id} (after ${round} fix round(s))`);
          if (s) return s;
        }

        setProgress(cwd, item.id, { status: "verifying", fixRounds: round });
        log(`  verify (after ${round} fix round(s))…`);
        const v = await runVerify(pi, cwd, verifyCmds, q.verifyTimeoutMs, log);
        if (!v.ok) {
          // Rounds, not barren rounds, and deliberately: here the fixer is handed ONE concrete
          // failing command with its output. A round that leaves it failing produced nothing by
          // definition, so the two counts coincide and a second mechanism would only add surface.
          if (round >= q.maxFixRounds) {
            // Re-enters at fix-verify, not implement: the implementation exists and the gate is red, so the
            // next step is a fixer with that failure in hand, which is exactly this loop.
            return block(`Verify failed after ${round} fix round(s): \`${v.cmd}\` exited ${v.code}.\n\n${v.tail}`, "verdict", "fix-verify");
          }
          round += 1;
          setProgress(cwd, item.id, { status: "fixing", fixRounds: round });
          log(`  verify RED — fix round ${round}/${q.maxFixRounds}`);
          const fixVerifyTask = `The build/test gate for this FR PLAN is RED. Fix it.

Read:
${readsBlock(item)}

Failing command: \`${v.cmd}\` (exit ${v.code})

Tail of its output:
\`\`\`
${v.tail}
\`\`\`

Fix the cause, not the symptom: do not delete or weaken a test to make the command pass. If the
test is right and the implementation is wrong, fix the implementation. Do NOT commit.${rulesBlock(q)}${noteBlock(loadProgress(cwd)[item.id]?.note)}`;
          let fixVerify: ChildOutcome | undefined;
          for (;;) {
            try {
              fixVerify = await runChildResilient(
                pi,
                rpc,
                { agent: "fr-gap-fixer", ...spawnFor("fixer"), context: "fresh", output: join(dir, `${item.id}-fix-verify-${round}.md`), task: fixVerifyTask },
                q.childTimeoutMs,
                opts.signal,
                policy,
                log,
                { ...resumeFor("fix-verify"), quotaPolicy },
              );
              break;
            } catch (e) {
              if (e instanceof NetworkPause) {
                if (await handlePause("fix-verify", e, round)) continue;
                return pausedReturn("fix-verify");
              }
              return childLaunchFailure("fix-verify", round, "The fixer (after a red verify)", e as Error);
            }
          }
          const fixVerifyDecision = decisionStop("fix-verify", fixVerify, round);
          if (fixVerifyDecision) return fixVerifyDecision;
          // A fixer that never ran cannot have fixed anything, and looping back to verify would
          // spend another round rediscovering the same red gate.
          const fixVerifyFailure = childOutcomeFailure("Fixer (red verify)", fixVerify);
          if (fixVerifyFailure) return block(fixVerifyFailure, "attempt", "fix-verify");
          continue;
        }
        log("  verify GREEN");

        // The audit is retried WITHOUT re-running verify. An unparseable verdict is the auditor's
        // transport failing, and the gate that just passed cannot have become red in between — so
        // looping back to the top would re-spend the whole verify budget (a full compile plus the
        // suite, up to verifyTimeoutMs PER COMMAND) twice to re-ask one question. Hence this inner
        // loop: only the auditor re-runs.
        let verdict!: AuditVerdict;
        // TWO PATHS, TWO EXTENSIONS. The auditor runs `outputMode: "file-only"`, so what lands in its
        // output file is the child's PROSE narration — the schema-valid verdict arrives separately on
        // the completion event. Naming that file `.json` was a lie a downstream reader pays for:
        // reported from a real batch, `<id>-audit-1.json` opened with "Audit done. Read every landed
        // test artifact…" and `json.load()` threw, while `-audit-0.json` was 55 bytes of the child's
        // first sentence. So the prose goes to `.md`, and the verdict is persisted to a file that
        // really is JSON.
        const narrationPath = join(dir, `${item.id}-audit-${round}.md`);
        const verdictPath = join(dir, `${item.id}-audit-${round}.verdict.json`);
        let rawPath = narrationPath;
        for (;;) {
          setProgress(cwd, item.id, { status: "auditing", fixRounds: round });
          log(auditAttempt > 0 ? `  audit (retry ${auditAttempt}/${AUDIT_PARSE_RETRIES})…` : "  audit…");
          let audit: ChildOutcome | undefined;
          for (;;) {
            try {
              audit = await runChildResilient(
                pi,
                rpc,
                {
                  agent: "fr-test-auditor",
                  ...spawnFor("auditor"),
                  context: "fresh",
                  task: auditTask(item, contract, loadLedger(cwd, item.id), verifyCmds, acceptance),
                  outputSchema: AUDIT_SCHEMA,
                  output: narrationPath,
                  outputMode: "file-only",
                },
                q.childTimeoutMs,
                opts.signal,
                policy,
                log,
                { ...resumeFor("audit"), quotaPolicy },
              );
              break;
            } catch (e) {
              if (e instanceof NetworkPause) {
                if (await handlePause("audit", e, round)) continue;
                return pausedReturn("audit");
              }
              return childLaunchFailure("audit", round, "The auditor", e as Error);
            }
          }

          const auditDecision = decisionStop("audit", audit, round);
          if (auditDecision) return auditDecision;

          // An auditor that did not RUN is an infrastructure failure, and it must be reported as
          // one here. Falling through to the verdict parser would classify it as an unparseable
          // verdict and then blame the schema for a bad install or a dead workflow.
          const auditFailure = childOutcomeFailure("Auditor", audit);
          if (auditFailure) return block(auditFailure, "attempt", "audit");

          // PREFER THE STRUCTURED OUTPUT. The auditor runs with an outputSchema, so
          // its schema-valid verdict arrives on the completion event; the artifact
          // FILE is where its prose narration lands. Reading the file first is why
          // this driver kept synthesising AUDIT-UNPARSEABLE and throwing away real
          // gaps. File and summary remain fallbacks for an auditor without a schema.
          const structured = audit.structuredOutput;
          rawPath = audit.artifactPath && existsSync(audit.artifactPath) ? audit.artifactPath : narrationPath;
          const raw = structured !== undefined && structured !== null
            ? JSON.stringify(structured)
            : existsSync(rawPath)
              ? readFileSync(rawPath, "utf8")
              : audit.summary;
          // Persisted so a later reader has the verdict WITHOUT re-deriving it from a workflow
          // receipt it no longer has. Written whenever it parsed, including the retry rounds, so the
          // file beside the narration always describes that narration.
          if (structured !== undefined && structured !== null) {
            writeAtomic(verdictPath, `${JSON.stringify(structured, null, 2)}\n`);
          }
          verdict = parseVerdict(raw);

          // AN UNPARSEABLE VERDICT IS A TRANSPORT FAILURE, NOT A COVERAGE GAP, so it
          // must never reach the ledger. Letting it in deadlocks the item: no fixer
          // can close "the auditor did not return a schema-valid verdict" — there is
          // no code seam to name and no edit that could go RED — so the convergence
          // check sees the same count every round and blocks forever. Both observed
          // causes were pure transport: once the child's prose landed in the output
          // slot, once a Bedrock outage streamed raw session JSONL where the schema
          // object belonged. In the second case a schema-valid audit had ALREADY
          // walked all 29 contract rows and returned `complete` with no gaps, and the
          // driver threw that away and blocked. Retry the audit instead; only give up
          // after AUDIT_PARSE_RETRIES, and then say it is infrastructure rather than
          // filing a gap the fixer is expected to close.
          const onlyUnparseable =
            verdict.gaps.length === 1 && (verdict.gaps[0].id ?? "").trim() === UNPARSEABLE_GAP_ID;
          if (!onlyUnparseable) {
            auditAttempt = 0;
            break;
          }
          if (auditAttempt >= AUDIT_PARSE_RETRIES) {
            return block(
              `Auditor returned an unparseable verdict ${AUDIT_PARSE_RETRIES + 1} time(s). This is the auditor's ` +
                `TRANSPORT, not a test gap: no gap was filed and the ledger is untouched. Raw head: ${raw.slice(0, 300)}`,
              "verdict",
              // Nothing was judged, so re-entry belongs at the audit. Re-running the whole verify gate
              // would repeat a green gate to recover from a transport failure.
              "audit",
            );
          }
          auditAttempt++;
          log(`  audit verdict unparseable (transport) — re-running the auditor only, ${auditAttempt}/${AUDIT_PARSE_RETRIES}`);
        }

        // Scope gate. An adversarial auditor asked to find gaps will always find one more;
        // only findings that name a row of the FROZEN contract may gate this item.
        const { blocking, outOfScope } = partitionGaps(verdict.gaps, contract);
        const verifyFindings = verdict.verify_findings ?? [];
        if (outOfScope.length > 0 || verdict.notes?.trim() || verifyFindings.length > 0) {
          recordOutOfScope(cwd, item, round, outOfScope, verdict.notes, verifyFindings);
          if (verifyFindings.length > 0) {
            log(`  ${verifyFindings.length} verify-gate disagreement(s) with the PLAN's acceptance text → recorded, NON-BLOCKING`);
          }
          if (outOfScope.length > 0) {
            log(`  ${outOfScope.length} finding(s) fell outside the frozen contract → non-blocking, recorded in ${item.id}.out-of-scope.md`);
          }
        }

        // Ledger: what was raised when, and what the previous round's fixer settled.
        const ledger = loadLedger(cwd, item.id);
        const nowIds = blocking.map((g) => (g.id ?? "").trim());
        const repeats = nowIds.filter((id) => (ledger[id]?.raisedRounds ?? []).length > 0);
        let closedNow = 0;
        for (const [id, e] of Object.entries(ledger)) {
          if (e.state === "open" && !nowIds.includes(id)) {
            e.state = "closed";
            closedNow++;
          }
        }
        for (const g of blocking) {
          const id = (g.id ?? "").trim();
          const e: LedgerEntry = ledger[id] ?? { kind: g.kind, what: g.what, raisedRounds: [], state: "open" };
          e.kind = g.kind;
          e.what = g.what;
          if (!e.raisedRounds.includes(round)) e.raisedRounds.push(round);
          e.state = "open";
          ledger[id] = e;
        }
        saveLedger(cwd, item.id, ledger);

        // Was the PREVIOUS fix round productive? Closures observed now are what that fixer actually
        // fixed; its rejections were applied to the ledger before this audit ran, so they are counted
        // from the variable rather than re-derived. Only meaningful once a fix round has happened.
        if (round > fixRoundsSoFar) {
          const productive = roundWasProductive(closedNow, lastRejections);
          barren = productive ? 0 : barren + 1;
          setProgress(cwd, item.id, { fixRounds: round, barrenRounds: barren });
          log(
            productive
              ? `  round ${round} was productive (${closedNow} closed, ${lastRejections} rejected) — barren streak reset`
              : `  round ${round} closed and rejected nothing — barren ${barren}/${q.maxFixRounds}`,
          );
        }
        lastRejections = 0;

        if (blocking.length === 0) {
          log(verdict.gaps.length > 0 ? `  audit COMPLETE (all ${verdict.gaps.length} finding(s) were out of contract)` : "  audit COMPLETE");
          break;
        }
        log(`  audit found ${blocking.length} in-contract gap(s)`);

        // Non-convergence guard. "Stop and show a human", never "spend another round": a loop that
        // re-litigates a settled row does not have a fixed point, and burning maxFixRounds only
        // hides that as a timeout.
        //
        // THERE USED TO BE A SECOND ONE HERE — block when this round's in-contract gap count did not
        // fall below the previous round's — and it was WRONG BY CONSTRUCTION, not merely noisy.
        // `repeats` is computed before the ledger is updated and returns above, so the count check
        // could only ever execute when `repeats` was EMPTY, i.e. when every gap this round had never
        // been raised before. Its firing condition was therefore: the fixer closed all N of the
        // previous round's gaps AND the auditor discovered N or more previously unexamined contract
        // rows. That is the best trajectory available, and it is the one that got blocked.
        //
        // The false premise was that an audit is exhaustive at round 0. It is not: an auditor
        // establishes coverage empirically, one row at a time, and a large matrix takes several
        // rounds to walk. Incremental discovery is the normal shape, not a runaway signal. Measured
        // on a real batch: a 16-row matrix was exhausted in one round with zero gaps, while a 71-row
        // one was still surfacing new rows in round 3 — and that item was stopped with two rounds of
        // budget left, then idled for hours waiting for a human, for converging correctly.
        //
        // Nothing replaced it, because every count-based variant is unreachable behind `repeats`:
        // if the ledger's distinct-id total did not grow, every id this round was already in it, so
        // every id has a non-empty raisedRounds, so `repeats` fired one guard earlier. `repeats`
        // plus `maxFixRounds` are jointly sufficient. (Nothing in the suite ever pinned the count
        // check, which is its own evidence: a suite this size never pinned a guard that could not
        // catch anything real.)
        if (repeats.length > 0) {
          const detail = repeats
            .map((id) => `  - ${id} (raised in round(s) ${(ledger[id]?.raisedRounds ?? []).join(", ")}${ledger[id]?.reason ? `; fixer had rejected it: ${ledger[id]?.reason}` : ""})`)
            .join("\n");
          return block(
            [
              `Audit is not converging: ${repeats.length} gap(s) already adjudicated in an earlier round are being raised again.`,
              "",
              detail,
              "",
              repeats.includes(UNPARSEABLE_GAP_ID)
                ? "AUDIT-UNPARSEABLE twice means the auditor agent or its outputSchema is misconfigured, not that the tests are thin."
                : "Either the fixer's closing test really is vacuous (then fix it by hand) or the auditor is re-litigating a settled row (then record the rejection in the ledger).",
              "",
              `Verdict: ${rawPath}`,
              `Ledger:  ${ledgerPath(cwd, item.id)}`,
            ].join("\n"),
            "verdict",
            // the gaps are real and adjudicated, so the operator's next move is a fixer round.
            "fix-audit",
          );
        }
        const list = () => blocking.map((g) => `  - [${g.id} · ${g.kind}] ${g.what}`).join("\n");
        if (barren >= q.maxFixRounds) {
          return block(
            [
              `Audit is stuck: ${barren} consecutive fix round(s) closed nothing and rejected nothing.`,
              "",
              list(),
              "",
              "The budget counts BARREN rounds, not rounds — an item that keeps closing gaps is never",
              "stopped for taking rounds to do it. This one stopped making progress.",
              "",
              `Full verdict: ${rawPath}`,
              `Ledger:  ${ledgerPath(cwd, item.id)}`,
            ].join("\n"),
            "verdict",
            // the ledger is intact; what stalled is the fixer, so re-entry belongs at the fix round.
            "fix-audit",
          );
        }
        if (round >= q.maxTotalRounds) {
          return block(
            [
              `Audit reached the total round cap: ${round} of ${q.maxTotalRounds} (queue.maxTotalRounds).`,
              "",
              list(),
              "",
              "Rounds were still productive, so this is a COST stop rather than a verdict: the loop was",
              "closing gaps and finding new ones. Raise maxTotalRounds to let it continue, or read the",
              "ledger to decide whether the remaining rows are worth the rounds.",
              "",
              `Full verdict: ${rawPath}`,
              `Ledger:  ${ledgerPath(cwd, item.id)}`,
            ].join("\n"),
            "verdict",
            // nothing is wrong with the audit — this is a cost stop, so resume where it stopped.
            "fix-audit",
          );
        }

        round += 1;
        setProgress(cwd, item.id, { status: "fixing", fixRounds: round });
        log(`  fix round ${round}/${q.maxFixRounds}`);
        const fixAuditTask = fixTask(item, blocking, verdict.notes, q, loadProgress(cwd)[item.id]?.note);
        const fixReportPath = join(dir, `${item.id}-fix-audit-${round}.json`);
        let fix: ChildOutcome | undefined;
        for (;;) {
          try {
            fix = await runChildResilient(
              pi,
              rpc,
              {
                agent: "fr-gap-fixer",
                ...spawnFor("fixer"),
                task: fixAuditTask,
                context: "fresh",
                outputSchema: FIX_SCHEMA,
                output: fixReportPath,
                outputMode: "file-only",
              },
              q.childTimeoutMs,
              opts.signal,
              policy,
              log,
              { ...resumeFor("fix-audit"), quotaPolicy },
            );
            break;
          } catch (e) {
            if (e instanceof NetworkPause) {
              if (await handlePause("fix-audit", e, round)) continue;
              return pausedReturn("fix-audit");
            }
            return childLaunchFailure("fix-audit", round, "The fixer (audit gaps)", e as Error);
          }
        }

        const fixAuditDecision = decisionStop("fix-audit", fix, round);
        if (fixAuditDecision) return fixAuditDecision;
        const fixAuditFailure = childOutcomeFailure("Fixer (audit gaps)", fix);
        if (fixAuditFailure) return block(fixAuditFailure, "attempt", "fix-audit");

        // Ingest the fixer's rejections. This is the only way an invalid gap dies: without it
        // the next audit re-raises it, and a re-raise now stops the batch.
        {
          const p = fix.artifactPath && existsSync(fix.artifactPath) ? fix.artifactPath : fixReportPath;
          const report = existsSync(p) ? parseFixReport(readFileSync(p, "utf8")) : null;
          if (!report) {
            log("  (fixer returned no parseable report — no rejection recorded)");
          } else if (report.rejected.length > 0) {
            const l = loadLedger(cwd, item.id);
            for (const r of report.rejected) {
              const id = r.id.trim();
              if (!l[id]) continue; // only gaps we actually raised can be rejected
              l[id].state = "rejected";
              l[id].reason = r.why;
            }
            saveLedger(cwd, item.id, l);
            lastRejections = report.rejected.length;
            log(`  fixer rejected ${report.rejected.length} gap(s) as invalid → recorded in the ledger`);
          }
        }
      }
      } // end of the FR branch

      // ---- 4. commit -----------------------------------------------------
      log("  commit…");
      const add = await pi.exec("git", ["add", "-A"], { cwd });
      if (add.code !== 0) return block(`git add failed: ${add.stderr}`);
      const msg = item.commitMsg ?? `feat: implement ${item.plan}`;
      const commit = await pi.exec("git", ["commit", "-m", msg], { cwd });
      if (commit.code !== 0) return block(`git commit failed: ${commit.stderr || commit.stdout}`);
      const sha = (await pi.exec("git", ["rev-parse", "--short", "HEAD"], { cwd })).stdout?.trim() ?? "?";

      setProgress(cwd, item.id, { status: "committed", fixRounds: round, sha, note: "" });
      pi.appendEntry("fr-batch", { item: item.id, status: "committed", sha, fixRounds: round });
      log(`  COMMITTED ${sha} (${round} fix round(s))`);
      pruneItemArtifacts(cwd, item.id, log);
      committed += 1;
    }
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// background driver — the run outlives the turn that started it
// ---------------------------------------------------------------------------
