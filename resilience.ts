import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeAtomic } from "./paths.ts";
import { runChild } from "./rpc.ts";
import type { ChildOutcome } from "./rpc.ts";
import type { Log, SupervisorAsk, TransientPolicy } from "./types.ts";

// pi-subagents' native supervisor channel is a FILE channel, which is why this
// extension can answer a child's `contact_supervisor` ask without any RPC method:
//   <TEMP_ROOT_DIR>/supervisor-channels/<runId>-<agent>-<childIndex>/
//       requests/<requestId>.json   child writes, then polls replies/
//       replies/<requestId>.json    we write { type, requestId, message }
// (intercom/native-supervisor-channel.ts:19, :100-105, :225)
//
// TEMP_ROOT_DIR IS USER-SCOPED AND OVERRIDABLE, and getting that wrong silently disables this
// whole layer. It is `PI_SUBAGENTS_TEMP_ROOT` when set, else
// `<tmpdir>/pi-subagents-<scope>` where scope is `uid-<uid>` on any platform exposing getuid,
// else `user-<USERNAME|USER|LOGNAME>`, else `home-<sanitised homedir>`, else `shared`
// (shared/types.ts:2364-2414). A bare `<tmpdir>/pi-subagents` — what this file used to hardcode
// — is a directory nothing creates: `findPendingAsks` returned [] forever, so a NETWORK_DOWN
// report was never held and a decision ask was never answered. The only reason the guard suite
// did not catch it is that the probe wrote its fixture into this same constant.
function tempScopeId(): string {
  if (typeof process.getuid === "function") return `uid-${process.getuid()}`;
  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const v = process.env[key];
    if (v) return `user-${v.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown"}`;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) return `home-${home.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown"}`;
  return "shared";
}

/**
 * Every root a supervisor channel can live under, most authoritative first. Scanning a list
 * rather than computing one root keeps a scope-id rule change in pi-subagents from silently
 * disabling the layer again — an extra root that does not exist costs one `existsSync`.
 *
 * A FUNCTION, not a constant: `PI_SUBAGENTS_TEMP_ROOT` and the directory's existence are both
 * runtime facts, and a module-load snapshot of either is how a path bug becomes invisible.
 */
export function supervisorChannelRoots(): string[] {
  const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  return [
    ...(configured ? [join(resolve(configured), "supervisor-channels")] : []),
    join(tmpdir(), `pi-subagents-${tempScopeId()}`, "supervisor-channels"),
  ];
}

// The child's ask deadline defaults to 10 min (native-supervisor-channel.ts:23)
// and is read from the env, which children inherit from this process. A long
// outage must not time the child out while the driver is still backing off.
export const CHILD_ASK_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** Marker the fr-* agents are instructed to prefix a tool-level network report with. */
export const NETWORK_ASK_MARKER = "NETWORK_DOWN";

/**
 * What the driver replies to a child's NON-network `contact_supervisor` ask.
 *
 * A decision ask cannot be answered by the driver. It is not a supervisor — the whole point of
 * the ask is that the child hit something only the operator may decide — and the operator's
 * answer can take hours to arrive. Holding the child blocked on its channel for that long is
 * not an option either: pi-subagents DETACHES a child that waits on an unanswered ask
 * ("Detached for intercom coordination"), the driver then saw only `status: "paused"`, and the
 * question itself reached nobody. Measured on item mm-prefix-moss: the recorded note was
 * `Implementer ended with status "paused". Summary: Detached for intercom coordination before
 * task completion.` — the four decisions the child actually needed were readable only inside
 * its own report file.
 *
 * So the child is released immediately with an instruction to STOP and write the question
 * down, the item is paused as a DECISION pause with the question stored verbatim, and the
 * question is reported to the supervising session. The answer comes back as `fr_batch action
 * "continue", answer: "..."`, which revives that exact child session, so nothing it already
 * did is redone.
 */
export const DECISION_DIRECTIVE = [
  "DRIVER: I am a batch driver, not a supervisor — I cannot make this decision, and nobody is",
  "watching this channel. Do NOT guess, do NOT implement a workaround, do NOT ask again.",
  "",
  "End your turn now, and open your final report with a section titled `DECISION NEEDED` holding:",
  "the question, each option with the evidence you measured for it, and your recommendation.",
  "Leave every file you have already written in place.",
  "",
  "The batch stops on your item and shows your question to the supervising session verbatim. That",
  "session's decision is delivered by reviving THIS session, so your context and your work survive",
  "— you will be told to continue from exactly here.",
].join("\n");

/** What pi-subagents reports when it detaches a child that is waiting on the supervisor. */
export const INTERCOM_DETACH_MARK = /detached for intercom coordination/i;

/**
 * Conservative allowlist. Anything not matched here is treated as a REAL failure,
 * because retrying a real failure wastes an hour and hides a bug.
 *
 * Deliberately absent: bare "timeout"/"timed out". Our own wall-clock expiry is a
 * budget/scope problem that needs human eyes, not another 90-minute attempt.
 */
export const TRANSIENT_SIGNATURES: RegExp[] = [
  // socket / DNS / TLS
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bECONNABORTED\b/i,
  /\bETIMEDOUT\b/i,
  /\bENOTFOUND\b/i,
  /\bEAI_AGAIN\b/i,
  /\bEPIPE\b/i,
  /\bEHOSTUNREACH\b/i,
  /\bENETUNREACH\b/i,
  /\bENETDOWN\b/i,
  /socket hang up/i,
  // undici / Node's own connect-failure wording, which none of the neighbours above reach.
  // Reported from a real batch: `The pending stream has been canceled (caused by: Client network
  // socket disconnected before secure TLS connection was established)` matched ZERO signatures, so
  // the six-attempt retry loop never ran and the item blocked. Four items lost hours to it.
  //
  // `socket hang up` is a different sentence from `socket disconnected`; `\bTLS\b.*handshake|alert`
  // does not reach `before secure TLS connection was established`, where TLS is followed by neither
  // word. Three separate entries rather than one clever pattern, because each half of that message
  // has been seen on its own.
  /socket disconnected/i,
  /before secure TLS connection/i,
  /pending stream (?:has been )?canceled/i,
  /premature close/i,
  /network (?:error|is unreachable|is down)/i,
  /fetch failed/i,
  /getaddrinfo/i,
  /\bTLS\b.*(?:handshake|alert)/i,
  /certificate.*(?:expired|verify)/i,
  // HTTP transients
  /\b(?:408|425|429|500|502|503|504|529)\b/,
  /too many requests/i,
  /rate ?limit/i,
  /overloaded/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway time-?out/i,
  /server (?:error|had an error)/i,
  /internal server error/i,
  /(?:temporarily|momentarily) unavailable/i,
  /capacity/i,
  /upstream (?:error|connect)/i,
  /connection (?:error|closed|reset|aborted)/i,
  /stream (?:error|interrupted|closed)/i,
  // `ended` is a fourth word for the same event, and its absence cost a whole item: a Bedrock
  // response stream died mid-write with "Bedrock stream ended without a stop reason", which
  // matched nothing here, was therefore filed as a REAL failure, and blocked an implementer that
  // had already written three complete files and was starting the fourth. With `resumeOnRetry`
  // that child would have been revived with its context and those files intact.
  /stream ended without a stop reason/i,
  /stream (?:ended|terminated) (?:unexpectedly|prematurely|without)/i,
  /unexpected end of (?:stream|response|json)/i,
  /api ?error/i,
  // A bare "aborted" from a model attempt. The child cannot report a provider
  // outage itself (it is a `pi --mode json -p` subprocess and the failure is in
  // the harness), so this is how one surfaces: one modelAttempt, success false,
  // error "aborted", with the child mid-work and progressing normally. The guards
  // at the top of transientReason already exclude OUR own decisions — stopped /
  // interrupted / timedOut — so this cannot swallow a deliberate cancellation.
  // Retry here means `resume`, which revives that exact child with its context
  // and its already-written files intact, so a false positive costs one resume
  // while a false negative costs the whole item.
  /\baborted\b/i,
];

/**
 * The matched signature, or null.
 *
 * Matched against the WHOLE message, which is why no `caused by:` unwrapping happens here. A report
 * suggested adding it, on the reading that the table only saw the outermost sentence — but every
 * signature is an unanchored substring pattern, so a fault named only inside `(caused by: ECONNRESET)`
 * is already found: the parenthesis is part of the string being tested. An unwrapping pass was
 * written, and the mutation suite proved it could not change a single verdict, because every chain
 * element is a substring of the text the first element already is. It was removed rather than kept as
 * a defence that defends nothing.
 *
 * What DID need fixing was the table's contents — see the undici entries above.
 */
export function transientHit(text: string | undefined): string | null {
  if (!text) return null;
  for (const re of TRANSIENT_SIGNATURES) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/**
 * QUOTA / RATE-LIMIT signatures — a SUBSET of the transient ones, split out because they recover
 * on a different timescale and so need a different budget, not a different verdict.
 *
 * A 502 clears in seconds. An `insufficient_quota` 429 is a SPEND CAP: it clears when a rolling
 * window rolls over or when a human raises a limit. Measured here: the batch's `implementer` role
 * hit `429 insufficient_quota` and the shared 6-attempt / 300s-cap budget was spent in ~13
 * minutes, after which the batch PAUSED and waited for a human to type "continue" — for a
 * condition that fixes itself. That is the failure this split removes.
 *
 * Matching is on the reason string `transientHit` already returned, so there is ONE signature
 * list and this only re-reads its verdict. A second independent scan of the raw text would be a
 * second classifier, and two classifiers drift.
 */
const QUOTA_SIGNATURES: RegExp[] = [
  /\b429\b/,
  /insufficient[_ ]quota/i,
  /\bquota\b/i,
  /rate ?limit/i,
  /too many requests/i,
];

/** True when a transient reason is a quota/rate-limit refusal rather than a transport fault. */
export function isQuotaReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return QUOTA_SIGNATURES.some((re) => re.test(reason));
}

/** Returns the matched signature when the outcome looks like an outage, else null. */
/**
 * A child that produced NOTHING and died far inside its own budget.
 *
 * Wording-independent, and that is the point: the signature table is a list of sentences other
 * people's libraries happen to emit today, so every entry is one provider upgrade away from being
 * one word short. This asks a structural question instead — a child that ran 7 minutes against a
 * 3-hour budget, wrote no report and produced no summary is not a considered failure. A real one
 * arrives WITH something: a report naming what it could not do, or a non-empty summary.
 *
 * Deliberately narrow, because a false positive here costs one resume while a false negative costs
 * the item: it requires no artifact, no summary, and under a tenth of the budget.
 */
export function noOutputEarlyDeath(o: ChildOutcome, budgetMs: number, elapsedMs: number | undefined): boolean {
  if (o.artifactPath || (o.summary ?? "").trim() || (o.structuredOutput !== undefined && o.structuredOutput !== null)) return false;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return false;
  if (elapsedMs === undefined || !Number.isFinite(elapsedMs)) return false;
  return elapsedMs < budgetMs / 10;
}

export function transientReason(o: ChildOutcome, budgetMs?: number, elapsedMs?: number): string | null {
  // A child the driver itself stopped/interrupted, or that blew its wall clock, is
  // never "transient" — those are our decisions or a budget problem.
  if (o.stopped || o.interrupted || o.timedOut) return null;
  if (o.status === "complete" || o.status === "completed" || o.status === "success") return null;
  const haystacks = [o.error, o.summary, ...(o.modelAttempts ?? []).map((a) => a.error)];
  for (const h of haystacks) {
    const hit = transientHit(h);
    if (hit) return hit;
  }
  if (budgetMs !== undefined && noOutputEarlyDeath(o, budgetMs, elapsedMs)) {
    return `no output, died after ${Math.round((elapsedMs ?? 0) / 1000)}s of a ${Math.round(budgetMs / 1000)}s budget`;
  }
  return null;
}

/**
 * Why a child produced no outcome. THREE cases, decided in one place.
 *
 * A pure function on purpose: the wallclock branch is otherwise unreachable in a guard suite, because
 * rpc.ts adds a hardcoded 60s grace to every child budget and no test should pay a minute to observe a
 * branch. Keeping the decision here means it can be asserted directly, and the driver's job shrinks to
 * acting on the answer.
 */
export function classifyLaunchFailure(e: Error, aborted: boolean): { kind: "stopped" | "timeout" | "failure"; runId?: string } {
  if (aborted) return { kind: "stopped" };
  if (e.message.startsWith("WALLCLOCK:")) return { kind: "timeout", runId: runIdOfWallclock(e.message) };
  return { kind: "failure" };
}

/** The run id a WALLCLOCK error carries, so the caller can name the child it abandoned. */
export function runIdOfWallclock(message: string): string | undefined {
  return /\[run ([^\]]+)\]/.exec(message)?.[1];
}

/** Same classification for a thrown error (spawn RPC failure, hung host). */
export function transientThrowReason(e: Error): string | null {
  if (e.message.startsWith("WALLCLOCK:") || e.message === "aborted") return null;
  if (/no RPC reply within/.test(e.message)) return "rpc-unresponsive";
  return transientHit(e.message);
}

export function backoffDelay(attempt: number, p: TransientPolicy): number {
  const raw = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** attempt);
  return Math.round(raw * (0.5 + Math.random())); // full jitter around the target
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      res();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      rej(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** True when the probe URL answers. No probe configured -> null (unknown). */
export async function probeOnline(p: TransientPolicy): Promise<boolean | null> {
  if (!p.probeUrl) return null;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8_000);
    const r = await fetch(p.probeUrl, { method: "HEAD", signal: ac.signal });
    clearTimeout(t);
    // Any HTTP answer proves the path is up; 4xx from an auth-gated URL is fine.
    return r.status > 0;
  } catch {
    return false;
  }
}

/**
 * Wait out one backoff step. With a probe configured, poll it so a recovered
 * network shortens the wait instead of idling for the full delay.
 */
export async function waitForRecovery(ms: number, p: TransientPolicy, signal: AbortSignal | undefined, log: Log): Promise<void> {
  if (!p.probeUrl) return void (await sleep(ms, signal));
  const step = Math.min(15_000, Math.max(2_000, Math.round(ms / 6)));
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await sleep(Math.min(step, until - Date.now()), signal);
    if ((await probeOnline(p)) === true) {
      log("    probe: online — ending the wait early");
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// tool-level outage: answer the child's contact_supervisor ask
// ---------------------------------------------------------------------------


/**
 * Every UNANSWERED `contact_supervisor` request belonging to this run, network or not.
 *
 * Reading only the network ones is what made a decision ask invisible: the file sat in
 * `requests/` with no reply, pi-subagents detached the child, and the driver reported a bare
 * `status: "paused"`. Both kinds are read here and separated by `isNetwork`, because they get
 * opposite treatment — network asks are HELD and released, decision asks are released at once
 * and stop the batch with the question attached.
 */
export function findPendingAsks(asyncId: string): SupervisorAsk[] {
  const out: SupervisorAsk[] = [];
  for (const root of supervisorChannelRoots()) {
    if (!existsSync(root)) continue;
    let dirs: string[];
    try {
      dirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const d of dirs) {
      // Channel dirs are `<runId>-<agent>-<childIndex>`, and that runId is the ASYNC RUN's id
      // (subagent-runner.ts passes `runId: ctx.id` into the child's env), which is the id spawn
      // handed back — so a prefix match is the right test.
      if (!d.startsWith(`${asyncId}-`)) continue;
      const reqDir = join(root, d, "requests");
      const repDir = join(root, d, "replies");
      let files: string[];
      try {
        files = readdirSync(reqDir).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }
      for (const f of files) {
        const requestId = f.replace(/\.json$/, "");
        if (existsSync(join(repDir, f))) continue; // already answered
        try {
          const req = JSON.parse(readFileSync(join(reqDir, f), "utf8")) as { reason?: string; message?: string; expiresAt?: number };
          // An expired request is one the CHILD has already given up on (it stops polling at its
          // deadline and the file is never cleaned up), so answering it releases nobody and
          // reporting it would pause the item on a question that is no longer being asked.
          if (typeof req.expiresAt === "number" && req.expiresAt > 0 && req.expiresAt < Date.now()) continue;
          const text = `${req.reason ?? ""} ${req.message ?? ""}`;
          const isNetwork = text.includes(NETWORK_ASK_MARKER) || transientHit(text) !== null;
          out.push({ channelDir: join(root, d), requestId, reason: req.reason, message: req.message, isNetwork });
        } catch {
          /* a half-written request file will be picked up on the next poll */
        }
      }
    }
  }
  return out;
}

/** One ask, indented, for a tool result the supervising session reads. */
export function formatAsk(a: SupervisorAsk): string {
  const body = (a.message ?? "").trim() || "(no message)";
  return [`  reason: ${a.reason ?? "(none)"}`, ...body.split("\n").map((l) => `  ${l}`)].join("\n");
}

export function answerAsk(ask: SupervisorAsk, message: string): void {
  const file = join(ask.channelDir, "replies", `${ask.requestId}.json`);
  writeAtomic(file, `${JSON.stringify({ type: "subagent.supervisor.reply", requestId: ask.requestId, message }, null, 2)}\n`);
}

/**
 * While a child runs, watch its `contact_supervisor` channel.
 *
 * TOOL-level network failure: the child stays alive and blocked; we hold it there through the
 * same backoff and reply "continue" once the network is back.
 *
 * Anything else is a DECISION ask, which this driver structurally cannot answer (it is a batch
 * driver, not a supervisor, and the operator's answer can be hours away). It is answered at
 * once with DECISION_DIRECTIVE — stop, write the question into the report — and recorded so
 * the caller can pause the item and surface the question verbatim instead of reporting an
 * opaque "status: paused".
 *
 * Returns a stop() to call when the child finishes, plus the decision asks seen.
 */
export function watchSupervisorAsks(
  getAsyncId: () => string | undefined,
  p: TransientPolicy,
  log: Log,
  signal: AbortSignal | undefined,
): { stop: () => void; blockedCount: () => number; decisions: () => SupervisorAsk[] } {
  let stopped = false;
  let blocked = 0;
  const handled = new Set<string>();
  const decisions: SupervisorAsk[] = [];

  const tick = async (): Promise<void> => {
    while (!stopped && !signal?.aborted) {
      await sleep(3_000, signal).catch(() => {
        stopped = true;
      });
      if (stopped) return;
      const id = getAsyncId();
      if (!id) continue;
      for (const ask of findPendingAsks(id)) {
        if (handled.has(ask.requestId)) continue;
        handled.add(ask.requestId);
        if (!ask.isNetwork) {
          decisions.push(ask);
          log(`    child asked the supervisor for a DECISION — releasing it to write the question down:`);
          for (const l of formatAsk(ask).split("\n")) log(`    ${l}`);
          answerAsk(ask, DECISION_DIRECTIVE);
          continue;
        }
        blocked += 1;
        log(`    child reported a tool-level network failure; holding it blocked (${ask.requestId})`);
        for (let attempt = 0; attempt <= p.maxRetries && !stopped; attempt++) {
          if ((await probeOnline(p)) === true) break;
          const delay = backoffDelay(attempt, p);
          log(`    network wait ${attempt + 1}/${p.maxRetries + 1}: ${Math.round(delay / 1000)}s`);
          await waitForRecovery(delay, p, signal, log).catch(() => {
            stopped = true;
          });
        }
        // Even when the probe never confirmed, release the child: it is the thing
        // holding a real connection, so its next attempt is a better test than
        // our probe, and leaving it blocked would burn its ask deadline.
        answerAsk(ask, "continue");
        log(`    released the child (${ask.requestId})`);
      }
    }
  };
  void tick();
  return { stop: () => void (stopped = true), blockedCount: () => blocked, decisions: () => decisions };
}

// ---------------------------------------------------------------------------
// the resilient child: outer-only network retry, then pause
// ---------------------------------------------------------------------------

/** Thrown when the outer retry budget is spent and a human has to decide. */
export class NetworkPause extends Error {
  // Plain fields, not constructor parameter properties: TS parameter properties are a
  // runtime feature, so node's type-stripping loader cannot execute them and the guard
  // probes import this module directly.
  readonly childId: string | undefined;
  readonly reason: string;
  readonly attempts: number;
  constructor(childId: string | undefined, reason: string, attempts: number) {
    super(`network unreachable after ${attempts} attempt(s) (last signature: ${reason})`);
    this.childId = childId;
    this.reason = reason;
    this.attempts = attempts;
    this.name = "NetworkPause";
  }
}

export async function runChildResilient(
  pi: ExtensionAPI,
  rpc: { call: <T>(m: string, p: unknown, t?: number) => Promise<T> },
  params: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  policy: TransientPolicy,
  log: Log,
  opts: { resumeOf?: string; resumeMessage?: string; quotaPolicy?: TransientPolicy } = {},
): Promise<ChildOutcome> {
  let lastChildId: string | undefined = opts.resumeOf;
  let lastReason = "unknown";
  // TWO BUDGETS, COUNTED SEPARATELY. A quota refusal recovers on a different timescale from a
  // transport fault, so they must not spend each other's attempts: three network blips during a
  // long quota wait would otherwise end the item, and a quota wait would otherwise consume the
  // budget that exists to ride out a blip. `attempt` stays the loop counter (it drives resume vs
  // fresh spawn); these two only decide when to give up and how long to sleep.
  const quotaPolicy = opts.quotaPolicy ?? policy;
  let netTries = 0;
  let quotaTries = 0;

  for (let attempt = 0; ; attempt++) {
    let liveId: string | undefined;
    const startedAt = Date.now();
    const watcher = watchSupervisorAsks(() => liveId, policy, log, signal);

    let outcome: ChildOutcome | undefined;
    let thrown: Error | undefined;
    try {
      outcome = await runChild(
        pi,
        rpc,
        lastChildId && (attempt > 0 || opts.resumeOf) && policy.resumeOnRetry
          ? {
              ...params,
              __resumeOf: lastChildId,
              __resumeMessage:
                // A decision pause resumes with the ANSWER; a network pause resumes with
                // "the outage is over". Reviving a decision-paused child without its answer
                // just makes it ask again, which is why `continue` demands one.
                attempt === 0 && opts.resumeMessage
                  ? opts.resumeMessage
                  : "The network outage is over. Continue exactly where you left off; do not restart the task.",
            }
          : params,
        timeoutMs,
        signal,
        (id) => {
          liveId = id;
          lastChildId = id;
        },
      );
    } catch (e) {
      thrown = e as Error;
    } finally {
      watcher.stop();
    }

    if (outcome) {
      // Sweep the channel once more after the outcome. A child that detaches the instant it
      // asks can finish INSIDE the watcher's 3s poll gap, and its request file outlives it
      // (unanswered requests are never cleaned up), so this is what stops the question from
      // being lost exactly in the case the child could not report it itself.
      const seen = new Set(watcher.decisions().map((a) => a.requestId));
      const late = findPendingAsks(outcome.asyncId).filter((a) => !a.isNetwork && !seen.has(a.requestId));
      for (const a of late) answerAsk(a, DECISION_DIRECTIVE);
      const asks = [...watcher.decisions(), ...late];
      if (asks.length > 0) outcome.decisionAsks = asks;
    }

    // The child's own budget and how long it actually lasted, so classification has a
    // wording-independent signal to fall back on when the signature table is one phrase short.
    const elapsedMs = Date.now() - startedAt;
    if (outcome && !transientReason(outcome, timeoutMs, elapsedMs)) return outcome; // success OR a real failure
    const reason = outcome ? transientReason(outcome, timeoutMs, elapsedMs) : transientThrowReason(thrown!);
    if (!reason) throw thrown; // a real error: wall clock, abort, or an unrecognised fault
    lastReason = reason;

    // Pick the budget that matches what actually failed, and charge only that one.
    const quota = isQuotaReason(reason);
    const p = quota ? quotaPolicy : policy;
    const tries = quota ? quotaTries++ : netTries++;

    if (tries >= p.maxRetries) throw new NetworkPause(lastChildId, lastReason, tries + 1);

    const delay = backoffDelay(tries, p);
    log(
      `    ${quota ? "quota" : "transient"} failure (${reason}) — retry ${tries + 1}/${p.maxRetries} in ${Math.round(delay / 1000)}s`,
    );
    await waitForRecovery(delay, p, signal, log);
  }
}

// ---------------------------------------------------------------------------
// verdict parsing — fails closed
// ---------------------------------------------------------------------------
