import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { baselinePath, siblingsPath, writeAtomic } from "./paths.ts";
import { readsBlock, rulesBlock } from "./prompts.ts";
import { NetworkPause, runChildResilient } from "./resilience.ts";
import type { ChildOutcome } from "./rpc.ts";
import { bugProtocolFor, setProgress, verifyFor } from "./store.ts";
import type { Baseline, BugMode, BugProtocol, ChildRole, Log, Phase, Queue, QueueItem, TransientPolicy } from "./types.ts";

// ---------------------------------------------------------------------------
// the bug pipeline
//
//   ⓪ capture   run the pin, prove it is RED, freeze that state
//   ① fix       one child, bounded rounds
//   ② gate      the pin turned green · no regression · the pin itself untouched
//   ③ scope     read-only scout for sibling call sites — non-blocking
//   ④ commit    the driver's shared commit block
//
// WHY THERE IS NO AUDIT LOOP HERE. The FR pipeline's frozen contract, token-scoped gap
// partitioning and three convergence guards exist because the FR implementer writes the tests it
// will be judged by, so under-testing is invisible to the project's own gate and only an
// adversarial auditor can catch it. That audit is open-ended, hence the machinery that makes it
// terminate.
//
// A bug fixture inverts the premise: the pin PRE-EXISTS the fix and was written by someone who
// did not have to make it pass. So the verdict comes from the project's own runner, and the
// anti-cheat comes from comparing against a baseline captured before anything was edited —
// exit codes and a JSON map, not a judgement. No contract, no ledger, no auditor.
//
// The one cheat that survives that argument is the fixer editing its own spec: the pin is a file
// in the tree and the fixer holds `edit`/`write`. That is what the immutability gate is for, and
// it is the reason this pipeline exists in this shape rather than the obvious one.
// ---------------------------------------------------------------------------

/** How many result rows were unusable, and why — surfaced so a crash never reads as coverage. */
export interface ResultScan {
  scenarios: Record<string, boolean>;
  /** Rows that parsed as JSON but are not scenarios (a crash marker, a summary line, a typo). */
  skipped: number;
  /** Lines that are not JSON at all. */
  torn: number;
}

export type RunOutcome =
  | { ok: true; exitCode: number; scan: ResultScan | null }
  | { ok: false; why: string };

/**
 * Substitute the protocol's tokens. ONE pass, and the replacement is never rescanned: a fixture
 * path that itself contains `{fixture}` would otherwise loop or resolve somewhere else entirely.
 */
export function substituteTokens(text: string, fixture: string, plan: string): string {
  return text.replace(/\{(fixture|plan)\}/g, (_m, k: string) => (k === "fixture" ? fixture : plan));
}

/**
 * Single-quote a value for `bash -lc`. The fixture path is user data reaching a shell, and an
 * unquoted one containing a space arrives as two arguments — the runner then judges the wrong
 * thing, usually by finding nothing and reporting success.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The command a protocol entry becomes, with every token substituted and shell-quoted. */
export function buildRunCommand(cmd: string, fixture: string, plan: string): string {
  return substituteTokens(cmd, shellQuote(fixture), shellQuote(plan));
}

/**
 * Parse a JSONL results sink.
 *
 * A row counts as a scenario ONLY with a non-empty string name and a real boolean pass field.
 * Everything else is counted, not merged: a runner that dies mid-suite may append a well-formed
 * row that is not a scenario at all, and keying it by an absent name would turn a crash into
 * "new coverage" and the gate green. Duplicates are a hard error rather than last-write-wins,
 * because a failing row silently overwritten by a passing one is the cheapest possible false green.
 */
export function parseResults(text: string, proto: BugProtocol): ResultScan | { error: string } {
  const scan: ResultScan = { scenarios: {}, skipped: 0, torn: 0 };
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(t) as Record<string, unknown>;
    } catch {
      scan.torn++;
      continue;
    }
    const name = row[proto.nameField];
    const passed = row[proto.passField];
    if (typeof name !== "string" || !name.trim() || typeof passed !== "boolean") {
      scan.skipped++;
      continue;
    }
    if (Object.hasOwn(scan.scenarios, name)) {
      return { error: `the results sink lists "${name}" twice — one row would silently overwrite the other` };
    }
    scan.scenarios[name] = passed;
  }
  return scan;
}

/**
 * Run the pin once and read its verdict.
 *
 * THE SINK IS DELETED FIRST. Otherwise a stale results file from an earlier pass, plus a runner
 * or wrapper that stops writing one, is a false green: existence and content both look right and
 * nothing establishes that THIS run produced them. After the delete, existence proves authorship.
 */
export async function runFixture(
  pi: ExtensionAPI,
  cwd: string,
  proto: BugProtocol,
  fixture: string,
  plan: string,
  timeoutMs: number,
  log: Log,
): Promise<RunOutcome> {
  const sink = proto.results === null ? null : substituteTokens(proto.results, fixture, plan);
  if (sink) rmSync(join(cwd, sink), { force: true });

  let exitCode = 0;
  for (const raw of proto.run) {
    const cmd = buildRunCommand(raw, fixture, plan);
    log(`  pin: ${cmd}`);
    const r = await pi.exec("bash", ["-lc", cmd], { cwd, timeout: timeoutMs });
    const code = r.code ?? -1;
    // `killed` is how ExecResult reports a timeout or an abort. It must be distinguished from a
    // plain non-zero exit: a killed run wrote a PARTIAL sink at best, and reading that as the
    // verdict compares half a run against a whole baseline.
    if (r.killed) {
      return { ok: false, why: `the pin's command \`${cmd}\` was killed — it exceeded queue.verifyTimeoutMs (${timeoutMs}ms).` };
    }
    // FIRST non-zero wins. Keeping the last command's code lets a red build followed by a `true`
    // read as exit 0, which would disable the exit-code half of every gate below.
    if (code !== 0 && exitCode === 0) exitCode = code;
  }

  if (!sink) return { ok: true, exitCode, scan: null };
  const p = join(cwd, sink);
  if (!existsSync(p)) {
    return {
      ok: false,
      why: [
        `the pin was configured with a results sink but wrote none: ${sink}`,
        "",
        "That is an incomplete run, not a verdict. This driver will not fall back to the exit code",
        "here: doing so silently downgrades the gate to one bit and loses the comparison that",
        "catches a weakened control. Fix the runner, or set bugProtocol.results to null to declare",
        "that this pin has no per-scenario record.",
      ].join("\n"),
    };
  }
  const parsed = parseResults(readFileSync(p, "utf8"), proto);
  if ("error" in parsed) return { ok: false, why: `${sink}: ${parsed.error}` };
  if (Object.keys(parsed.scenarios).length === 0) {
    return {
      ok: false,
      why: `${sink} yielded no usable scenario rows (${parsed.torn} unparseable, ${parsed.skipped} non-scenario). Treated as an incomplete run, not as a pass.`,
    };
  }
  return { ok: true, exitCode, scan: parsed };
}

export interface Comparison {
  unfixed: string[];
  regressions: string[];
  missing: string[];
  added: string[];
}

/**
 * Compare an after-run against the captured baseline, KEYED ON THE BASELINE.
 *
 * Iterating the after-set instead would make deleting a scenario invisible, which is the second
 * cheapest false green after weakening one. `regressions` is the anti-cheat that matters: a
 * control that passed before and fails now means the fix satisfied the reproduction by breaking
 * something the pin's author put there precisely to catch that.
 */
export function compareToBaseline(baseline: Baseline, after: Record<string, boolean>): Comparison {
  const c: Comparison = { unfixed: [], regressions: [], missing: [], added: [] };
  for (const [name, was] of Object.entries(baseline.scenarios)) {
    if (!Object.hasOwn(after, name)) {
      c.missing.push(name);
      continue;
    }
    const now = after[name];
    if (!was && !now) c.unfixed.push(name);
    if (was && !now) c.regressions.push(name);
  }
  for (const name of Object.keys(after)) if (!Object.hasOwn(baseline.scenarios, name)) c.added.push(name);
  return c;
}

/** Every path git reports as changed: tracked edits AND untracked additions. */
export async function changedPaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  // Used for `requirePin` and `requireMechanismTouch`, which ask "what did the fix touch?" — a
  // question about the diff. Pin IMMUTABILITY does NOT use this: see pinDigest, which asks a
  // different question that no git configuration can answer wrongly.
  const r = await pi.exec("git", ["status", "--porcelain", "-z"], { cwd });
  const recs = (r.stdout ?? "").split("\0").filter((s) => s.length > 0);
  const out: string[] = [];
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    out.push(rec.slice(3));
    // A rename or copy emits `XY new\0old\0`: the second record is a BARE path with no status
    // prefix, so slicing three characters off it would corrupt it into a different path.
    if ((xy[0] === "R" || xy[0] === "C") && i + 1 < recs.length) out.push(recs[++i]);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * A content digest of every file under the pin paths.
 *
 * THIS, NOT A DIFF, IS WHAT PROTECTS THE PIN. Five independent ways exist to make git stop
 * reporting a change to a tracked file, and every one was reachable by the single child this gate
 * exists to constrain:
 *   * `git update-index --assume-unchanged` / `--skip-worktree` silences status AND diff;
 *   * `.git/info/exclude`, a nested `.gitignore`, `core.excludesFile` or
 *     `status.showUntrackedFiles=no` silences the untracked half;
 *   * a commit made by the fixer moves HEAD, so a diff against HEAD sees a clean tree;
 *   * a staged rename moves the file out of the pathspec entirely;
 *   * a symlinked pin puts the real bytes outside every pathspec, since `git diff -- <link>` does
 *     not traverse into the target.
 * A hash of the bytes on disk answers none of those questions and cannot be configured.
 *
 * Walked on the FILESYSTEM rather than through the index, so an added file under a fixture appears
 * as a new key and a deleted one as a missing key.
 *
 * The symlink case is closed by `git hash-object`, which reads THROUGH a link (measured: hashing a
 * link and hashing its target give the same object id, and editing the target changes it). An
 * earlier draft also called `realpathSync` here and the comment claimed that was the defence; the
 * mutation suite showed removing it broke nothing, because `statSync` follows links too. It is gone
 * rather than kept as a second belt with a false label.
 */
export async function pinDigest(pi: ExtensionAPI, cwd: string, pins: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = (rel: string): string[] => {
    const abs = join(cwd, rel);
    let st;
    try {
      // statSync, not lstatSync: a symlinked pin must be followed, not described.
      st = statSync(abs);
    } catch {
      return [];
    }
    if (st.isFile()) return [rel];
    if (!st.isDirectory()) return [];
    const kids: string[] = [];
    for (const e of readdirSync(abs)) {
      // Dot-entries are skipped so a runner's own sink and cache stay out of the digest without
      // this driver naming any project's conventions.
      if (e.startsWith(".")) continue;
      kids.push(...walk(`${rel}/${e}`));
    }
    return kids;
  };
  const files = [...new Set(pins.flatMap(walk))].sort();
  if (files.length === 0) return out;
  // `git hash-object` reads the WORKING TREE, not the index, so nothing under .git can change the
  // answer. Batched because a fixture can hold dozens of files.
  const r = await pi.exec("git", ["hash-object", "--", ...files], { cwd });
  const hashes = (r.stdout ?? "").trim().split("\n");
  files.forEach((f, i) => {
    out[f] = hashes[i] ?? "missing";
  });
  return out;
}

/** Paths whose content moved between two digests, in either direction. */
export function digestDrift(before: Record<string, string>, after: Record<string, string>): string[] {
  const drift: string[] = [];
  for (const [f, h] of Object.entries(before)) {
    if (!Object.hasOwn(after, f)) drift.push(`${f} (removed)`);
    else if (after[f] !== h) drift.push(`${f} (modified)`);
  }
  for (const f of Object.keys(after)) if (!Object.hasOwn(before, f)) drift.push(`${f} (added)`);
  return drift;
}

/**
 * Pin paths whose changes git has been told to stop reporting.
 *
 * `git update-index --assume-unchanged` (and `--skip-worktree`) make a tracked file's edits
 * invisible to BOTH `git status --porcelain` and `git diff HEAD` — measured, both go silent — so
 * without this the immutability gate can be switched off from inside the tree by the one child it
 * exists to constrain. And `git add -A` then does not stage the edit either, so the item would
 * commit as green with the defect intact and the laundered pin not even in the commit: a false
 * green with no evidence left.
 *
 * `git ls-files -v` is the only probe that sees it: normal tracked files are `H`, suppressed ones
 * carry a lowercase letter or `S`.
 */
export async function suppressedPins(pi: ExtensionAPI, cwd: string, pins: string[]): Promise<string[]> {
  const r = await pi.exec("git", ["ls-files", "-v", "--", ...pins], { cwd });
  return (r.stdout ?? "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 2 && !l.startsWith("H "))
    .map((l) => `${l.slice(2)} (git status letter "${l[0]}")`);
}

/** Extract `file:line` citations from a report, so the diff can be checked against them. */
export function citedFiles(report: string): string[] {
  const out = new Set<string>();
  for (const m of report.matchAll(/([\w][\w./-]*\.\w+):(\d+)/g)) out.add(m[1]);
  return [...out];
}

// ---------------------------------------------------------------------------
// runBugItem
// ---------------------------------------------------------------------------

/**
 * Everything the bug pipeline borrows from the driver's per-item scope.
 *
 * A parameter bag rather than a shared module, and the reason is mechanical: `driver.ts` must
 * import this file, so this file importing `driver.ts` is a cycle that `tests/probe_modules.ts`
 * fails the suite on — including a type-only edge. Eight of these are genuine closures over
 * per-item state and could not be imported anyway. The other two, `runVerify` and
 * `childOutcomeFailure`, are module-level exports of `driver.ts`; they travel here instead of
 * moving to a leaf because `tests/mutation.mjs` pins `childOutcomeFailure` to `driver.ts` by
 * filename, and a move would make that mutation match nothing and exit 1.
 */
export interface BugItemCtx {
  pi: ExtensionAPI;
  rpc: { call: <T>(m: string, p: unknown, t?: number) => Promise<T> };
  cwd: string;
  item: QueueItem;
  q: Queue;
  log: Log;
  /** Child artifact directory. */
  dir: string;
  policy: TransientPolicy;
  quotaPolicy: TransientPolicy;
  signal: AbortSignal | undefined;

  fixRoundsSoFar: number;

  spawnFor: (role: ChildRole) => { model?: string };
  block: (why: string) => string;
  handlePause: (phase: Phase, e: NetworkPause, round: number) => Promise<boolean>;
  pausedReturn: (phase: Phase) => string;
  abortStop: (phase: Phase, round: number) => string | null;
  decisionStop: (phase: Phase, o: ChildOutcome, round: number) => string | null;
  resumeFor: (phase: Phase) => { resumeOf?: string; resumeMessage?: string };
  stopNow: (where: string) => string | null;
  runVerify: (
    pi: ExtensionAPI,
    cwd: string,
    cmds: string[],
    timeoutMs: number,
    log: Log,
  ) => Promise<{ ok: true } | { ok: false; cmd: string; code: number; tail: string }>;
  childOutcomeFailure: (role: string, o: ChildOutcome) => string | null;
}

export type BugItemResult =
  /** The gate is green; the driver's shared commit block takes over. */
  | { outcome: "commit"; rounds: number }
  /** Nothing to do. Already recorded as `skipped`; the driver advances. */
  | { outcome: "skipped" }
  /** Terminal. The driver returns this text verbatim. */
  | { outcome: "return"; text: string };

/** The fixture path an item resolves to: explicit, else the report's own directory. */
export function fixtureOf(item: QueueItem): string {
  return item.fixture ?? dirname(item.plan);
}

function classify(code: number, proto: BugProtocol): "red" | "green" | "invalid" | "unmapped" {
  if (proto.greenExit.includes(code)) return "green";
  if (proto.redExit.includes(code)) return "red";
  if (proto.invalidExit.includes(code)) return "invalid";
  return "unmapped";
}

export async function runBugItem(ctx: BugItemCtx): Promise<BugItemResult> {
  const { pi, cwd, item, q, log } = ctx;
  const proto = bugProtocolFor(q, item);
  const fixture = fixtureOf(item);
  const bpath = baselinePath(cwd, item.id);

  // ---- pre-flight: the paths must exist before any child is spawned ----------
  // loadQueue validated the protocol's SHAPE and `add` validated the fixture at queue time, but a
  // hand-edited queue.json reaches neither. Blocking here costs milliseconds; discovering it from
  // a child that was handed a nonexistent path costs the whole item.
  const pins = proto.pinPaths.map((p) => substituteTokens(p, fixture, item.plan));
  for (const p of [item.plan, fixture, ...pins]) {
    if (!existsSync(join(cwd, p))) {
      return { outcome: "return", text: ctx.block(`Path not found: ${p} (resolved for item "${item.id}"). Nothing was spawned.`) };
    }
  }

  // ---- ⓪ capture ------------------------------------------------------------
  let baseline: Baseline;
  const resumed = existsSync(bpath);
  if (resumed) {
    // A RESUMED item must not re-capture. The tree already holds a partial fix, so a fresh capture
    // would record that as the "before" state and every later comparison would pass vacuously.
    let parsed: Baseline | null = null;
    try {
      parsed = JSON.parse(readFileSync(bpath, "utf8")) as Baseline;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed.mode !== "string" || typeof parsed.scenarios !== "object") {
      return {
        outcome: "return",
        text: ctx.block(
          [
            `The captured baseline for "${item.id}" is unreadable: ${bpath}`,
            "",
            "It is the only record of what was red before the fix, so it cannot be regenerated over a",
            `half-fixed tree. Clear the item and start it again: fr_batch action "reset", only: "${item.id}".`,
          ].join("\n"),
        ),
      };
    }
    if (parsed.fixture !== fixture || parsed.plan !== item.plan) {      return {
        outcome: "return",
        text: ctx.block(
          [
            `The captured baseline for "${item.id}" describes a different pin than the queue now names.`,
            `  baseline: fixture ${parsed.fixture} · plan ${parsed.plan}`,
            `  queue:    fixture ${fixture} · plan ${item.plan}`,
            "",
            `Judging one pin against another's red state is meaningless. Re-capture: fr_batch action "reset", only: "${item.id}".`,
          ].join("\n"),
        ),
      };
    }
    // A SCENARIO baseline with no failing row cannot have been produced by capture: capture refuses
    // an already-green pin and records a `skipped` item instead. So this shape is either a hand-edit
    // or a fixer's tamper — and it is the tamper worth making, because flipping every row to `true`
    // deletes every false->true requirement and makes the gate pass on any tree.
    //
    // Mid-item this is unreachable (the gate compares against the in-memory copy read at capture),
    // but `.pi/fr-batch/` is gitignored in a consuming repo, so nothing else can see a write to it
    // and the RESUME path reads it back.
    if (parsed.mode === "scenario" && Object.values(parsed.scenarios ?? {}).every((v) => v === true)) {
      return {
        outcome: "return",
        text: ctx.block(
          [
            `The captured baseline for "${item.id}" records no failing scenario: ${bpath}`,
            "",
            "Capture cannot produce that. An all-green pin is recorded as `skipped`, never as a baseline,",
            "so this file has been edited since — and an all-true baseline makes the gate pass on any tree,",
            "because there is no longer anything required to go from failing to passing.",
            "",
            `Discard it and capture the pin again: fr_batch action "reset", only: "${item.id}".`,
          ].join("\n"),
        ),
      };
    }
    baseline = parsed;
    log(`  baseline reused (${baseline.mode} mode, captured ${baseline.capturedAt})`);
  } else {
    // The pin must be COMMITTED, or immutability is unenforceable: `git status --porcelain` reports
    // nothing for a path git does not track, so an untracked fixture could be edited freely. A
    // fixture straight out of a capture workflow is untracked, so this is the normal first step.
    const tracked = await pi.exec("git", ["ls-files", "-z", "--", fixture, item.plan], { cwd });
    if (((tracked.stdout ?? "").trim().length === 0)) {      return {
        outcome: "return",
        text: ctx.block(
          [
            `The pin for "${item.id}" is not committed: git tracks no file under ${fixture} or at ${item.plan}.`,
            "",
            "This driver protects the pin by diffing it, and git reports no changes for a path it does",
            "not track — so an untracked pin has no protection at all and a fixer could edit the very",
            "assertion it is judged by. Commit the fixture and the report, then re-run.",
          ].join("\n"),
        ),
      };
    }

    // ...and its changes must be REPORTABLE. A pin already marked assume-unchanged is as
    // unprotected as an untracked one, and capture is where that has to be caught: after this
    // point the gate's diff would silently see nothing and read every edit as "the pin is intact".
    const suppressedAtCapture = await suppressedPins(pi, cwd, pins);
    if (suppressedAtCapture.length > 0) {
      return {
        outcome: "return",
        text: ctx.block(
          [
            `git has been told to stop reporting changes to "${item.id}"'s pin, so it cannot be protected:`,
            ...suppressedAtCapture.map((s) => `  - ${s}`),
            "",
            "Clear it with `git update-index --no-assume-unchanged <path>` (or `--no-skip-worktree`),",
            "confirm the pin still says what it should, then re-run.",
          ].join("\n"),
        ),
      };
    }

    log("  capture: proving the pin is red…");
    const run = await runFixture(pi, cwd, proto, fixture, item.plan, q.verifyTimeoutMs, log);
    if (!run.ok) return { outcome: "return", text: ctx.block(`Could not capture a baseline: ${run.why}`) };

    const mode: BugMode = run.scan ? "scenario" : "exit";
    const verdict = classify(run.exitCode, proto);
    const redRows = run.scan ? Object.entries(run.scan.scenarios).filter(([, ok]) => !ok).map(([n]) => n) : [];

    // ORDER MATTERS and it is exit-code-first. Written the other way round — "all rows pass ⇒
    // nothing to do" — a runner that reports every row green while forcing a non-zero exit (a
    // resource leak check, a watchdog) is silently SKIPPED instead of reported.
    if (verdict === "invalid") {
      return {
        outcome: "return",
        text: ctx.block(
          `The pin exited ${run.exitCode}, which this repo's bugProtocol maps to "cannot verify" (invalidExit). Nothing was captured and no child ran.`,
        ),
      };
    }
    if (verdict === "unmapped") {
      return {
        outcome: "return",
        text: ctx.block(
          `The pin exited ${run.exitCode}, which is in none of bugProtocol's redExit/greenExit/invalidExit sets. Treated as an incomplete run, not as a verdict.`,
        ),
      };
    }
    if (verdict === "green" && redRows.length > 0) {
      return {
        outcome: "return",
        text: ctx.block(
          [
            `The pin exited ${run.exitCode} (greenExit) while ${redRows.length} of its own scenario(s) report failure:`,
            ...redRows.slice(0, 10).map((n) => `  - ${n}`),
            "",
            "A runner whose exit code cannot report failure disables the red proof this pipeline starts",
            "from. Fix the runner or its wrapper before queueing this item.",
          ].join("\n"),
        ),
      };
    }
    if (verdict === "green") {
      const note = `Nothing to do: the pin was already green when the batch reached it (${mode} mode, exit ${run.exitCode}). No child ran and nothing was committed.`;
      setProgress(cwd, item.id, { status: "skipped", fixRounds: ctx.fixRoundsSoFar, note });
      pi.appendEntry("fr-batch", { item: item.id, status: "skipped", reason: "already-green" });
      log("  SKIPPED — the pin is already green");
      return { outcome: "skipped" };
    }
    if (mode === "scenario" && redRows.length === 0) {
      return {
        outcome: "return",
        text: ctx.block(
          `The pin exited ${run.exitCode} (redExit) but every scenario in its results sink passed. The exit code and the record disagree, so there is no red state to capture.`,
        ),
      };
    }

    baseline = {
      capturedAt: new Date().toISOString(),
      mode,
      fixture,
      plan: item.plan,
      exitCode: run.exitCode,
      scenarios: run.scan?.scenarios ?? {},
      head: (await pi.exec("git", ["rev-parse", "HEAD"], { cwd })).stdout?.trim() ?? "",
      pins: await pinDigest(pi, cwd, pins),
    };
    writeAtomic(bpath, `${JSON.stringify(baseline, null, 2)}\n`);
    log(
      mode === "scenario"
        ? `  baseline captured: ${redRows.length} red / ${Object.keys(baseline.scenarios).length} scenario(s) → ${bpath}`
        : `  baseline captured: exit ${run.exitCode}, EXIT MODE — one bit, no per-scenario comparison → ${bpath}`,
    );
  }

  // ---- ① fix → ② gate -------------------------------------------------------
  const report = existsSync(join(cwd, item.plan)) ? readFileSync(join(cwd, item.plan), "utf8") : "";
  const cited = citedFiles(report);
  const { cmds: verifyCmds, isDefault } = verifyFor(q, item);
  if (isDefault) log(`  (using queue.defaultVerify — ${verifyCmds.length} cmd(s))`);
  let round = ctx.fixRoundsSoFar;
  let lastRed = "";
  // A FRESH item is red by construction — ⓪ just proved it — so it goes straight to the fixer.
  // Evaluating the gate first would re-run the pin for a verdict we already have and, worse, spend
  // the project's whole build budget (`defaultVerify`) to learn nothing.
  //
  // A RESUMED item evaluates the gate first: the tree already holds a partial fix, so it may
  // already be green, and spending a child to rediscover that is the waste `continue` exists to
  // avoid. It is also where the immutability check earns its keep — if a previous round edited the
  // pin, that is caught before another child compounds it.
  let needFix = !resumed;

  for (;;) {
    {
      const s = ctx.stopNow(`inside ${item.id} (after ${round} fix round(s))`);
      if (s) return { outcome: "return", text: s };
    }

    if (needFix) {
      if (round >= q.maxFixRounds) {
        return { outcome: "return", text: ctx.block(`The pin is still not green after ${round} fix round(s).\n\n${lastRed}`) };
      }
      round += 1;
      setProgress(cwd, item.id, { status: "fixing", fixRounds: round });
      log(`  fix round ${round}/${q.maxFixRounds}`);
      const task = bugFixTask(item, q, baseline, proto, lastRed);
      let fix: ChildOutcome | undefined;
      for (;;) {
        try {
          fix = await runChildResilient(
            pi,
            ctx.rpc,
            {
              agent: "fr-bug-fixer",
              ...ctx.spawnFor("fixer"),
              task,
              context: "fresh",
              output: join(ctx.dir, `${item.id}-bugfix-${round}.md`),
            },
            q.childTimeoutMs,
            ctx.signal,
            ctx.policy,
            log,
            { ...ctx.resumeFor("bugfix"), quotaPolicy: ctx.quotaPolicy },
          );
          break;
        } catch (e) {
          if (e instanceof NetworkPause) {
            if (await ctx.handlePause("bugfix", e, round)) continue;
            return { outcome: "return", text: ctx.pausedReturn("bugfix") };
          }
          const stopped = ctx.abortStop("bugfix", round);
          return { outcome: "return", text: stopped ?? ctx.block(`The bug fixer failed to run: ${(e as Error).message}`) };
        }
      }
      // A decision ask outranks the status check for driver.ts's reason: a child told to stop and
      // write its question down ends "complete", and blocking on the status alone would report a
      // green or empty item instead of the question.
      const decision = ctx.decisionStop("bugfix", fix, round);
      if (decision) return { outcome: "return", text: decision };
      const failure = ctx.childOutcomeFailure("Bug fixer", fix);
      if (failure) return { outcome: "return", text: failure };
    }
    needFix = true;

    // ---- ② gate ------------------------------------------------------------
    setProgress(cwd, item.id, { status: "verifying", fixRounds: round });

    // (a) the pin and the report are untouched. Checked FIRST and it is not a fix round: a fixer
    // that edited its own spec has not failed at fixing, it has changed the question.
    //
    // The suppression check comes before the diff, because it is what makes the diff mean anything:
    // a pin marked assume-unchanged reports no changes to any probe git has.
    const suppressed = await suppressedPins(pi, cwd, pins);
    if (suppressed.length > 0) {
      return {
        outcome: "return",
        text: ctx.block(
          [
            "git has been told to stop reporting changes to the pin, so it can no longer be protected:",
            ...suppressed.map((s) => `  - ${s}`),
            "",
            "`git update-index --assume-unchanged` / `--skip-worktree` hide a tracked file's edits from",
            "every probe git offers, and `git add -A` then does not stage them either — so this would have",
            "committed as green with the defect intact and no record of the change.",
            "",
            "Clear it by hand (`git update-index --no-assume-unchanged <path>`), check what the pin now says,",
            `then start the item again: fr_batch action "reset", only: "${item.id}".`,
          ].join("\n"),
        ),
      };
    }
    const sink = proto.results === null ? null : substituteTokens(proto.results, fixture, item.plan);
    // HEAD FIRST: a fixer that committed its own edit leaves a clean working tree, so every
    // diff-shaped check downstream would correctly report that nothing is modified.
    const headNow = (await pi.exec("git", ["rev-parse", "HEAD"], { cwd })).stdout?.trim() ?? "";
    if (baseline.head && headNow !== baseline.head) {
      return {
        outcome: "return",
        text: ctx.block(
          [
            `HEAD moved while this item was being fixed: ${baseline.head.slice(0, 9)} -> ${headNow.slice(0, 9)}`,
            "",
            "The driver is the only thing that may commit during an item. A commit made by the fix leaves a",
            "clean tree, so nothing else here could tell that the pin had been touched.",
            "",
            `Inspect \`git log ${baseline.head.slice(0, 9)}..HEAD\`, then start the item again:`,
            `  fr_batch action "reset", only: "${item.id}"`,
          ].join("\n"),
        ),
      };
    }
    const touchedPin = digestDrift(baseline.pins, await pinDigest(pi, cwd, pins)).filter((d) => d.split(" ")[0] !== sink);
    if (touchedPin.length > 0) {
      return {
        outcome: "return",
        text: ctx.block(
          [
            `The fix changed the pin it is judged by, which this driver refuses:`,
            ...touchedPin.map((p) => `  - ${p}`),
            "",
            "The report and its test pin ARE the specification for a bug item. Editing them turns a",
            "verifiable fix into an unverifiable one — and if the edit weakens the pin, the batch would",
            "commit the loss of the only record of the defect.",
            "",
            "If the pin is genuinely wrong, that is a decision for a human: fix the pin yourself in a",
            `separate commit, then start the item again with fr_batch action "reset", only: "${item.id}".`,
          ].join("\n"),
        ),
      };
    }

    // (b) the pin turned green, judged against the captured state
    log(`  gate (after ${round} fix round(s))…`);
    const after = await runFixture(pi, cwd, proto, fixture, item.plan, q.verifyTimeoutMs, log);
    if (!after.ok) {
      // An incomplete run is NOT a red gate: it spends no round, because there is nothing for a
      // fixer to fix in a runner that did not report.
      return { outcome: "return", text: ctx.block(`The pin could not be judged: ${after.why}`) };
    }
    const afterVerdict = classify(after.exitCode, proto);

    if (baseline.mode === "scenario") {
      if (!after.scan) {
        return {
          outcome: "return",
          text: ctx.block(
            `This item captured a per-scenario baseline, but the pin wrote no usable results this time. The mode is fixed at capture and will not silently degrade to the exit code.`,
          ),
        };
      }
      const cmp = compareToBaseline(baseline, after.scan.scenarios);
      const incomplete = after.scan.torn + after.scan.skipped > 0;
      if (cmp.missing.length > 0 && incomplete) {
        return {
          outcome: "return",
          text: ctx.block(
            [
              `The pin's record is incomplete: ${cmp.missing.length} scenario(s) from the baseline are absent and the run also emitted ${after.scan.skipped} non-scenario / ${after.scan.torn} unparseable row(s).`,
              "",
              "That is a runner that stopped early, not a fixer that deleted a test — so it is reported as",
              "an incomplete run and costs no fix round.",
              ...cmp.missing.slice(0, 10).map((n) => `  - missing: ${n}`),
            ].join("\n"),
          ),
        };
      }
      if (afterVerdict === "green" && cmp.unfixed.length > 0) {
        return {
          outcome: "return",
          text: ctx.block(
            [
              `The pin exited ${after.exitCode} (greenExit) while ${cmp.unfixed.length} scenario(s) it captured as failing still fail:`,
              ...cmp.unfixed.slice(0, 10).map((n) => `  - ${n}`),
              "",
              "The exit code cannot be trusted for this pin. This is an infrastructure problem, not a fix",
              "problem, so no further round is spent.",
            ].join("\n"),
          ),
        };
      }
      const bad = cmp.unfixed.length + cmp.regressions.length + cmp.missing.length;
      // GATE RULE B, the mirror of the cheat rule above and the one the plan specified but an
      // earlier draft omitted. Every baseline scenario passes and the runner still refuses to exit
      // green: that is a check living OUTSIDE the scenario record — a leak detector, a watchdog, a
      // teardown assertion. An incomplete verdict, not an unfixed defect, so it spends no round;
      // reporting it as red would send a fixer after nothing, and reporting it as a cheat would
      // accuse it of tampering.
      if (bad === 0 && afterVerdict !== "green") {
        return {
          outcome: "return",
          text: ctx.block(
            [
              `Every scenario the baseline captured now passes, but the pin still exits ${after.exitCode}.`,
              "",
              "The exit code is reporting something its own per-scenario record does not. That is an",
              "incomplete verdict rather than an unfixed defect, so no fix round is spent on it.",
              "",
              "Either bring that condition into the pin as a scenario, or map its exit code in",
              "bugProtocol.greenExit if it is not a failure at all.",
            ].join("\n"),
          ),
        };
      }
      if (bad > 0) {
        lastRed = [
          ...(cmp.unfixed.length ? [`Still failing (${cmp.unfixed.length}):`, ...cmp.unfixed.map((n) => `  - ${n}`)] : []),
          ...(cmp.regressions.length
            ? [
                `REGRESSED — these passed before the fix and fail now (${cmp.regressions.length}):`,
                ...cmp.regressions.map((n) => `  - ${n}`),
                "  A scenario that passed before is usually a control: it exists to catch a fix that",
                "  satisfies the reproduction for the wrong reason.",
              ]
            : []),
          ...(cmp.missing.length ? [`Absent from this run (${cmp.missing.length}):`, ...cmp.missing.map((n) => `  - ${n}`)] : []),
        ].join("\n");
        log(`  gate RED — ${cmp.unfixed.length} unfixed, ${cmp.regressions.length} regressed, ${cmp.missing.length} missing`);
        continue;
      }
      if (cmp.added.length > 0) log(`  (${cmp.added.length} new scenario(s) appeared: ${cmp.added.join(", ")})`);
    } else {
      if (afterVerdict === "invalid" || afterVerdict === "unmapped") {
        return {
          outcome: "return",
          text: ctx.block(`The pin exited ${after.exitCode}, which is not a green or red verdict in this repo's bugProtocol. Incomplete run; no round spent.`),
        };
      }
      if (afterVerdict === "red") {
        lastRed = `The pin still exits ${after.exitCode} (redExit). This item is in EXIT MODE, so there is no per-scenario detail to show.`;
        log(`  gate RED — pin exits ${after.exitCode}`);
        continue;
      }
    }
    log("  gate: the pin is GREEN");

    // The diff, for the two gates that ask "what did the fix touch?" — a different question from
    // "did the pin change", which pinDigest answered above without consulting git configuration.
    const changed = await changedPaths(pi, cwd);

    // (c) no regression in the project's own suite
    const v = await ctx.runVerify(pi, cwd, verifyCmds, q.verifyTimeoutMs, log);
    if (!v.ok) {
      lastRed = `The project's own gate is red: \`${v.cmd}\` exited ${v.code}.\n\n${v.tail}`;
      log(`  gate RED — ${v.cmd} exited ${v.code}`);
      continue;
    }

    // (d) a permanent in-suite pin, when this repo asks for one
    if (proto.requirePin) {
      const re = new RegExp(proto.pinPattern);
      if (!changed.some((c) => re.test(c))) {
        lastRed = [
          `No new in-suite regression pin: nothing in the diff matches ${proto.pinPattern}`,
          "",
          "A fixture outside the project's own test suite guards nothing by itself — the next",
          "regression would not be caught. Add a real test in the suite and wire it in.",
        ].join("\n");
        log("  gate RED — no permanent pin");
        continue;
      }
    }

    // (e) the fix touched a mechanism the report actually names
    if (proto.requireMechanismTouch) {
      if (cited.length === 0) {
        log("  (requireMechanismTouch: the report names no file:line, so nothing to check)");
      } else if (!changed.some((c) => cited.some((f) => c === f || (f.includes("/") && c.endsWith(`/${f}`))))) {
        lastRed = [
          "The fix touched none of the files the report's root cause cites:",
          ...cited.slice(0, 10).map((f) => `  - ${f}`),
          "",
          "A fix that greens the pin without touching the mechanism the report names is usually",
          "pattern-matching the reproduction's inputs rather than repairing the defect.",
        ].join("\n");
        log("  gate RED — the diff touches no cited file");
        continue;
      }
    }
    break;
  }

  // ---- ③ scope (non-blocking) ----------------------------------------------
  // `auditing` is reused rather than adding a status: nothing switches on it, `isDone` does not
  // include it, and a ninth ItemStatus member would need arms in render, remove and archive for a
  // phase that cannot fail the item. The log line says what is actually happening.
  setProgress(cwd, item.id, { status: "auditing", fixRounds: round });
  log("  scope: looking for sibling call sites…");
  try {
    const scoped = await runChildResilient(
      pi,
      ctx.rpc,
      {
        agent: "fr-bug-scoper",
        ...ctx.spawnFor("auditor"),
        task: bugScopeTask(item, q, report),
        context: "fresh",
        output: join(ctx.dir, `${item.id}-scope.md`),
      },
      q.childTimeoutMs,
      ctx.signal,
      ctx.policy,
      log,
      { quotaPolicy: ctx.quotaPolicy },
    );
    // EVERY outcome here is logged, never returned. The gate is already green; a generator that
    // fails must not cost an item that passed. Its pauses and decision asks are swallowed for the
    // same reason — there is nothing left for a human to decide about THIS item.
    const failure = ctx.childOutcomeFailure("Scoper", scoped);
    if (failure) {
      log(`  (the scoper did not complete; recording nothing. ${failure.split("\n")[0]})`);
    } else {
      const body = scoped.artifactPath && existsSync(scoped.artifactPath) ? readFileSync(scoped.artifactPath, "utf8") : scoped.summary;
      mkdirSync(dirname(siblingsPath(cwd, item.id)), { recursive: true });
      writeAtomic(
        siblingsPath(cwd, item.id),
        [
          `# Sibling call sites — ${item.id}`,
          "",
          `Found after the fix for \`${item.plan}\` passed its gate. **Non-blocking by construction:** this`,
          "item committed regardless. Promote anything worth having into its own bug fixture.",
          "",
          body.trim(),
          "",
        ].join("\n"),
      );
      log(`  sibling candidates recorded → ${siblingsPath(cwd, item.id)}`);
    }
  } catch (e) {
    log(`  (the scoper could not run: ${(e as Error).message}. The item is unaffected.)`);
  }

  return { outcome: "commit", rounds: round };
}

// ---------------------------------------------------------------------------
// task text
// ---------------------------------------------------------------------------

function pinDescription(baseline: Baseline, proto: BugProtocol): string {
  if (baseline.mode === "exit") {
    return [
      `The pin is judged by its EXIT CODE only (this repo declares no per-scenario record for it).`,
      `It exited ${baseline.exitCode} before you started, which this repo maps to "the defect reproduces".`,
      `It must exit one of ${proto.greenExit.join(", ")} when you are done.`,
    ].join("\n");
  }
  const red = Object.entries(baseline.scenarios).filter(([, ok]) => !ok).map(([n]) => n);
  const green = Object.entries(baseline.scenarios).filter(([, ok]) => ok).map(([n]) => n);
  return [
    `The pin reports per scenario. Measured before you started:`,
    "",
    `FAILING — these are what you must make pass (${red.length}):`,
    ...red.map((n) => `  - ${n}`),
    "",
    `PASSING — these must STILL pass (${green.length}). The driver compares every one of them:`,
    ...green.map((n) => `  - ${n}`),
    "",
    "A scenario that passes today and fails after your change fails the gate. Several of them are",
    "usually deliberate controls: they exist to catch a fix that satisfies the failing cases for the",
    "wrong reason.",
  ].join("\n");
}

export function bugFixTask(item: QueueItem, q: Queue, baseline: Baseline, proto: BugProtocol, lastRed: string): string {
  return `A test pin in this repository is RED and the defect it pins is yours to fix.

Read these first, completely:
${readsBlock(item)}

The pin lives at: ${fixtureOf(item)}

${pinDescription(baseline, proto)}
${lastRed ? `\nThe last attempt did not pass the gate:\n\n${lastRed}\n` : ""}
Rules:
- The report is the spec. Start from its \`## Root Cause\` citations rather than re-deriving the
  defect from the symptom.
- Its scope decisions are BINDING. If it says something is out of scope, leave it alone and say so
  in your report — the driver has a separate step for neighbouring defects.
- **Do not modify the pin or the report.** No assertion, expected value, timeout, scenario or
  control may change, and no file may be added inside the pin's directory. The driver diffs those
  paths and blocks the item if any of them moved. If you believe the pin itself is wrong, stop and
  use \`contact_supervisor\` with \`reason: "need_decision"\`.
- Fix the mechanism, not the reproduction's inputs. Special-casing the exact value the pin uses is
  not a fix.
${proto.requirePin ? `- This repo REQUIRES a permanent in-suite regression test as part of the fix: add one whose path matches ${proto.pinPattern}, and wire it into the suite the way this project wires tests. A fixture alone guards nothing.\n` : ""}- Do NOT commit. No \`git commit\`, \`git add\`, \`git stash\` or \`git checkout\`. The driver commits.
- The project's own build/test gate must stay green; it runs after the pin does.${rulesBlock(q)}

Report at the end: the mechanism you fixed and where, files created and edited, the permanent pin
you added (or why none was required), and any neighbouring defect you deliberately left alone.`;
}

export function bugScopeTask(item: QueueItem, q: Queue, report: string): string {
  const cited = citedFiles(report);
  return `A defect was just fixed in this repository and its test pin is GREEN. The gate has already
passed — you cannot change that outcome and nothing you report will block it.

Read for context:
${readsBlock(item)}

The fix is in the working tree, uncommitted. \`git diff HEAD\` and \`git status --short\` show it.
${cited.length ? `\nThe report's root cause cites: ${cited.join(", ")}\n` : ""}
YOUR ONE QUESTION: the wrong assumption that caused this defect — **where else does it hold?**

You are NOT auditing test completeness. That question has no fixed point and is not asked here.
Find the other places the same wrong assumption is made: other arms of the same switch, other
callers of the function that was wrong, the same defaulting/clamping/dropping written a second time
elsewhere, sibling entry points that reach the fixed code by another path, a second subsystem
reading the same field.

For each candidate say what you VERIFIED (file and line you read) versus what you merely suspect,
and the shape of the fixture that would pin it. "Nowhere else" is a real and useful answer — do not
invent candidates. You MUST NOT modify any file.${rulesBlock(q)}`;
}
