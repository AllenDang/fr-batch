// Guard probes for the two things that decide what a LONG queue costs to work with:
//
//   1. `status` renders a SUMMARY whose size does not grow with the queue. The old view was
//      one row per item, so a 300-item queue cost ~300 lines on every inspection while at
//      most a handful of rows were actionable. The probe pins that a 300-item queue and a
//      30-item queue render the SAME number of lines, and that nothing actionable is folded.
//   2. `archive` sweeps committed items out of the live pair into an append-only
//      history.jsonl, carrying the closing note and parking the frozen contract, so both hot
//      files stay sized by work IN FLIGHT rather than by project history.
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHistory, renderStatus } from "../render.ts";
import { addItem, archiveItems, removeItem } from "../queue_ops.ts";
import { countHistory, loadHistory, loadQueue } from "../store.ts";

let fails = 0;
const ok = (n: string, c: boolean, extra = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? ` — ${extra}` : ""}`);
  if (!c) fails++;
};

const NOTE = "parent-verified: suite green (5972 cases), validate clean.\nG1 rejected as re-litigation with a recorded arm-swap measurement.";

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "fr-batch-scale-"));
  mkdirSync(join(repo, ".pi/fr-batch"), { recursive: true });
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs/FR_new_PLAN.md"), "# FR new\n\n## 5. Tests\n\n| id |\n|---|\n| T1 |\n");
  return repo;
}

/** `committed` items, then one paused + one blocked, then `pending` ones. */
function seed(repo: string, committed: number, pending: number) {
  const items: any[] = [];
  const progress: any = {};
  for (let n = 0; n < committed; n++) {
    const id = `done-${n}`;
    items.push({ id, plan: `docs/FR_${id}_PLAN.md`, commitMsg: `feat: ${id}` });
    progress[id] = { status: "committed", fixRounds: n % 3, updatedAt: "2026-08-20T00:00:00.000Z", sha: `sha${n}`.padEnd(40, "0"), note: NOTE };
  }
  items.push({ id: "hot-paused", plan: "docs/FR_hot_PLAN.md" });
  progress["hot-paused"] = {
    status: "paused",
    fixRounds: 1,
    updatedAt: "now",
    pauseKind: "decision",
    pausedPhase: "implement",
    pendingAsk: "  reason: need_decision\n  (A) vendor it (B) drop T5-T9",
    note: "The implement child needs a supervisor decision.",
  };
  items.push({ id: "hot-blocked", plan: "docs/FR_blk_PLAN.md" });
  progress["hot-blocked"] = { status: "blocked", fixRounds: 4, updatedAt: "now", note: "gap set stopped shrinking after 4 rounds" };
  for (let n = 0; n < pending; n++) items.push({ id: `todo-${n}`, plan: `docs/FR_todo${n}_PLAN.md` });
  writeFileSync(
    join(repo, ".pi/fr-batch/queue.json"),
    JSON.stringify({ armed: true, maxFixRounds: 4, childTimeoutMs: 1000, verifyTimeoutMs: 1000, defaultVerify: ["true"], items }, null, 2),
  );
  writeFileSync(join(repo, ".pi/fr-batch/progress.json"), JSON.stringify(progress, null, 2));
}

// ---------------------------------------------------------------------------
// 1. status: bounded by what is actionable, not by queue length
// ---------------------------------------------------------------------------

const small = makeRepo();
seed(small, 20, 9);
const big = makeRepo();
seed(big, 280, 60);

const sSmall = renderStatus(small);
const sBig = renderStatus(big);
const lines = (s: string) => s.split("\n").length;

ok("a 340-item queue renders the same number of status lines as a 31-item one", lines(sSmall) === lines(sBig), `${lines(sSmall)} vs ${lines(sBig)}`);
ok("...and that is a short render, not a long one", lines(sBig) < 30, `${lines(sBig)} lines`);
ok("...while the header still reports the true totals", /280\/342 committed/.test(sBig), sBig.split("\n")[0]);

ok("the paused item is never folded away", sBig.includes("hot-paused"));
ok("...nor is the blocked one", sBig.includes("hot-blocked"));
ok("...and their first note line rides along", sBig.includes("gap set stopped shrinking"));
ok("...and the verbatim decision question is still relayed", sBig.includes("(A) vendor it"));

ok("exactly 3 pending rows are previewed", (sBig.match(/todo-\d+ +pending/g) ?? []).length === 3, JSON.stringify(sBig.match(/todo-\d+ +pending/g)));
ok("committed rows are folded", !sBig.includes("done-5 "), "done-5 must not have its own row");
ok("...into a line that counts what it folded", /⋯ +280 +hidden — 280 committed/.test(sBig), (sBig.match(/⋯.*/g) ?? []).join(" | "));
ok("...and the pending tail is folded too, separately", /⋯ +57 +hidden — 57 pending/.test(sBig), (sBig.match(/⋯.*/g) ?? []).join(" | "));
ok("the summary says how to get the rest", sBig.includes('all:true = every row, only:"<id>" = one item in full'));
ok("...and points at archive while committed items still sit in the queue", /action "archive"/.test(sBig));
const hushed = renderStatus(small, {}, {});
ok("...but not while a driver may be writing progress.json", (() => {
  writeFileSync(join(small, ".pi/fr-batch/.run.lock"), "pid 1 since now\n");
  const s = renderStatus(small);
  rmSync(join(small, ".pi/fr-batch/.run.lock"), { force: true });
  return /action "archive"/.test(hushed) && !/action "archive"/.test(s);
})());

const sAll = renderStatus(big, {}, { all: true });
const rowCount = (s: string) => (s.match(/^ {2}[✓✗⏸○… ] +\d+\. /gm) ?? []).length;
ok("all:true lists every row", rowCount(sAll) === 342, String(rowCount(sAll)));
ok("...and folds nothing", !sAll.includes("hidden —"));
ok("...and drops the summary hint it no longer needs", !sAll.includes("all:true = every row"));

const detail = renderStatus(big, {}, { only: "hot-blocked" });
ok("only:<id> renders one item", detail.includes('item "hot-blocked"') && !detail.includes("todo-0"));
ok("...with its position in the queue", /\(282\/342\)/.test(detail), detail.split("\n")[0]);
ok("...its plan and resolved verify commands", detail.includes("docs/FR_blk_PLAN.md") && detail.includes("queue.defaultVerify"));
ok("...and the WHOLE note, not the first line", detail.includes("gap set stopped shrinking after 4 rounds"));
const detailPaused = renderStatus(big, {}, { only: "hot-paused" });
ok("...and a paused item's full question", detailPaused.includes("(B) drop T5-T9") && detailPaused.includes("pending question"));
ok("only:<unknown id> says so instead of rendering an empty item", /no queued item with id "nope"/.test(renderStatus(big, {}, { only: "nope" })));

// ---------------------------------------------------------------------------
// 2. archive: the live pair shrinks, the record grows, nothing is lost
// ---------------------------------------------------------------------------

const repo = makeRepo();
seed(repo, 3, 2);
// A committed item's evidence files, which must be moved rather than deleted.
writeFileSync(join(repo, ".pi/fr-batch/done-1.contract.md"), "# frozen matrix\n");
writeFileSync(join(repo, ".pi/fr-batch/done-1.gaps.json"), '{"W1":{"kind":"k","what":"w","raisedRounds":[1],"state":"closed"}}');

const out = archiveItems(repo);
ok("archive sweeps every committed item", /archived 3 committed item\(s\)/.test(out), out.split("\n")[0]);
ok("...and reports what the queue is left with", /queue is now 4 live item\(s\); 3 archived in total/.test(out), out.split("\n")[1]);

const q = loadQueue(repo);
ok("the queue keeps exactly the live items, in order", q.items.map((i: any) => i.id).join(",") === "hot-paused,hot-blocked,todo-0,todo-1", q.items.map((i: any) => i.id).join(","));
const prog = JSON.parse(readFileSync(join(repo, ".pi/fr-batch/progress.json"), "utf8"));
ok("...and progress drops the archived entries with their notes", Object.keys(prog).sort().join(",") === "hot-blocked,hot-paused");

const raw = readFileSync(join(repo, ".pi/fr-batch/history.jsonl"), "utf8");
ok("history is one line per item", raw.trim().split("\n").length === 3, JSON.stringify(raw.slice(0, 80)));
ok("...and every line is independently parseable", raw.trim().split("\n").every((l) => JSON.parse(l).id.startsWith("done-")));
const rec = loadHistory(repo);
ok("...carrying the sha, the commit subject and the fix rounds", rec[1].sha === "sha1".padEnd(40, "0") && rec[1].commitMsg === "feat: done-1" && rec[1].fixRounds === 1);
ok("...and the closing note in full", rec[1].note === NOTE);
ok("...and where the evidence went", rec[1].stateDir === "archive/done-1");
ok("the frozen contract is MOVED, not dropped", existsSync(join(repo, ".pi/fr-batch/archive/done-1/done-1.contract.md")));
ok("...out of the flat base dir", !existsSync(join(repo, ".pi/fr-batch/done-1.contract.md")));
ok("an item with no evidence files records no stateDir", rec[0].stateDir === undefined);

ok("a second sweep is a clear no-op", /nothing to archive/.test(archiveItems(repo)), archiveItems(repo).split("\n")[0]);
ok("archiving a non-committed item is refused by NAME and state", /"hot-blocked" is blocked/.test(archiveItems(repo, "hot-blocked")));
ok("archiving an unqueued id says it is not queued", /is not queued/.test(archiveItems(repo, "ghost")));
ok("...and none of those refusals appended to the record", countHistory(repo) === 3, String(countHistory(repo)));

// A driver mid-batch rewrites progress.json on every phase transition, so a sweep landing
// between its read and its write would be silently undone. The lock is the interlock.
writeFileSync(join(repo, ".pi/fr-batch/.run.lock"), "pid 999 since now\n");
const lockedOut = archiveItems(repo);
ok("a fresh run lock refuses the sweep", /refused — a fresh run lock is present \(pid 999/.test(lockedOut), lockedOut.split("\n")[0]);
ok("...saying WHY, not just no", /progress entries that driver is still rewriting/.test(lockedOut));
ok("...and it changed nothing", countHistory(repo) === 3 && loadQueue(repo).items.length === 4);
rmSync(join(repo, ".pi/fr-batch/.run.lock"), { force: true });

const hist = renderHistory(repo, undefined, 2);
ok("history lists newest first", hist.indexOf("done-2") < hist.indexOf("done-1"), hist);
ok("...bounded by limit", !hist.includes("done-0"));
ok("...and says how many it did not show", /1 older item\(s\)/.test(hist));
ok("history only:<id> renders the whole note", renderHistory(repo, "done-1", 20).includes("arm-swap measurement"));
ok("history only:<unknown> says so", /no archived item with id "ghost"/.test(renderHistory(repo, "ghost", 20)));

// A hand-mangled or half-written line must cost ONE item, never the whole record.
appendFileSync(join(repo, ".pi/fr-batch/history.jsonl"), '{"id":"torn","pla\n');
ok("a torn line does not break the read", loadHistory(repo).length === 3, String(loadHistory(repo).length));
ok("...and does not inflate the count status shows either", countHistory(repo) === 3, String(countHistory(repo)));

// Two sweeps, and the record is APPENDED to: a later archive must not overwrite an earlier
// one. This is the property that makes archiving item 400 cost what archiving item 1 did.
const twice = makeRepo();
const seedOneCommitted = (id: string) => {
  writeFileSync(
    join(twice, ".pi/fr-batch/queue.json"),
    JSON.stringify(
      { armed: true, maxFixRounds: 4, childTimeoutMs: 1000, verifyTimeoutMs: 1000, defaultVerify: ["true"], items: [{ id, plan: `docs/FR_${id}_PLAN.md` }] },
      null,
      2,
    ),
  );
  writeFileSync(join(twice, ".pi/fr-batch/progress.json"), JSON.stringify({ [id]: { status: "committed", fixRounds: 0, updatedAt: "now", sha: `s-${id}` } }, null, 2));
};
seedOneCommitted("wave-1");
archiveItems(twice);
seedOneCommitted("wave-2");
archiveItems(twice);
const waves = loadHistory(twice).map((e) => e.id);
ok("a later sweep appends rather than replacing the record", waves.join(",") === "wave-1,wave-2", waves.join(","));
ok("...and the earlier line is byte-identical, not rewritten", readFileSync(join(twice, ".pi/fr-batch/history.jsonl"), "utf8").split("\n")[0].includes('"sha":"s-wave-1"'));

ok("status reports the archived count", /· 3 archived/.test(renderStatus(repo)), renderStatus(repo).split("\n")[0]);
ok("...and stops nagging about archiving once the queue holds no committed items", !/action "archive"/.test(renderStatus(repo)));

// The two cross-links: remove must point at archive, add must admit a repeat.
seed(repo, 1, 0);
appendFileSync(join(repo, ".pi/fr-batch/history.jsonl"), "");
ok("removing a committed item points at archive", /action "archive", only: "done-0"/.test(removeItem(repo, "done-0")));
const readd = addItem(repo, { plan: "docs/FR_new_PLAN.md", id: "done-1" });
ok("re-queueing an archived id is allowed but says it already ran", /already in history — committed as sha1/.test(readd), readd);

console.log(fails === 0 ? "\nprobe_scale: all pass" : `\nprobe_scale: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
