import type { AuditGap, Ledger, Queue, QueueItem } from "./types.ts";

export function frFor(item: QueueItem): string | undefined {
  if (item.fr) return item.fr;
  const derived = item.plan.replace(/_PLAN\.md$/, ".md");
  return derived !== item.plan ? derived : undefined;
}

export function readsBlock(item: QueueItem): string {
  const fr = frFor(item);
  return [item.plan, ...(fr ? [fr] : []), ...(item.reads ?? [])].map((p) => `- ${p}`).join("\n");
}

/** Optional per-repo emphasis block, empty when the queue sets no repoRules. */
export function rulesBlock(q: Queue): string {
  return q.repoRules?.trim() ? `\n\nRepo-specific emphasis (your project context file is still the authority):\n${q.repoRules.trim()}\n` : "";
}

/**
 * The operator's standing instruction for THIS item, from progress.json's `note`.
 *
 * It reaches the child, and that is a fix rather than a nicety. The note is written by the driver and
 * read by the operator, so an operator who wrote "the previous round's implementation is parked in
 * <ref>, retrieve it" into it watched the next child ignore it and rewrite from zero. The same text
 * placed first in `reads` WAS obeyed — so the difference between the two fields was discoverable
 * only by trial, which is the actual defect.
 *
 * Marked as the operator speaking, so a child cannot mistake it for part of the PLAN.
 */
export function noteBlock(note: string | undefined): string {
  const n = (note ?? "").trim();
  if (!n) return "";
  return [
    "",
    "",
    "## What happened here before you",
    "",
    // Framed as a RECORD, not an instruction. This text is the driver's — progress.json is the
    // driver's file and there is no operator route into it — so it is a block reason, a raw verify
    // tail, or "Re-entered after a failed attempt. Previous note: ...". It was previously headed
    // "Standing instruction from the operator ... Follow it", which told a child to obey a machine
    // dump as if a human had authored it. Context is what it is; an order is what it is not.
    "Not part of the PLAN, and not an instruction. This is the batch driver's own record of how this",
    "item last stopped: a failed attempt, a gate's output, where work was parked. Read it for context",
    "and say in your report whether it changed what you did.",
    "",
    n,
  ].join("\n");
}

export function implementTask(item: QueueItem, q: Queue, note?: string): string {
  return `Implement this FR PLAN end to end, exactly as written.

Read these first, completely, in this order:
${readsBlock(item)}

Rules:
- The PLAN is the spec. Execute its numbered phases in order and satisfy every "Success check".
- The PLAN's own §0 "Decisions" section is binding. Do not re-derive a decision it locks.
- Write EVERY row of the PLAN's "## Tests" behavior-branch matrix as a real test. Each row's
  "proves non-vacuous" column names the edit that must make it RED — a test that cannot go red
  that way is not the test the row asked for.
- Respect the PLAN's file-change checklist. Do not touch files it lists as untouched.
- Your project's context file is in your system prompt and is binding, especially any warning
  about a stale incremental-build cache or a required codegen step. Follow it exactly.
- Do NOT commit. Do NOT run git commit, git add, or git stash. The driver commits.
- Leave the working tree with your changes in place.${rulesBlock(q)}

Report at the end: files created, files edited, the matrix rows you implemented, and any row
you could NOT implement with the reason.${noteBlock(note)}`;
}

export function auditTask(item: QueueItem, contract: string, ledger: Ledger, verifyCmds: string[] = [], acceptance = ""): string {
  const adjudicated = Object.entries(ledger)
    .filter(([, e]) => e.state !== "open")
    .map(([id, e]) => `- [${id} · ${e.state}] ${e.what}${e.state === "rejected" && e.reason ? `\n  fixer's reason for rejecting: ${e.reason}` : ""}`)
    .join("\n");

  return `You are an ADVERSARIAL test-completeness auditor. An implementation of this FR PLAN has
just landed in the working tree. Your job is to PROVE THE TESTS ARE INCOMPLETE.

Read for context:
${readsBlock(item)}

Then read the tests that were actually written. Use \`git status --short\` and \`git diff --stat\`
to find what changed; the PLAN's file-change checklist names the test files it should add.

## Your checklist is FROZEN, and it is this and only this

The text below was snapshotted from the PLAN before implementation started. It does not
change between rounds, and the live PLAN in the working tree may now contain extra rows a
previous fix round appended. **Those extra rows are not yours to enforce.** Judge against
this snapshot.

<<<FROZEN_AUDIT_CONTRACT
${contract.trim()}
FROZEN_AUDIT_CONTRACT

Rules that decide whether your output counts:
- Every entry in \`gaps\` MUST use an \`id\` copied **verbatim** from the frozen contract above.
  The driver discards any other id as out-of-scope, so inventing one (\`NEW-1\`, a paraphrase)
  spends the round for nothing.
- Coverage you would want that the frozen contract does not ask for goes in \`notes\`, not in
  \`gaps\`. It gets recorded as follow-up material. It is real output; it is just not a gate on
  this item.
${adjudicated ? `
## Already adjudicated — do NOT raise these again

${adjudicated}

Re-raising an adjudicated id STOPS THE BATCH for human review rather than triggering another
fix round. Do it only if you can name the specific test that claims to cover it and show that
test cannot go red — and lead \`why_missing\` with "RE-RAISE:" so the human sees why.
` : ""}
## For each contract row, check

- every control-flow arm the row implies: each if/else, each mode, each early return
- every parameter boundary the row names: min, max, zero, negative, missing, default-substitution
- every CLAMP, BOTH sides — below-range AND above-range, plus an in-range explicit value that
  must not be snapped
- every diagnostic code the row lists: one case per code, asserting the code fires
- every surface form: bare vs map, each optional field present vs absent
- composition with each neighbour the row names

Then apply the harder filter, which is the real point of this audit:
**a row whose "proves non-vacuous" edit would not actually make the test RED is not coverage.**
For each asserted behaviour ask: if I invert this value or comment out that line, does this test
fail? If the answer is no — or if it is a magnitude check where the bug would be a sign error —
it is a gap. Report it with kind "vacuous".

${
    verifyCmds.length
      ? `## Second, smaller job: does the project's GATE match what the PLAN says acceptance is?

These are the exact commands this item must pass, resolved from the queue:

${verifyCmds.map((c) => `- \`${c}\``).join("\n")}
${acceptance ? `\nAnd this is what the PLAN says acceptance is:\n\n${acceptance.trim()}\n` : ""}
Report any DISAGREEMENT in \`verify_findings\`. The canonical case is an assertion encoding a
pre-change value — a count or a code that was true before this FR and is asserted as if it still is.
Nobody reviews these commands today, so a wrong one is unfalsifiable.

This is NON-BLOCKING and it is NOT a gap: the verify block belongs to the operator, not to this item.
Empty is a fine answer, and so is "cannot tell from the PLAN".

` : ""
  }You are NOT reviewing code quality, architecture, or style. Only test completeness.
You MUST NOT modify any file.

Return your verdict by calling structured_output with the required schema. "complete" means every
row of the frozen contract has a real, non-vacuous test — not that the implementation is perfect.
If you are unsure about a CONTRACT ROW, it is a gap; if you are unsure about something the
contract never asked for, it is a note.`;
}

export function fixTask(item: QueueItem, gaps: AuditGap[], notes: string | undefined, q: Queue, note?: string): string {
  const list = gaps
    .map((g, i) => `${i + 1}. [${g.id} · ${g.kind}] ${g.what}\n   why missing: ${g.why_missing}\n   add: ${g.suggested_row}`)
    .join("\n\n");
  return `An adversarial audit found gaps in the test coverage for this FR PLAN. Close them.

Read:
${readsBlock(item)}

GAPS TO CLOSE (${gaps.length}) — this list is CLOSED. Nothing else is in scope:

${list}
${notes?.trim() ? `\nAuditor notes (context, NOT work items): ${notes.trim()}\n` : ""}
For each gap:
1. Write the test. It must be able to go RED via the edit named in its "add:" line — reason about
   that, and if it cannot, write a different assertion that can.
2. If closing a gap requires production code (a missing branch, a missing diagnostic), write that
   too — a gap can be a real hole in the implementation, not just in the tests. Keep it to the
   gap: a new branch you add is not a licence to redesign the surface.
3. Add the corresponding row to the PLAN document's "## Tests" matrix, including its "proves
   non-vacuous" edit. This is DOCUMENTATION, not scope: the auditor is judged against a frozen
   snapshot taken before implementation, so a row you add here cannot come back as a new demand.
   Keep the PLAN truthful anyway — it is what the next human reads.

If you judge a gap invalid, do NOT close it and do NOT quietly skip it: put it in \`rejected\` with
a reason that stands on its own. That is durable — the next audit is told not to raise it again.
A gap you neither close nor reject will simply be re-raised, and a re-raise stops the batch.

Do not weaken an existing test to make a new one pass. Do NOT commit.${rulesBlock(q)}

Report by calling structured_output with the required schema.${noteBlock(note)}`;
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------
