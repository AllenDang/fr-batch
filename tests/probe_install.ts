// Guard probes for the INSTALL SURFACE — the class of defect a fresh install hits and the
// author's machine never does.
//
// Why this file exists, in one measured story: the driver spawns three agents by hardcoded name
// (`fr-implementer`, `fr-test-auditor`, `fr-gap-fixer`), those definitions lived only in the
// author's `~/.pi/agent/agents/`, and no file in the repo ever mentioned them. A fresh install
// therefore failed on its FIRST child with `Unknown agent: fr-implementer` — 37ms after launch,
// invisible for 51 minutes — and the 195-assertion guard suite stayed GREEN throughout, because
// it asserted that the spawn param `agent` equals the string "fr-implementer" and never that
// anything answers to that name. Deleting all three definitions changed no assertion.
//
// So these probes are written to be exactly the ones that would have gone red:
//   1. every agent name the driver spawns has a definition file IN THIS REPO, discovered by
//      grepping the driver rather than by a hand-kept list (a fourth agent cannot be added
//      without either shipping it or turning this red);
//   2. package.json declares the directory those files live in, through the key pi-subagents
//      actually reads — a definition nothing points at is not installed;
//   3. each file's frontmatter `name` matches its spawn name, and carries the fields the driver's
//      contract depends on (write tools for the two writers, none for the auditor);
//   4. each body teaches the two escalation protocols the driver implements (NETWORK_DOWN: and
//      need_decision), because the driver's outage handling is unreachable otherwise;
//   5. the three queue budgets are defaulted and validated at load, so an omitted childTimeoutMs
//      can never again reach setTimeout as NaN;
//   6. a completion event that arrives before the launch RPC replies is not dropped.
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadQueue } from "../store.ts";
import { QUEUE_BUDGET_DEFAULTS } from "../types.ts";
import { runChild, ASYNC_COMPLETE, RPC_REQUEST, RPC_REPLY_PREFIX } from "../rpc.ts";
import { TRANSIENT_SIGNATURES, transientHit, answerAsk, findPendingAsks, supervisorChannelRoots } from "../resilience.ts";
import { planTestGate } from "../contract.ts";
import { childOutcomeFailure, runBatch, UNKNOWN_AGENT_HINT } from "../driver.ts";

let fails = 0;
const ok = (n: string, c: boolean, extra = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? ` — ${extra}` : ""}`);
  if (!c) fails++;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// 1 + 2. the agents the driver spawns are shipped, and declared
// ---------------------------------------------------------------------------
// Scanned across EVERY module that spawns, not just driver.ts. The bug pipeline lives in its own
// file, and a scan of driver.ts alone would both fail the count and — worse — leave the new agents
// out of the shipped-file loop below, so deleting one of their definitions would fail nothing.
// existsSync-guarded so this file still runs at a commit where bug_pipeline.ts does not exist yet.
const SPAWN_SOURCES = ["driver.ts", "bug_pipeline.ts"];
const driverSrc = SPAWN_SOURCES.filter((f) => existsSync(join(root, f)))
  .map((f) => readFileSync(join(root, f), "utf8"))
  .join("\n");
const spawnedAgents = [...new Set([...driverSrc.matchAll(/agent:\s*"([^"]+)"/g)].map((m) => m[1]))].sort();
ok("the driver spawns a known set of agents", spawnedAgents.length === 5, spawnedAgents.join(", "));

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  pi?: { subagents?: { agents?: string[] } };
  "pi-subagents"?: { agents?: string[] };
};
// The two keys pi-subagents reads (docs/agents.md: "Installed package"). Anything else is a
// directory of markdown files nothing loads.
const declaredDirs = [...(pkg["pi-subagents"]?.agents ?? []), ...(pkg.pi?.subagents?.agents ?? [])];
ok("package.json declares an agent directory", declaredDirs.length > 0, JSON.stringify(declaredDirs));
const agentDirs = declaredDirs.map((d) => join(root, d));
ok(
  "...and every declared directory exists",
  agentDirs.every((d) => existsSync(d)),
  agentDirs.join(", "),
);

const shipped = new Map<string, string>();
for (const dir of agentDirs) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(dir, f), "utf8");
    const name = /^name:\s*(\S+)\s*$/m.exec(text.slice(0, text.indexOf("\n---", 3) + 1))?.[1];
    if (name) shipped.set(name, text);
    ok(`${f} declares a frontmatter name`, Boolean(name), name ?? "(none)");
    ok(`...and ${f}'s name matches its filename`, name === f.replace(/\.md$/, ""), `${name} vs ${f}`);
  }
}

for (const agent of spawnedAgents) {
  ok(`spawned agent "${agent}" ships with this package`, shipped.has(agent), [...shipped.keys()].join(", "));
}

// ---------------------------------------------------------------------------
// 3 + 4. each definition carries what the driver's contract needs
// ---------------------------------------------------------------------------
const frontmatterOf = (text: string): Record<string, string> => {
  const end = text.indexOf("\n---", 3);
  const out: Record<string, string> = {};
  for (const line of text.slice(4, end < 0 ? text.length : end).split("\n")) {
    const m = /^([\w-]+):\s*(.+)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
};
const toolsOf = (fm: Record<string, string>) => (fm.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean);

/**
 * Agents that must NOT carry write tools. A critic that can quietly fix what it reports is not a
 * critic — fr-test-auditor's verdict and fr-bug-scoper's sibling list are both worthless if the
 * child can make its own findings disappear.
 */
const READ_ONLY_AGENTS = new Set(["fr-test-auditor", "fr-bug-scoper"]);

for (const [name, text] of shipped) {
  const fm = frontmatterOf(text);
  const tools = toolsOf(fm);
  ok(`${name} has a description (it is what /subagents lists)`, Boolean(fm.description?.length));
  // The README's central project-agnosticism claim — "each child gets the project's AGENTS.md /
  // CLAUDE.md injected via inheritProjectContext: true" — is a field of THESE files, nothing the
  // driver can pass at spawn time. If it is absent here, that claim is simply false.
  ok(`${name} inherits the project context file`, fm.inheritProjectContext === "true", fm.inheritProjectContext ?? "(unset)");
  ok(`${name} can reach the supervisor channel`, tools.includes("contact_supervisor"), tools.join("|"));
  // Both escalation protocols are implemented in resilience.ts (NETWORK_ASK_MARKER and
  // DECISION_DIRECTIVE). A child that was never told about them cannot trigger either, so the
  // whole outage layer would be dead code.
  ok(`${name} is taught the NETWORK_DOWN protocol`, text.includes("NETWORK_DOWN:"), "resilience.ts keys off that exact marker");
  ok(`${name} is taught the need_decision protocol`, /need_decision/.test(text));
  ok(`${name} is told never to commit`, /never commit|MUST NOT modify any file/i.test(text));

  // A SET, not a comparison against one name. `name !== "fr-test-auditor"` DEMANDED edit+write of
  // every other shipped agent, so a second read-only critic could not be added without failing an
  // assertion that looks unrelated to it.
  const writer = !READ_ONLY_AGENTS.has(name);
  ok(
    `${name} ${writer ? "can write" : "cannot write"}`,
    writer === (tools.includes("edit") && tools.includes("write")),
    tools.join("|"),
  );
}

// The auditor's verdict arrives through structured_output, which pi-subagents appends to the
// allowlist itself when an outputSchema is passed — so the prompt must ask for it by name.
const auditor = shipped.get("fr-test-auditor") ?? "";
ok("the auditor is told to answer through structured_output", auditor.includes("structured_output"));
ok("...and that its checklist is the FROZEN contract", /FROZEN_AUDIT_CONTRACT/.test(auditor));
const fixer = shipped.get("fr-gap-fixer") ?? "";
ok("the fixer is told rejections are durable", /rejected/.test(fixer) && /ledger/i.test(fixer));

// ---------------------------------------------------------------------------
// 5. the three budgets: defaulted when absent, refused when unusable
// ---------------------------------------------------------------------------
const repoWith = (queue: unknown): string => {
  const repo = mkdtempSync(join(tmpdir(), "fr-batch-install-"));
  mkdirSync(join(repo, ".pi/fr-batch"), { recursive: true });
  writeFileSync(join(repo, ".pi/fr-batch/queue.json"), JSON.stringify(queue, null, 2));
  return repo;
};
const minimal = { armed: false, defaultVerify: ["true"], items: [{ id: "a", plan: "docs/P.md" }] };
{
  const q = loadQueue(repoWith(minimal));
  ok("a queue omitting childTimeoutMs still loads", q.childTimeoutMs === QUEUE_BUDGET_DEFAULTS.childTimeoutMs, String(q.childTimeoutMs));
  ok("...and verifyTimeoutMs", q.verifyTimeoutMs === QUEUE_BUDGET_DEFAULTS.verifyTimeoutMs, String(q.verifyTimeoutMs));
  ok("...and maxFixRounds", q.maxFixRounds === QUEUE_BUDGET_DEFAULTS.maxFixRounds, String(q.maxFixRounds));
  ok(
    "...and every default is a finite positive number, so setTimeout can never see NaN",
    [q.childTimeoutMs, q.verifyTimeoutMs].every((v) => Number.isFinite(v) && v > 0) && Number.isInteger(q.maxFixRounds),
  );
}
for (const bad of [{ childTimeoutMs: "3h" }, { childTimeoutMs: 0 }, { verifyTimeoutMs: -1 }, { maxFixRounds: 1.5 }, { childTimeoutMs: null as unknown as number }]) {
  const field = Object.keys(bad)[0];
  const value = JSON.stringify(Object.values(bad)[0]);
  let threw = "";
  try {
    loadQueue(repoWith({ ...minimal, ...bad }));
  } catch (e) {
    threw = (e as Error).message;
  }
  // null is the one falsy-but-legal spelling of "absent": JSON has no undefined.
  if (Object.values(bad)[0] === null) ok(`${field}: null is treated as absent, not as an error`, threw === "", threw);
  else ok(`${field}: ${value} is refused at load, naming the field`, threw.includes(field), threw || "(loaded silently)");
}
{
  const q = loadQueue(repoWith({ ...minimal, childTimeoutMs: 1234, verifyTimeoutMs: 5678, maxFixRounds: 0 }));
  ok("an explicit budget is preserved, not overwritten by the default", q.childTimeoutMs === 1234 && q.verifyTimeoutMs === 5678);
  ok("...and maxFixRounds:0 (no fix rounds at all) survives", q.maxFixRounds === 0);
}

// runChild is the second line of defence, and it must name the field rather than say "undefined".
{
  const pi: any = { events: { on: () => () => {}, emit: () => {} } };
  let msg = "";
  await runChild(pi, { call: async () => ({}) as any }, { agent: "x", task: "y" }, undefined as unknown as number, undefined).catch((e: Error) => {
    msg = e.message;
  });
  ok("runChild refuses a non-numeric timeout", /childTimeoutMs/.test(msg) && !/undefinedms/.test(msg), msg);
}

// ---------------------------------------------------------------------------
// 6. a completion event that lands inside the launch round-trip is not lost
// ---------------------------------------------------------------------------
{
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const fire = (name: string, payload: unknown) => {
    for (const h of [...(handlers.get(name) ?? [])]) h(payload);
  };
  const pi: any = {
    events: {
      on: (name: string, h: (d: unknown) => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(h);
        return () => handlers.get(name)!.delete(h);
      },
      emit: () => {},
    },
  };
  // The launch replies with the id only AFTER the run has already died and its completion event
  // has already been emitted — the exact ordering a 37ms launch failure produces.
  const rpc = {
    call: async <T,>(): Promise<T> => {
      fire(ASYNC_COMPLETE, { runId: "run-early", state: "failed", error: "Run 'main' failed: Unknown agent: fr-implementer", results: [] });
      return { text: "launched", details: { asyncId: "run-early" } } as T;
    },
  };
  const outcome = await Promise.race([
    runChild(pi, rpc as any, { agent: "fr-implementer", task: "t" }, 60_000, undefined),
    new Promise((_r, rej) => setTimeout(() => rej(new Error("runChild never settled")), 3_000)),
  ]).catch((e: Error) => e);
  const settled = !(outcome instanceof Error);
  ok("a completion event fired before the launch reply still settles the child", settled, settled ? "" : (outcome as Error).message);
  if (settled) {
    const o = outcome as { status: string; error?: string };
    ok("...as a failure, carrying the launch error", o.status === "failed" && /Unknown agent/.test(o.error ?? ""), JSON.stringify(o));
    const rendered = childOutcomeFailure("Implementer", o as any) ?? "";
    ok("...and the block message states the cause instead of an empty summary", /Unknown agent/.test(rendered), rendered.split("\n")[0]);
    ok("...and points at the install fix", rendered.includes(UNKNOWN_AGENT_HINT.split("\n")[0]));
  }
}

// A success must NOT be rendered as a failure — otherwise the check above is satisfied by a
// function that returns text unconditionally.
ok(
  "childOutcomeFailure returns nothing for a completed child",
  childOutcomeFailure("Implementer", { asyncId: "a", status: "complete", summary: "done" }) === null,
);

// ---------------------------------------------------------------------------
// the signature that discarded a live child
// ---------------------------------------------------------------------------
ok(
  "a stream that ends without a stop reason is transient",
  transientHit("Run 'main' failed: Bedrock stream ended without a stop reason") !== null,
  String(transientHit("Run 'main' failed: Bedrock stream ended without a stop reason")),
);
ok("...and so is a stream ending prematurely", transientHit("response stream terminated prematurely") !== null);
ok("a real assertion failure is still NOT transient", transientHit("expected 3 got 4 in section_props_test.cpp:88") === null);
ok("the signature list is a list of regexes", TRANSIENT_SIGNATURES.every((r) => r instanceof RegExp));

// ---------------------------------------------------------------------------
// the supervisor channel ROOT, derived independently of the constant under test
//
// This is the second vacuity of the same shape as the agent names: probe_channel.ts writes its
// fixture INTO `SUPERVISOR_CHANNEL_ROOT` and then asserts fr-batch can read it, which is true for
// any value that constant could hold. It held `<tmpdir>/pi-subagents/supervisor-channels` — a
// directory nothing creates — so `findPendingAsks` returned [] in production forever: a
// NETWORK_DOWN report was never held through the outage and a decision ask was never answered,
// which is why the child was always "Detached for intercom coordination" instead.
//
// pi-subagents' real root is `PI_SUBAGENTS_TEMP_ROOT` or `<tmpdir>/pi-subagents-<scope>`
// (shared/types.ts:2364-2414). Spelled out here from the upstream RULE, not imported from the
// module, so a wrong constant cannot satisfy its own test.
{
  const scope = typeof process.getuid === "function" ? `uid-${process.getuid()}` : undefined;
  if (scope) {
    const expected = join(tmpdir(), `pi-subagents-${scope}`, "supervisor-channels");
    ok("the channel roots include the uid-scoped root pi-subagents actually uses", supervisorChannelRoots().includes(expected), supervisorChannelRoots().join(" | "));
    ok(
      "...and the bare <tmpdir>/pi-subagents path is not the only candidate",
      supervisorChannelRoots().some((r) => r !== join(tmpdir(), "pi-subagents", "supervisor-channels")),
    );
  }
  const prev = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = "/tmp/probe-temp-root";
  ok(
    "PI_SUBAGENTS_TEMP_ROOT is honoured, and wins",
    supervisorChannelRoots()[0] === join("/tmp/probe-temp-root", "supervisor-channels"),
    supervisorChannelRoots()[0],
  );
  if (prev === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
  else process.env.PI_SUBAGENTS_TEMP_ROOT = prev;

  // An ask under the REAL root must be found. The fixture is placed by the upstream rule above,
  // never by the constant, so this fails if the roots drift from pi-subagents again.
  const root = supervisorChannelRoots()[supervisorChannelRoots().length - 1];
  const runId = `probe-root-${process.pid}`;
  const chan = join(root, `${runId}-fr-implementer-0`);
  mkdirSync(join(chan, "requests"), { recursive: true });
  mkdirSync(join(chan, "replies"), { recursive: true });
  writeFileSync(join(chan, "requests", "q1.json"), JSON.stringify({ reason: "need_decision", message: "which one?" }));
  const found = findPendingAsks(runId);
  ok("an ask sitting under pi-subagents' real root is found", found.length === 1 && found[0].requestId === "q1", JSON.stringify(found.map((f) => f.requestId)));
  if (found.length === 1) {
    answerAsk(found[0], "go");
    ok("...and the reply lands beside it, in the same root", existsSync(join(chan, "replies", "q1.json")));
  }
  rmSync(chan, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// the test-matrix gate: an empty table SKELETON is not a matrix
// ---------------------------------------------------------------------------
{
  const exec = async () => ({ code: 1, stdout: "", stderr: "no HEAD" });
  const gate = async (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "fr-batch-gate-"));
    writeFileSync(join(dir, "P.md"), body);
    return planTestGate({ exec } as any, dir, { id: "p", plan: "P.md" } as any);
  };
  // Header + `|---|` separator are both `|`-lines, so the old raw count read them as two rows and
  // passed a matrix with nothing in it — the exact vacuity this gate exists to prevent.
  ok("a table with a header and NO data rows is blocked", !(await gate("## Tests\n\n| id | what | proves non-vacuous |\n|---|---|---|\n")).ok);
  ok("...and one with a single real row passes", (await gate("## Tests\n\n| id | what |\n|---|---|\n| T1 | a |\n")).ok);
  ok("...and an alignment separator (|:--|--:|) is not counted either", !(await gate("## Tests\n\n| id | what |\n|:---|---:|\n")).ok);
  ok("a bulleted matrix still passes", (await gate("## Tests\n- T1 red edit: x\n- T2 red edit: y\n")).ok);
  const why = (await gate("## Tests\n\n| id |\n|---|\n")) as { ok: boolean; why?: string };
  // The driver is project-agnostic by construction; its refusals must not name another repo's docs.
  // `why` is optional so a mutation that makes the gate PASS reports a failed assertion instead of
  // crashing this file — a crash is a worse signal than a FAIL line.
  ok("a header-only table is refused, with a reason", why.ok === false && Boolean(why.why), JSON.stringify(why).slice(0, 120));
  ok("the refusal names no other project's files", !/FR_world_env_ibl|write-fr-plan|scons/.test(why.why ?? ""), (why.why ?? "").split("\n").find((l) => /FR_|scons/.test(l)) ?? "");
}

// ---------------------------------------------------------------------------
// `git add -A` must not be able to commit the driver's own state
// ---------------------------------------------------------------------------
{
  const sh = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const mkRepo = (ignore: string | null): string => {
    const repo = mkdtempSync(join(tmpdir(), "fr-batch-ignore-"));
    sh(repo, ["init", "-q"]);
    sh(repo, ["config", "user.email", "t@t"]);
    sh(repo, ["config", "user.name", "t"]);
    if (ignore !== null) writeFileSync(join(repo, ".gitignore"), ignore);
    mkdirSync(join(repo, ".pi/fr-batch"), { recursive: true });
    writeFileSync(
      join(repo, ".pi/fr-batch/queue.json"),
      JSON.stringify({
        armed: true,
        defaultVerify: ["true"],
        // The fake pi below never answers an RPC, and the driver is RIGHT to read that as an
        // outage — with the shipped defaults it backs off for ~15 minutes per repo, which the
        // suite's per-file timeout then reports as a failed probe rather than a slow one.
        transient: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, probeUrl: "" },
        transientQuota: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, probeUrl: "" },
        items: [{ id: "a", plan: "P.md" }],
      }),
    );
    writeFileSync(join(repo, "P.md"), "## Tests\n\n| id | x |\n|---|---|\n| T1 | a |\n");
    sh(repo, ["add", "-A"]);
    sh(repo, ["commit", "-qm", "init"]);
    return repo;
  };
  const pi: any = {
    exec: async (cmd: string, args: string[], o: any) => {
      try {
        return { code: 0, stdout: execFileSync(cmd, args, { cwd: o?.cwd, encoding: "utf8" }), stderr: "" };
      } catch (e: any) {
        return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e) };
      }
    },
    events: {
      on: () => () => {},
      // Answered immediately with a NON-transient error, so the driver reaches its verdict in
      // milliseconds. Left unanswered, every spawn would sit out the 30s RPC timeout and then the
      // outage backoff, and this file would be measuring patience instead of the gitignore gate.
      emit: (name: string, payload: unknown) => {
        if (name !== RPC_REQUEST) return;
        const req = payload as { requestId: string };
        for (const h of [...(replyHandlers.get(`${RPC_REPLY_PREFIX}${req.requestId}`) ?? [])]) {
          h({ version: 1, requestId: req.requestId, success: false, error: { code: "probe", message: "probe: no subagents runtime" } });
        }
      },
    },
    appendEntry: () => {},
  };
  const replyHandlers = new Map<string, Set<(d: unknown) => void>>();
  pi.events.on = (name: string, h: (d: unknown) => void) => {
    if (!replyHandlers.has(name)) replyHandlers.set(name, new Set());
    replyHandlers.get(name)!.add(h);
    return () => replyHandlers.get(name)!.delete(h);
  };
  const run = (repo: string) => runBatch(pi, { cwd: repo, hasUI: false, ui: {} } as any, { background: true }, () => {});

  const bare = await run(mkRepo(null));
  ok("a repo ignoring neither tree is refused before anything runs", /REFUSED/.test(bare) && /does not ignore/.test(bare), bare.split("\n")[0]);
  ok("...naming both trees and the one-line fix", /\.pi\b/.test(bare) && /\.pi-subagents/.test(bare) && /gitignore/.test(bare));
  const half = await run(mkRepo("/.pi/\n"));
  ok("a repo ignoring only .pi is still refused", /REFUSED/.test(half) && /\.pi-subagents/.test(half), half.split("\n")[0]);
  // The dir-only rule `/.pi-subagents/` with the directory absent is EXACTLY ange's .gitignore,
  // and `git check-ignore .pi-subagents` (no slash) exits 1 there — so the check has to query with
  // one, or it refuses a repo that is correctly configured.
  const dirOnly = mkRepo("/.pi/\n/.pi-subagents/\n");
  const dirOnlyRules = await run(dirOnly);
  ok("a repo with dir-only rules and no such directories yet is NOT refused", !/does not ignore/.test(dirOnlyRules), dirOnlyRules.split("\n")[0]);
  ok("...and every exit path released the run lock", !existsSync(join(dirOnly, ".pi/fr-batch/.run.lock")));
}

// ---------------------------------------------------------------------------
// tsconfig.json must be accepted by a CURRENT tsc, not only by the one on this machine
//
// A local `node_modules/typescript` is gitignored, so a long-lived checkout can sit on an old
// tsc while every fresh clone gets the current one. Measured: the committed config typechecked
// clean under 5.9.3 and failed under 7.0.2 with three TS5090s (`paths` values not starting with
// `./`) plus TS5102 (`baseUrl` removed in TS7) — so `node tests/typecheck.mjs`, the gate this
// repo documents, was red on any current machine for reasons that had nothing to do with the
// code. Same shape as the `/opt/homebrew` paths PR #1 removed: one machine's toolchain baked
// into a committed file.
// ---------------------------------------------------------------------------
{
  const raw = readFileSync(join(root, "tsconfig.json"), "utf8");
  const cfg = JSON.parse(raw) as { compilerOptions?: Record<string, unknown> };
  const co = cfg.compilerOptions ?? {};
  ok("tsconfig sets no baseUrl (removed in TS7; `paths` alone resolves against the config)", !("baseUrl" in co), JSON.stringify(co.baseUrl));
  const pathValues = Object.values((co.paths ?? {}) as Record<string, string[]>).flat();
  const rootDirs = ((co.typeRoots ?? []) as string[]);
  ok("every paths target is relative (`./…`), which TS7 requires", pathValues.length > 0 && pathValues.every((p) => p.startsWith("./")), pathValues.join(" "));
  ok("...and every typeRoots entry too", rootDirs.every((p) => p.startsWith("./")), rootDirs.join(" "));
  // The link farm those paths point INTO is built by tests/typecheck.mjs, so the two must agree.
  ok("...and they point at the .types/ farm typecheck.mjs builds", pathValues.every((p) => p.startsWith("./.types/")), pathValues.join(" "));
}

console.log(fails === 0 ? "\nprobe_install: all pass" : `\nprobe_install: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
