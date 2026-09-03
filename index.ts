import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { rmSync } from "node:fs";
import { startDriver, stopDriver } from "./background.ts";
import { sessionChildConfig } from "./config.ts";
import { runBatch } from "./driver.ts";
import { runlockPath } from "./paths.ts";
import { addItem, archiveItems, removeItem, resetItem } from "./queue_ops.ts";
import { HISTORY_ROWS, renderHistory, renderStatus } from "./render.ts";
import { CHILD_ASK_TIMEOUT_MS } from "./resilience.ts";
import { drivers } from "./state.ts";
import { ITEM_KINDS, THINKING_EFFORTS } from "./types.ts";
import type { Log } from "./types.ts";

// ---------------------------------------------------------------------------
// fr-batch — sequential FR-PLAN executor with a mechanical test-completeness
// gate, and a queue that stays editable WHILE the batch runs.
//
// Per item:  implement → verify → audit → [fix → verify → audit]×N → commit
//
// `run` STARTS A BACKGROUND DRIVER AND RETURNS. pi delivers a queued user message only
// between assistant turns, so awaiting a multi-hour batch inside the tool call froze the
// supervising conversation for the whole batch — status, add, remove and stop were all
// unreachable from the session that started it. See the "background driver" section.
//
// PROJECT-AGNOSTIC BY CONSTRUCTION. Nothing here knows a build system. The three
// things that differ per repo all come from that repo:
//   * the verify gate           -> queue.json `verify` / `defaultVerify`
//   * repo-specific build traps -> the project's own context file, injected into
//                                  every child by `inheritProjectContext: true`,
//                                  plus optional queue.json `repoRules` emphasis
//   * which PLANs, in what order -> queue.json `items`
// Duplicating a project's build rules into this driver would be the drift the
// context-file injection exists to prevent.
//
// Two files, two owners. This split is the whole reason a live append is safe:
//
//   <cwd>/.pi/fr-batch/queue.json     YOURS.   items, order, armed, budgets, per-child
//                                              model + reasoning effort.
//                                              The driver only READS it.
//   <cwd>/.pi/fr-batch/progress.json  DRIVER'S. status/fixRounds/note/sha per id.
//                                              You only read it.
//   <cwd>/.pi/fr-batch/history.jsonl  APPEND-ONLY record of archived (committed) items.
//                                              Written by action "archive", never rewritten.
//
// BOTH HOT FILES ARE SIZED BY WORK IN FLIGHT, NOT BY PROJECT SIZE — that is what action
// "archive" is for. A repo with hundreds of PLANs that never archives pays for all of them
// on every single inspection: `status` is one row per item, and progress notes are prose.
// Measured on this extension's own ange queue: 409 B per queue item and a 354 B note per
// progress entry, so 300 items is ~123 KB of queue plus ~106 KB of notes, and a status
// render of ~300 lines. Archiving keeps the live pair at the size of the open batch and
// moves the finished record to a file nothing reads on the hot path.
//
// THE AUDIT LOOP TERMINATES BECAUSE ITS CONTRACT IS FROZEN. Three per-item files
// make the gap set shrink monotonically instead of chasing a moving target:
//
//   <id>.contract.md      the PLAN's `## Tests` matrix as committed at HEAD, before
//                         implementation. The ONLY source of blocking gaps.
//   <id>.gaps.json        adjudication ledger: every gap id ever raised, the rounds
//                         it was raised in, and whether it is open/closed/rejected.
//   <id>.out-of-scope.md  findings outside the frozen contract. Recorded for a
//                         follow-up FR; never blocking, never sent to the fixer.
//
// Without the freeze the loop has no fixed point: the fixer is told to keep the
// live PLAN's matrix truthful, and an auditor judged against the LIVE matrix then
// demands tests for the rows the previous fix round just added — and for every
// production branch that closing them introduced. Bounding the rounds hides that
// as "blocked after N rounds"; freezing the contract removes it.
//
// A single-file design cannot support live appends: the driver would write back
// its in-memory snapshot on every state transition and silently clobber whatever
// you appended in between. Separate files remove the shared-write entirely — no
// lock, no merge, no lost update.
//
// The driver re-reads queue.json at every item boundary, so an append lands on
// the next iteration. It never rewrites it.
//
// Subagents are spawned through pi-subagents' in-process RPC
// (src/extension/rpc.ts): request on `subagents:rpc:v1:request`, reply on
// `subagents:rpc:v1:reply:<id>`, completion on `subagent:async-complete`.
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // The child's contact_supervisor ask deadline is read from the env and defaults
  // to 10 minutes (native-supervisor-channel.ts:23, :181-184). Children inherit
  // this process's env, so raising it here is what lets the driver hold a child
  // blocked through a long outage instead of having its ask time out.
  if (!process.env.PI_INTERCOM_ASK_TIMEOUT_MS) {
    process.env.PI_INTERCOM_ASK_TIMEOUT_MS = String(CHILD_ASK_TIMEOUT_MS);
  }

  pi.registerTool({
    name: "fr_batch",
    label: "FR Batch",
    description:
      "Sequentially implement queued FR PLANs with a mechanical gate: implement → verify → adversarial test-completeness audit → bounded fix rounds → commit. Stops the batch on the first item that cannot pass. Action \"run\" starts a BACKGROUND driver and returns at once — this conversation stays usable, the queue can be edited while it runs, and the driver reports back on its own when it finishes, pauses, or needs a decision.",
    promptSnippet: "Start, inspect, extend, or stop the background FR-PLAN implementation batch",
    promptGuidelines: [
      'Use fr_batch action "status" to report batch progress instead of reading queue.json by hand. It is a SUMMARY — in-flight items plus the next few pending; pass all:true for every row, or only:"<id>" for one item in full including its note.',
      'Use fr_batch action "archive" once committed items pile up in the queue: it sweeps them into history.jsonl so the live queue stays the size of the OPEN batch. Read them back with action "history".',
      'Use fr_batch action "add" to queue another FR PLAN; it is safe while a run is in flight.',
      'Use fr_batch action "run" only when the user explicitly asks to execute the batch; it writes to the repo and commits.',
      'Action "run" returns as soon as the batch is running in the background. Do not poll "status" in a loop and do not re-run it: the driver sends its own result back to this conversation when it finishes, pauses, or needs a decision.',
      'Use fr_batch action "stop" when the user wants the batch to end; the first call lets the running child finish, a second call abandons it.',
      'Use fr_batch action "continue" when the user says to continue after a network pause; it restarts the retry process and revives the paused child.',
      'When fr_batch reports "DECISION NEEDED", relay the child\'s question to the user verbatim, then deliver the decision with action "continue" plus answer:"<decision>" — that revives the same child instead of redoing its work.',
    ],
    parameters: Type.Object({
      action: StringEnum(["status", "plan", "run", "continue", "stop", "add", "remove", "reset", "archive", "history"] as const),
      only: Type.Optional(
        Type.String({
          description: "run: restrict to this item id. remove/reset/archive: the target id. status/history: show that one item in full.",
        }),
      ),
      kind: Type.Optional(
        StringEnum(ITEM_KINDS, {
          description:
            'run: which pipeline to drive. "fr" (default) implements FR PLANs; "bug" drives an existing red test fixture to green. One kind per run — two pipelines in one working tree would let one item\'s commit swallow the other\'s half-finished state.',
        }),
      ),
      all: Type.Optional(
        Type.Boolean({
          description: "status: list every queue row instead of the summary (in-flight + next 3 pending). Costs one line per item.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `history: how many archived items to list, newest first (default ${HISTORY_ROWS}).`,
        }),
      ),
      plan: Type.Optional(Type.String({ description: 'add: repo-relative path to the *_PLAN.md.' })),
      id: Type.Optional(Type.String({ description: "add: queue id. Derived from the plan filename when omitted." })),
      fixture: Type.Optional(
        Type.String({
          description:
            'add: kind:"bug" only. The path (or runner token) the pin lives at. Defaults to the plan\'s own directory, which is right when the report sits beside its fixture and wrong when it does not.',
        }),
      ),
      fr: Type.Optional(Type.String({ description: "add: the companion FR doc. Derived by dropping _PLAN when omitted." })),
      reads: Type.Optional(Type.Array(Type.String(), { description: "add: extra docs every child must read (e.g. a batch OVERVIEW)." })),
      verify: Type.Optional(
        Type.Array(Type.String(), {
          description: "add: shell commands that must all exit 0 before the audit runs. Omit to inherit queue.defaultVerify.",
        }),
      ),
      commitMsg: Type.Optional(Type.String({ description: "add: commit subject for this item." })),
      model: Type.Optional(
        Type.String({
          description:
            "add: model for this item's children (provider/id, or a bare id). Omit to inherit queue.roles → queue.defaultModel → the session running the batch.",
        }),
      ),
      thinking: Type.Optional(
        StringEnum(THINKING_EFFORTS, {
          description:
            "add: reasoning effort for this item's children. Omit to inherit queue.roles → queue.defaultThinking → the session running the batch.",
        }),
      ),
      after: Type.Optional(Type.String({ description: "add: insert immediately after this item id." })),
      before: Type.Optional(Type.String({ description: "add: insert immediately before this item id." })),
      answer: Type.Optional(
        Type.String({
          description:
            'continue: the supervisor decision for an item paused with "DECISION NEEDED". Required to continue such an item; it is delivered to the same child, which resumes with its context and files intact.',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const lines: string[] = [];
      const log: Log = (line) => {
        lines.push(line);
        onUpdate?.({ content: [{ type: "text", text: lines.slice(-24).join("\n") }], details: {} });
      };
      const text = (s: string, isError = false) => ({ content: [{ type: "text" as const, text: s }], details: {}, ...(isError ? { isError: true } : {}) });
      try {
        switch (params.action) {
          case "status":
            return text(renderStatus(ctx.cwd, sessionChildConfig(ctx), { all: params.all, only: params.only }));
          case "archive":
            return text(archiveItems(ctx.cwd, params.only));
          case "history":
            return text(renderHistory(ctx.cwd, params.only, Math.max(1, Math.floor(params.limit ?? HISTORY_ROWS))));
          case "add":
            if (!params.plan) return text('fr-batch: action "add" requires plan.', true);
            return text(
              addItem(ctx.cwd, {
                plan: params.plan,
                id: params.id,
                kind: params.kind,
                fixture: params.fixture,
                fr: params.fr,
                reads: params.reads,
                verify: params.verify,
                commitMsg: params.commitMsg,
                after: params.after,
                before: params.before,
                model: params.model,
                thinking: params.thinking,
              }),
            );
          case "remove":
            if (!params.only) return text('fr-batch: action "remove" requires only:<id>.', true);
            return text(removeItem(ctx.cwd, params.only));
          case "reset":
            if (!params.only) return text('fr-batch: action "reset" requires only:<id>.', true);
            return text(resetItem(ctx.cwd, params.only));
          case "stop":
            return text(stopDriver(pi, ctx.cwd));
          case "plan": {
            const out = await runBatch(pi, ctx, { only: params.only, dryRun: true }, log);
            return text(`${lines.join("\n")}\n\n${out}`.trim());
          }
          default:
            // run / continue. The batch is NOT awaited here: awaiting it would hold this turn
            // open for hours, and pi only delivers queued user messages between turns — so the
            // operator could neither inspect, extend nor stop the batch they just started.
            return text(await startDriver(pi, ctx, { only: params.only, kind: params.kind, answer: params.answer }));
        }
      } catch (e) {
        return text(`${lines.join("\n")}\n\nfr-batch error: ${(e as Error).message}`.trim(), true);
      }
    },
  });

  pi.registerCommand("fr-batch", {
    description: "FR PLAN batch: /fr-batch [status|all|plan|run|run-bug|stop|archive|history]",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "status", label: "status — summary: in-flight + next pending + driver" },
        { value: "all", label: "all — status with every queue row" },
        { value: "plan", label: "plan — dry run" },
        { value: "run", label: "run — start the background driver (needs armed: true)" },
        { value: "run-bug", label: 'run-bug — same, for kind:"bug" items' },
        { value: "stop", label: "stop — end the background driver" },
        { value: "archive", label: "archive — sweep committed items into history.jsonl" },
        { value: "history", label: "history — list archived items, newest first" },
      ].filter((i) => i.value.startsWith(prefix));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim() || "status";
      try {
        if (arg === "status") return void ctx.ui.notify(renderStatus(ctx.cwd, sessionChildConfig(ctx)), "info");
        if (arg === "all") return void ctx.ui.notify(renderStatus(ctx.cwd, sessionChildConfig(ctx), { all: true }), "info");
        if (arg === "archive") return void ctx.ui.notify(archiveItems(ctx.cwd), "info");
        if (arg === "history") return void ctx.ui.notify(renderHistory(ctx.cwd, undefined, HISTORY_ROWS), "info");
        if (arg === "plan") return void ctx.ui.notify(await runBatch(pi, ctx, { dryRun: true }, () => {}), "info");
        if (arg === "stop") return void ctx.ui.notify(stopDriver(pi, ctx.cwd), "info");
        if (arg === "run-bug") return void ctx.ui.notify(await startDriver(pi, ctx, { kind: "bug" }), "info");
        if (arg === "run") {
          // Started right here rather than handed to the agent. The old indirection existed to
          // borrow the turn's abort signal and streaming card; the background driver has its
          // own stop and its own status, so a command can own the run directly.
          return void ctx.ui.notify(await startDriver(pi, ctx, {}), "info");
        }
        ctx.ui.notify(`fr-batch: unknown argument "${arg}". Use status | all | plan | run | run-bug | stop | archive | history.`, "warning");
      } catch (e) {
        ctx.ui.notify(`fr-batch: ${(e as Error).message}`, "error");
      }
    },
  });

  // A driver is a plain in-process loop, so a quit/reload would leave its run lock behind and
  // make the next session wait out STALE_RUNLOCK_MS. Abort it and drop the lock instead; the
  // item's phase is already in progress.json, so the next run resumes from it.
  pi.on("session_shutdown", (_event, ctx) => {
    const d = drivers.get(ctx.cwd);
    if (!d) return;
    d.stopRequested = true;
    d.hardStopped = true;
    d.abort.abort();
    if (d.touch) clearInterval(d.touch);
    drivers.delete(ctx.cwd);
    rmSync(runlockPath(ctx.cwd), { force: true });
  });
}
