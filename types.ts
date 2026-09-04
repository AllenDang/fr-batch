/** Driver-synthesised gap id. Machinery, not scope: never filtered as out-of-contract. */
export const UNPARSEABLE_GAP_ID = "AUDIT-UNPARSEABLE";

export type ItemStatus = "pending" | "implementing" | "verifying" | "auditing" | "fixing" | "paused" | "blocked" | "committed" | "skipped";

/**
 * True when an item needs no further work, so the driver must not select it again.
 *
 * BOTH members matter and `skipped` is the one that bites. Every reader used to spell this
 * `!== "committed"` inline, and a `skipped` item under that predicate is re-selected forever:
 * the outer loop re-runs a real shell command, spawns nothing, and never exits. Worse, the
 * PRE-LOCK clean-tree guard reads the same predicate to decide whether the next item is fresh —
 * a `skipped` item ahead of a pending one made `nextStatus` non-pending, skipped the dirty-tree
 * refusal, and let `git add -A` commit the previous item's abandoned work under the next item's
 * message. So this is a helper rather than four inline comparisons.
 */
export const isDone = (s: ItemStatus): boolean => s === "committed" || s === "skipped";

/** Which pipeline an item runs. Absent means "fr", so every pre-existing queue is unchanged. */
export type ItemKind = "fr" | "bug";
export const ITEM_KINDS: readonly ItemKind[] = ["fr", "bug"];

/** Which child was in flight when a transient failure paused the item. */
/**
 * Which child was in flight when a transient failure paused the item.
 *
 * `"scope"` is RESERVED, not used: the sibling scout deliberately routes no pause and no decision
 * ask, because it runs after the gate is already green and must not be able to cost an item that
 * passed. It is listed so a future change that does want to pause it cannot forget the type.
 */
export type Phase = "implement" | "audit" | "fix-verify" | "fix-audit" | "bugfix" | "scope";

/**
 * Reasoning efforts pi accepts. Same list as pi's own THINKING_LEVELS
 * (pi-subagents src/shared/model-info.ts) — an effort outside it is rejected at
 * queue load, because an unrecognised one is silently dropped downstream.
 */
export const THINKING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

/**
 * Which fr-* agent a child runs as. One knob per ROLE, not per phase: the verify-fix and
 * gap-fix phases are the same agent doing the same job over the same tree, so splitting
 * them would offer a choice with nothing behind it.
 */
export type ChildRole = "implementer" | "auditor" | "fixer";
export const CHILD_ROLES: readonly ChildRole[] = ["implementer", "auditor", "fixer"];
/** Short role labels for one-line status/plan output. */
export const ROLE_LABEL: Record<ChildRole, string> = { implementer: "impl", auditor: "audit", fixer: "fix" };

/**
 * Model + reasoning effort for one child. Both optional at every layer; each field is
 * resolved independently against the layer stack (see resolveChildConfig).
 */
export interface ChildConfig {
  /** `provider/id`, or a bare id pi's registry resolves. A trailing `:<effort>` counts as `thinking`. */
  model?: string;
  thinking?: ThinkingEffort;
}

export type RoleConfigs = Partial<Record<ChildRole, ChildConfig>>;

/** Queue entry — user-owned. No mutable execution state lives here. */
export interface QueueItem {
  id: string;
  plan: string;
  /**
   * Which pipeline runs this item. Omit for "fr" — that default is what keeps every existing
   * queue.json working untouched.
   */
  kind?: ItemKind;
  /**
   * kind:"bug" only. The token substituted into `bugProtocol.run` / `results` / `pinPaths`.
   * Defaults to `dirname(plan)`, which is right for a report living inside its fixture dir and
   * wrong for the other real shapes — a report under `docs/` beside a fixture under `tests/`, or
   * a fixture with no report at all. Hence a field rather than only a derivation.
   *
   * It is an OPAQUE token, not necessarily a directory: a repo whose unit is `pytest x.py::y` or
   * `ctest -R name` says so here, and `pinPaths` then names the paths that must not change.
   */
  fixture?: string;
  /** kind:"bug" only. Merged field-by-field over queue.bugProtocol over BUG_PROTOCOL_DEFAULTS. */
  bugProtocol?: Partial<BugProtocol>;
  fr?: string;
  reads?: string[];
  /** Omit or leave empty to inherit queue.defaultVerify. Shown as "(default)" in status. */
  verify?: string[];
  commitMsg?: string;
  /** This item's model, for every role that does not override it. Omit to inherit. */
  model?: string;
  /** This item's reasoning effort, for every role that does not override it. Omit to inherit. */
  thinking?: ThinkingEffort;
  /** Per-role override inside this item — the most specific layer there is. */
  roles?: RoleConfigs;
}

/** Transient-failure policy. Applies to subagent launches only — see isTransient(). */
export interface TransientPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Optional HEAD probe used to shorten a wait once connectivity returns. "" = no probe. */
  probeUrl: string;
  /** Prefer reviving the failed child over respawning it, so its work is not redone. */
  resumeOnRetry: boolean;
}

/**
 * How one repo runs a bug fixture and how its verdict is read. **Every field comes from the
 * queue** — nothing here knows a build system, which is the same rule `defaultVerify` follows and
 * the reason the driver can be installed once and used by every project.
 *
 * Two verdict modes, and which one applies is decided ONCE at capture and recorded in the
 * baseline:
 *   scenario  `results` resolves → the per-row name/pass map is the verdict (full anti-cheat)
 *   exit      `results` is unset → the exit code is the verdict (one bit, said so in the log)
 * Re-deciding per run is a false-green generator: an item that captured a red scenario baseline
 * and whose runner later stops writing the sink would be re-classified into exit mode, read
 * exit 0 as green, and commit with the defect unfixed.
 */
export interface BugProtocol {
  /** Shell command(s) that run one fixture. `{fixture}` and `{plan}` are substituted. */
  run: string[];
  /**
   * Where `run` leaves its per-scenario record: JSONL, one object per line. `null` means the repo
   * has no such sink and the exit code is the verdict.
   *
   * `null` rather than "omit it" because omission cannot survive a field-by-field merge: a queue
   * that sets `results` for its 172 scenario-shaped fixtures would force the same path onto its 17
   * exit-shaped ones, whose runner never writes it, and each would hard-block forever. Same
   * sentinel idea as config.ts's `model: "inherit"`.
   */
  results: string | null;
  nameField: string;
  passField: string;
  /** Exit codes meaning the defect reproduces / is gone / cannot be judged. Must be disjoint. */
  redExit: number[];
  greenExit: number[];
  invalidExit: number[];
  /**
   * Paths that must not change while the item is being fixed — the pin and the report ARE the
   * spec. Separate from `fixture` because that may be an opaque runner token while git needs
   * real paths. Empty is refused: it would disable the only gate between the fixer and its spec.
   */
  pinPaths: string[];
  /** Require the fix to also add a file matching `pinPattern` (a permanent in-suite regression pin). */
  requirePin: boolean;
  pinPattern: string;
  /** Require the diff to touch a file the report's `file:line` citations name. Heuristic; off by default. */
  requireMechanismTouch: boolean;
}

/**
 * Applied under `queue.bugProtocol` and `item.bugProtocol`.
 *
 * DELIBERATELY CARRIES NO `run` AND NO `results`. A default runner command would hardcode one
 * project's build system in this file, which is the drift the whole extension is built to avoid —
 * and it would pass a grep that only scans the bug pipeline, so the guard has to scan every root
 * module instead.
 */
export const BUG_PROTOCOL_DEFAULTS: Omit<BugProtocol, "run" | "results"> = {
  nameField: "name",
  passField: "passed",
  redExit: [1],
  greenExit: [0],
  invalidExit: [2],
  pinPaths: ["{fixture}", "{plan}"],
  requirePin: false,
  pinPattern: "",
  requireMechanismTouch: false,
};

/** Which verdict channel a bug item was captured under. Frozen at capture; never re-derived. */
export type BugMode = "scenario" | "exit";

/**
 * A bug item's red state, captured before anything edits the tree and then read-only.
 *
 * This is the bug lane's whole equivalent of the FR lane's frozen contract, and unlike that one it
 * is MACHINE-CAPTURED — nobody writes it by hand, so it cannot drift from the pin it describes.
 * It has to be persisted because the per-scenario sink is rewritten by every run: after the fixer
 * has worked, the "before" state is unrecoverable.
 */
export interface Baseline {
  capturedAt: string;
  mode: BugMode;
  fixture: string;
  plan: string;
  exitCode: number;
  /** scenario mode only: name -> passed, as captured. Empty in exit mode. */
  scenarios: Record<string, boolean>;
  /**
   * HEAD when the pin was captured. A fixer that COMMITS its own edit moves HEAD, and every
   * diff-against-HEAD check then reports a clean tree — so the commit itself has to be noticed.
   */
  head: string;
  /**
   * Content hash of every file under the pin paths, at capture. Compared byte-for-byte at the
   * gate. A hash cannot be silenced by `assume-unchanged`, by `.git/info/exclude`, by a commit,
   * or by a rename, each of which defeats a diff.
   */
  pins: Record<string, string>;
}

export interface Queue {
  /** Hard interlock. `run` refuses while false. Flipping it to false mid-run stops gracefully. */
  armed: boolean;
  /**
   * The three budgets are REQUIRED here but OPTIONAL in the file: `loadQueue` fills any that
   * the queue omits from QUEUE_BUDGET_DEFAULTS and rejects a present-but-unusable value, so
   * every reader downstream can treat them as numbers.
   *
   * They used to be neither validated nor defaulted, and the failure was silent in the worst
   * way: `undefined` reached `setTimeout(fn, timeoutMs + 60_000)` as `NaN`, which fires
   * IMMEDIATELY, so every child died at once with `child exceeded undefinedms`, while a
   * missing `maxFixRounds` made `round >= q.maxFixRounds` false forever and left the fix
   * loop unbounded. The queue read as configured either way.
   */
  /**
   * How many CONSECUTIVE BARREN fix rounds end an item. A barren round is one whose fixer closed
   * nothing and rejected nothing.
   *
   * It counts barren rounds, not rounds, and that is the whole point. Counting rounds punishes the
   * healthy trajectory: an auditor establishes coverage empirically, a row at a time, so a large
   * matrix takes several rounds to walk, and an item that closes everything it is handed each round
   * while the auditor keeps reaching deeper is CONVERGING. Reported from a real batch: 3 gaps closed,
   * then 3 more closed, then 1 — every round productive, and the budget ran out anyway.
   *
   * The consequence is not a looser bound. An item that closes nothing is stopped SOONER than before,
   * because barren rounds are counted consecutively instead of being diluted by productive ones.
   */
  maxFixRounds: number;
  /**
   * Total fix rounds, whatever their outcome. A COST stop, not a correctness one.
   *
   * Without it an auditor/fixer pair that alternates one closure with one fresh discovery never goes
   * barren and runs until `childTimeoutMs` times the round count. Defaulted from maxFixRounds so it
   * is not another number to choose.
   */
  maxTotalRounds: number;
  childTimeoutMs: number;
  verifyTimeoutMs: number;
  /** Used by any item that omits `verify`. Never empty — an empty gate is no gate. */
  defaultVerify: string[];
  /**
   * Optional per-repo emphasis appended to every child's task. Use it ONLY for a
   * trap the project's context file already documents but agents keep ignoring
   * (a stale incremental-build cache, a required codegen step). Do not restate
   * the context file here — `inheritProjectContext: true` already injects it, and
   * a second copy is a drift source.
   */
  repoRules?: string;
  transient?: Partial<TransientPolicy>;
  /**
   * Retry policy for a QUOTA/RATE-LIMIT refusal, which is a different animal from a network
   * blip and needs its own budget. A blip recovers in seconds; an `insufficient_quota` 429 is a
   * SPEND CAP and recovers when a window rolls over or a human raises a limit — hours, not
   * minutes. Sharing one budget meant a 429 exhausted 6 attempts inside ~13 minutes and paused
   * the batch, which is what this split exists to stop.
   */
  transientQuota?: Partial<TransientPolicy>;
  /**
   * How this repo runs a bug fixture. Required (here or per item) as soon as any item declares
   * `kind: "bug"`, and refused at load otherwise — an absent protocol cannot be defaulted into
   * anything safe, the same argument `defaultVerify` makes.
   */
  bugProtocol?: Partial<BugProtocol>;
  /** Batch-wide model for every child that does not override it. Omit to inherit the session's. */
  defaultModel?: string;
  /** Batch-wide reasoning effort. Omit to inherit the session's. */
  defaultThinking?: ThinkingEffort;
  /** Batch-wide per-role override, e.g. a cheaper auditor than implementer. */
  roles?: RoleConfigs;
  items: QueueItem[];
}

/**
 * Applied by `loadQueue` to any of the three budgets the queue omits. Values are the ones a
 * real batch needs rather than round numbers: a child implementing a whole PLAN routinely runs
 * over an hour, and a verify gate that compiles a C++ project and boots ~130 headless servers
 * needs a budget in the tens of minutes.
 */
export const QUEUE_BUDGET_DEFAULTS = {
  maxFixRounds: 4,
  maxTotalRounds: 12,
  childTimeoutMs: 3 * 60 * 60 * 1000,
  verifyTimeoutMs: 90 * 60 * 1000,
} as const;

export const TRANSIENT_DEFAULTS: TransientPolicy = {
  maxRetries: 6,
  baseDelayMs: 15_000,
  maxDelayMs: 300_000,
  probeUrl: "",
  resumeOnRetry: true,
};

/**
 * QUOTA/RATE-LIMIT defaults — same mechanism, a budget sized for the actual recovery time.
 *
 * 30s base, doubling, capped at 30 min, 60 attempts: the cap is reached at attempt 6 and every
 * later wait is ~30 min, so the total horizon is roughly 27 hours. That is deliberately longer
 * than any provider's rolling window, because the alternative — pausing the batch — costs a
 * human round-trip to type "continue", and an unattended batch then sits idle until someone
 * notices. Retrying is cheap: `resumeOnRetry` revives the SAME child with its context and its
 * already-written files intact, so a wait costs wall-clock and nothing else.
 */
export const TRANSIENT_QUOTA_DEFAULTS: TransientPolicy = {
  maxRetries: 60,
  baseDelayMs: 30_000,
  maxDelayMs: 1_800_000,
  probeUrl: "",
  resumeOnRetry: true,
};

export interface ProgressEntry {
  status: ItemStatus;
  fixRounds: number;
  /**
   * Consecutive fix rounds that closed nothing and rejected nothing, ACROSS runs.
   *
   * Persisted for the same reason `fixRounds` is: a budget that lives only in a local resets every
   * time the loop is re-entered, so an operator could hand a stuck item unlimited barren rounds by
   * looping `continue`. `fixRounds` was already persisted and `barren` was not, which made the new
   * budget weaker than the one it replaced in exactly the situation the escape hatch created.
   */
  barrenRounds?: number;
  note?: string;
  sha?: string;
  updatedAt: string;
  /** Set only while status is "paused": enough to resume the exact child that died. */
  pausedPhase?: Phase;
  pausedChildId?: string;
  pausedRound?: number;
  /**
   * Why it paused. "network" waits for connectivity and can resume itself; "decision" waits
   * for a supervisor answer and CANNOT resume without one, so `continue` refuses until it is
   * given an `answer`; "stopped" is a hard stop the operator asked for, and it deliberately
   * keeps no child id — the abandoned child may still be alive, so reviving it is unsafe and
   * the phase is re-run fresh over the files it already wrote.
   */
  pauseKind?: "network" | "decision" | "stopped";
  /** The child's question, verbatim. Set only for a "decision" pause. */
  pendingAsk?: string;
  /**
   * What a block invalidated. Set only while status is "blocked".
   *
   * `blocked` used to mean two unrelated things, and the sticky rule was right for one of them:
   *   "verdict"  the GATE returned against this item — verify red at budget, in-contract gaps at
   *              budget, a re-raised id, a laundered pin. A human has to change something, and the
   *              driver cannot tell whether their fix invalidated the recorded phase or the frozen
   *              spec. Sticky: a plain `run` refuses.
   *   "attempt"  the attempt did not happen — a child that could not launch, a bad install, a dead
   *              workflow. Nothing about the contract or the phase was invalidated, so re-entering is
   *              not a guess. A plain `run` resumes.
   * Absent on an older progress.json, which reads as "verdict" — the conservative direction.
   */
  blockScope?: "verdict" | "attempt";
}

export type Progress = Record<string, ProgressEntry>;

/**
 * One archived item. Deliberately FLAT and self-contained: the queue entry and the driver's
 * progress entry are both deleted when this is written, so a line has to carry everything a
 * later reader could want. Read back only by action "history", never on the status path.
 */
export interface HistoryEntry {
  id: string;
  plan: string;
  sha?: string;
  commitMsg?: string;
  fixRounds: number;
  /** ProgressEntry.updatedAt at archive time — when the item reached `committed`. */
  committedAt?: string;
  archivedAt: string;
  /** The driver's closing note, verbatim. The single biggest field, and why this is not JSON. */
  note?: string;
  /** Relative dir under .pi/fr-batch/ holding the frozen contract + ledger, when kept. */
  stateDir?: string;
}

export interface AuditGap {
  id: string;
  kind: string;
  what: string;
  why_missing: string;
  suggested_row: string;
}

export interface AuditVerdict {
  verdict: "complete" | "gaps_found";
  gaps: AuditGap[];
  notes?: string;
  /** Non-blocking: the verify block is the operator's, so a disagreement is reported, never gated. */
  verify_findings?: Array<{ command: string; what: string }>;
}

export type GapState = "open" | "closed" | "rejected";

/** One adjudicated gap. Survives across rounds, runs, and sessions. */
export interface LedgerEntry {
  kind: string;
  what: string;
  /** Every audit round that raised this id. Length > 1 means the loop is not converging. */
  raisedRounds: number[];
  state: GapState;
  /** The fixer's reason, when it declared the gap invalid rather than closing it. */
  reason?: string;
}

export type Ledger = Record<string, LedgerEntry>;

export interface SupervisorAsk {
  channelDir: string;
  requestId: string;
  reason?: string;
  message?: string;
  /** True when the ask is an outage report the driver can answer itself by waiting. */
  isNetwork: boolean;
}

export const AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "gaps"],
  properties: {
    verdict: {
      type: "string",
      enum: ["complete", "gaps_found"],
      description:
        "complete = every branch/boundary/clamp/error-code/composition row in the PLAN's ## Tests matrix has a real, non-vacuous test. gaps_found = at least one is missing, vacuous, or unreachable.",
    },
    gaps: {
      type: "array",
      description:
        "One entry per missing or vacuous test FOR A ROW OF THE FROZEN CONTRACT. Empty iff verdict is complete. Coverage the frozen contract does not ask for belongs in notes, not here.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "what", "why_missing", "suggested_row"],
        properties: {
          id: {
            type: "string",
            description:
              "Row id copied VERBATIM from the frozen audit contract in the task. An id that does not appear there is discarded by the driver as out-of-scope, so inventing one wastes the round.",
          },
          kind: {
            type: "string",
            enum: ["branch", "boundary", "clamp", "error_code", "surface_form", "composition", "vacuous", "missing_seam"],
          },
          what: { type: "string", description: "The untested behaviour, one sentence." },
          why_missing: { type: "string", description: "Why current tests do not cover it. Cite the test file/case you inspected." },
          suggested_row: { type: "string", description: "The matrix row to add, including its `proves non-vacuous` RED edit." },
        },
      },
    },
    notes: {
      type: "string",
      description:
        "Anything that is not a blocking gap: coverage you would want but the frozen contract does not ask for, and anything the fixer needs as background. Recorded as a follow-up, never blocking.",
    },
    verify_findings: {
      type: "array",
      description:
        "Disagreements between the project's VERIFY commands (given to you in the task) and what the PLAN says acceptance is. NON-BLOCKING and not a gap: the verify block belongs to the operator, not to this item. Empty when they agree, or when you cannot tell.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "what"],
        properties: {
          command: { type: "string", description: "The verify command, verbatim from the task." },
          what: {
            type: "string",
            description:
              "The disagreement, one sentence, quoting the PLAN text it contradicts. An assertion encoding a pre-change value is the canonical case.",
          },
        },
      },
    },
  },
} as const;

/**
 * The fixer's structured report. Its `rejected` list is what lets an invalid gap
 * DIE: a free-form "I think gap 3 is bogus" in a markdown report is read by nobody,
 * so the next audit re-raises it forever.
 */
export const FIX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["closed", "rejected"],
  properties: {
    closed: {
      type: "array",
      description: "One entry per gap you actually closed.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "how"],
        properties: {
          id: { type: "string", description: "The gap id, verbatim from the list you were given." },
          how: { type: "string", description: "The test you wrote and the edit that makes it RED." },
        },
      },
    },
    rejected: {
      type: "array",
      description:
        "One entry per gap you did NOT close because you judged it invalid. This is durable: the next audit is told not to re-raise it, so give a reason that stands on its own.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "why"],
        properties: {
          id: { type: "string", description: "The gap id, verbatim." },
          why: { type: "string", description: "Why it is not a real gap. Cite the test file/case that already covers it, or the reason the demand is unreachable." },
        },
      },
    },
    notes: { type: "string", description: "Optional: an existing test you believe is wrong but did NOT edit, or anything the driver should surface." },
  },
} as const;

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

export type Log = (line: string) => void;
