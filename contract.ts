import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contractPath, ledgerPath, outOfScopePath, writeAtomic } from "./paths.ts";
import { UNPARSEABLE_GAP_ID } from "./types.ts";
import type { AuditGap, AuditVerdict, Ledger, Log, QueueItem } from "./types.ts";

/**
 * How many times to re-run an audit whose verdict came back unparseable before
 * declaring it an infrastructure failure. It is a TRANSPORT symptom, not a test
 * gap, so it is retried rather than filed: observed once as the child's prose in
 * the output slot and once as raw session JSONL from a provider outage.
 */
export const AUDIT_PARSE_RETRIES = 2;

/**
 * The PLAN's tests matrix section, verbatim. Null when the PLAN has no such section.
 *
 * The heading is matched by its TEXT, not by an exact spelling: real PLANs number their
 * sections (`## 6. Tests — the branch matrix`, `## 7. Tests`), and a `^##\s+tests\b`-only
 * matcher silently treated 10 of the first 15 committed items as "no test matrix" and froze
 * the WHOLE PLAN as the audit contract instead — a much weaker gate, announced by one log
 * line inside a 24-line rolling window nobody reads.
 */
export function extractTestsSection(text: string): string | null {
  const lines = text.split("\n");
  const heading = /^(#{2,4})\s*(?:\d+(?:\.\d+)*[.)]?\s*)?tests\b/i;
  const start = lines.findIndex((l) => heading.test(l.trim()));
  if (start < 0) return null;
  const depth = (heading.exec(lines[start]!.trim())?.[1] ?? "##").length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i] ?? "");
    if (m && m[1].length <= depth) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

/**
 * The PLAN's acceptance section, verbatim, or "" when it has none.
 *
 * Same heading-by-TEXT matching as extractTestsSection, and for the same reason: real PLANs number
 * their sections. Several spellings are accepted because this is read-only context for a reviewer —
 * getting it wrong costs a less useful prompt, never a wrong verdict, so a generous matcher beats a
 * strict one here.
 */
export function extractAcceptanceSection(text: string): string {
  const lines = text.split("\n");
  const heading = /^(#{2,4})\s*(?:\d+(?:\.\d+)*[.)]?\s*)?(?:acceptance|build,? validate,? (?:and )?test|build and test|acceptance gate)\b/i;
  const start = lines.findIndex((l) => heading.test(l.trim()));
  if (start < 0) return "";
  const depth = (heading.exec(lines[start]!.trim())?.[1] ?? "##").length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i] ?? "");
    if (m && m[1].length <= depth) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

/**
 * The PLAN text this item is judged against: HEAD's copy, falling back to the working tree
 * when the PLAN is not committed yet. Same resolution for the pre-flight gate and for the
 * frozen contract, so the gate cannot pass on text the contract never sees.
 */
export async function readPlanText(pi: ExtensionAPI, cwd: string, plan: string): Promise<{ text: string; fromHead: boolean }> {
  const head = await pi.exec("git", ["show", `HEAD:${plan}`], { cwd });
  if (head.code === 0 && (head.stdout ?? "").trim().length > 0) return { text: head.stdout as string, fromHead: true };
  const p = join(cwd, plan);
  return { text: existsSync(p) ? readFileSync(p, "utf8") : "", fromHead: false };
}

/**
 * Pre-flight: refuse an item whose PLAN carries no test matrix, BEFORE any child is spawned.
 *
 * Every child is told "write EVERY row of the PLAN's `## Tests` matrix as a real test" and the
 * auditor's blocking gaps must name a row of that matrix. With no matrix the whole pipeline
 * degrades silently: the implementer has nothing to satisfy and starts asking the supervisor
 * what to do (which used to strand it — see DECISION_DIRECTIVE), and the audit gate has no
 * row ids, so "complete" means nothing was checked. Blocking here costs seconds and names the
 * missing thing; discovering it three children later costs the whole item.
 */
export async function planTestGate(pi: ExtensionAPI, cwd: string, item: QueueItem): Promise<{ ok: true } | { ok: false; why: string }> {
  const { text, fromHead } = await readPlanText(pi, cwd, item.plan);
  const where = fromHead ? "git show HEAD:<plan>" : "the working tree";
  if (!text.trim()) {
    return {
      ok: false,
      why: [
        `PLAN not found: ${item.plan} (looked in HEAD and in the working tree).`,
        "",
        `Fix the path in ${"queue.json"}, or remove the item: fr_batch action "remove", only: "${item.id}".`,
      ].join("\n"),
    };
  }
  const section = extractTestsSection(text);
  // A table's HEADER and its `|---|---|` separator are both `|`-lines, so counting raw `|`-lines
  // let an empty skeleton (`| id | what |` + `|---|---|`, zero data rows) pass the gate that
  // exists to catch exactly that. Separators are dropped, and what remains must be a header plus
  // at least one real row — or two bullets, for a PLAN whose matrix is a list.
  const rows = (section ?? "")
    .split("\n")
    .filter((l) => /^\s*(?:\||[-*]\s)/.test(l) && l.trim().length > 2)
    .filter((l) => !/^\s*\|?[\s:|-]*\|[\s:|-]*$/.test(l));
  if (!section || rows.length < 2) {
    return {
      ok: false,
      why: [
        section
          ? `${item.plan} has a tests section with no rows in it (read from ${where}).`
          : `${item.plan} has NO tests section (read from ${where}).`,
        "",
        "This item was NOT started — no child was spawned, nothing was written, nothing was committed.",
        "",
        "Why this is fatal rather than a warning: the implementer is told to turn every row of the",
        "PLAN's tests matrix into a real test, and the auditor may only raise a gap that NAMES a row",
        "of that matrix. With no rows, the implementer has no test obligation to satisfy and the audit",
        "gate passes by vacuity — the batch would report a green item that was never checked.",
        "",
        "Fix: add a `## Tests` section to the PLAN with one row per behavior branch, each row naming",
        "the edit that must make it RED (the `proves non-vacuous` column). A table needs a header AND",
        "at least one data row; a bare skeleton is what this check is for.",
        "",
        `Then re-run. A heading counts when its text is "Tests" — "## 6. Tests — the branch matrix"`,
        "is fine, `### Test plan` is not.",
      ].join("\n"),
    };
  }
  return { ok: true };
}

/**
 * Freeze this item's audit contract, or return the already-frozen one.
 *
 * Source is the PLAN **as committed at HEAD** — by audit time the working tree may
 * already carry rows the implementer appended, and those were never part of the
 * contract it was handed. Falls back to the working tree only when the PLAN is not
 * in HEAD yet (a brand-new, uncommitted plan).
 */
export async function freezeContract(pi: ExtensionAPI, cwd: string, item: QueueItem, log: Log): Promise<string> {
  const p = contractPath(cwd, item.id);
  if (existsSync(p)) return readFileSync(p, "utf8");

  const { text: src, fromHead } = await readPlanText(pi, cwd, item.plan);
  const section = extractTestsSection(src);
  if (!section) {
    log(`  WARNING: ${item.plan} has no "## Tests" section — freezing the whole PLAN as the contract instead.`);
  }
  const body =
    section ??
    [
      '(No "## Tests" section in this PLAN. The contract below is the whole PLAN text; the',
      " auditor may raise a gap against any id it names, which is weaker than a real matrix.)",
      "",
      src.trim(),
    ].join("\n");

  const text = [
    `<!-- fr-batch FROZEN AUDIT CONTRACT · item ${item.id} · ${item.plan}`,
    `     source: ${fromHead ? "git show HEAD:<plan>" : "working tree (plan not in HEAD)"} · frozen ${new Date().toISOString()}`,
    "     Every audit round for this item is judged against this text and nothing else.",
    `     Do not hand-edit. To re-freeze: fr_batch action "reset", only: "${item.id}". -->`,
    "",
    body,
    "",
  ].join("\n");
  writeAtomic(p, text);
  log(`  audit contract frozen (${body.split("\n").length} line(s)) → ${p}`);
  return text;
}

export function loadLedger(cwd: string, id: string): Ledger {
  const p = ledgerPath(cwd, id);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Ledger;
  } catch {
    return {};
  }
}

export function saveLedger(cwd: string, id: string, ledger: Ledger): void {
  writeAtomic(ledgerPath(cwd, id), `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * Split the auditor's findings into what may block and what may not.
 *
 * In scope = the gap's id occurs in the frozen contract AS A TOKEN. Everything else is the
 * auditor writing new spec, which is legitimate output but not a gate on THIS item. Enforced
 * here and not only in the prompt: an agent told to prove the tests incomplete will always find
 * one more row to want.
 *
 * The match is token-bounded, not `includes`. A bare substring test made short ids match almost
 * anything a contract happens to contain — `T1` is inside `T10`, `T1x`, and the word `T1`
 * anywhere in prose — so an invented id could pass the scope gate and block the item, which is
 * the one thing this function exists to prevent. Boundaries are non-alphanumeric on both sides,
 * so `T1` matches `| T1 |` and `T1:` but not `T10`.
 */
export function partitionGaps(gaps: AuditGap[], contract: string): { blocking: AuditGap[]; outOfScope: AuditGap[] } {
  const hay = contract.toLowerCase();
  const inContract = (id: string): boolean => {
    const needle = id.toLowerCase();
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
      const before = at === 0 ? "" : hay[at - 1]!;
      const after = hay[at + needle.length] ?? "";
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    }
    return false;
  };
  const blocking: AuditGap[] = [];
  const outOfScope: AuditGap[] = [];
  for (const g of gaps) {
    const id = (g.id ?? "").trim();
    const scoped = id === UNPARSEABLE_GAP_ID || (id.length > 0 && !/^new[-_ ]/i.test(id) && inContract(id));
    (scoped ? blocking : outOfScope).push(g);
  }
  return { blocking, outOfScope };
}

/**
 * Did the previous fix round do any work?
 *
 * A PURE RULE, testable without driving the loop into the one state where it changes an outcome.
 * That state is narrow by construction: `closed === 0` with nothing re-raised requires every
 * previously-open gap to have been REJECTED, because a gap the auditor merely stops reporting is
 * swept to closed and a re-raised one is stopped by the re-litigation guard first. So the two terms
 * are not redundant — the second is exactly the all-rejected round, and calling that barren would
 * punish a fixer for settling an invalid demand, which is work the ledger keeps forever.
 *
 * This is what the fix budget counts. Rounds are not the unit: an auditor establishes coverage a row
 * at a time, so an item that closes everything it is handed while the auditor reaches deeper is
 * converging, and counting rounds stopped exactly that.
 */
export function roundWasProductive(closed: number, rejected: number): boolean {
  return closed > 0 || rejected > 0;
}

/** Append out-of-contract findings so they survive as follow-up material. */
export function recordOutOfScope(
  cwd: string,
  item: QueueItem,
  round: number,
  gaps: AuditGap[],
  notes: string | undefined,
  verifyFindings: Array<{ command: string; what: string }> = [],
): void {
  const p = outOfScopePath(cwd, item.id);
  const head = existsSync(p)
    ? ""
    : [
        `# Out-of-contract audit findings — ${item.id}`,
        "",
        `Coverage the auditor wanted that the frozen contract (\`${item.id}.contract.md\`) does not ask`,
        "for. Non-blocking by construction: this item does not gate on them. Promote anything",
        "worth having into a follow-up FR PLAN.",
        "",
      ].join("\n");
  const body = [
    `## round ${round} · ${new Date().toISOString()}`,
    "",
    ...gaps.map((g) => `- **[${g.id} · ${g.kind}]** ${g.what}\n  - why: ${g.why_missing}\n  - suggested: ${g.suggested_row}`),
    ...(notes?.trim() ? ["", `Auditor notes: ${notes.trim()}`] : []),
    ...(verifyFindings.length
      ? [
          "",
          "### The project's verify gate disagrees with the PLAN's acceptance text",
          "",
          "Non-blocking: the verify block is the operator's, not this item's. But nothing else reviews",
          "those commands, so a line encoding a pre-change value is otherwise unfalsifiable.",
          "",
          ...verifyFindings.map((f) => `- \`${f.command}\`\n  - ${f.what}`),
        ]
      : []),
    "",
  ].join("\n");
  const prior = existsSync(p) ? readFileSync(p, "utf8") : "";
  writeAtomic(p, `${head}${prior}${body}`);
}

/** Parse the fixer's structured report. Absent or malformed degrades to "nothing declared". */
export function parseFixReport(raw: string): { closed: Array<{ id: string; how: string }>; rejected: Array<{ id: string; why: string }>; notes?: string } | null {
  const attempt = (t: string) => {
    try {
      return JSON.parse(t) as { closed?: unknown; rejected?: unknown; notes?: string };
    } catch {
      return null;
    }
  };
  const parsed = attempt(raw) ?? (firstJsonObject(raw) ? attempt(firstJsonObject(raw) as string) : null);
  if (!parsed) return null;
  const rows = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    closed: rows<{ id: string; how: string }>(parsed.closed).filter((r) => typeof r?.id === "string"),
    rejected: rows<{ id: string; why: string }>(parsed.rejected).filter((r) => typeof r?.id === "string"),
    ...(typeof parsed.notes === "string" ? { notes: parsed.notes } : {}),
  };
}

export function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function parseVerdict(raw: string): AuditVerdict {
  const parsed = (() => {
    try {
      return JSON.parse(raw) as AuditVerdict;
    } catch {
      const inner = firstJsonObject(raw);
      if (!inner) return null;
      try {
        return JSON.parse(inner) as AuditVerdict;
      } catch {
        return null;
      }
    }
  })();
  if (!parsed || (parsed.verdict !== "complete" && parsed.verdict !== "gaps_found")) {
    return {
      verdict: "gaps_found",
      gaps: [
        {
          id: "AUDIT-UNPARSEABLE",
          kind: "vacuous",
          what: "The auditor did not return a schema-valid verdict.",
          why_missing: `Raw output could not be parsed as the audit schema: ${raw.slice(0, 400)}`,
          suggested_row: "Re-run the audit; if it repeats, the auditor agent or its outputSchema is misconfigured.",
        },
      ],
    };
  }
  if (!Array.isArray(parsed.gaps)) parsed.gaps = [];
  if (parsed.verdict === "complete" && parsed.gaps.length > 0) parsed.verdict = "gaps_found";
  return parsed;
}

// ---------------------------------------------------------------------------
// task prompts
// ---------------------------------------------------------------------------
