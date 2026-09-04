# fr-batch

Sequential FR-PLAN executor with a mechanical test-completeness gate.

**Installed once in user scope, used by every project.** The driver knows no build
system: the verify gate, the repo traps, and the item list all come from the
project's own `<repo>/.pi/fr-batch/queue.json`, and each child gets the project's
`AGENTS.md` / `CLAUDE.md` injected via `inheritProjectContext: true`. Duplicating a
project's build rules into this driver would be exactly the drift that injection
exists to prevent.

```
implement → verify → adversarial audit → [fix → verify → audit]×N → commit → next
```

Nothing here is a judgment call the batch can fudge: the gate is an exit code plus
a JSON field, and the commit only happens when both pass.

## Install

```bash
pi install npm:pi-subagents                      # required — see below
pi install git:github.com/AllenDang/fr-batch
```

Restart pi, or `/reload`.

**pi-subagents is a hard dependency, not an optional integration.** Every child is spawned
through its in-process RPC (`subagents:rpc:v1:request`) and there is no fallback path, so
without it `action: "run"` fails on the 30 s RPC timeout with `is pi-subagents loaded?`.
Read [Disk footprint](#disk-footprint) before the first run — its default `artifactDir`
writes to a directory nothing age-cleans.

**The three agents this driver spawns ship with it**, in `agents/`, declared by package.json
`"pi-subagents": { "agents": ["./agents"] }` — the key pi-subagents reads for package-supplied
agent definitions. Nothing to install separately and nothing to place in `~/.pi/agent/agents/`.

| agent | phase | writes | how it answers |
|---|---|---|---|
| `fr-implementer` | implement | yes | prose report |
| `fr-test-auditor` | audit | **no** (no edit/write tool) | `structured_output` verdict |
| `fr-gap-fixer` | fix (red verify, and audit gaps) | yes | `structured_output` report |
| `fr-bug-fixer` | `kind:"bug"` fix | yes | prose report |
| `fr-bug-scoper` | `kind:"bug"` sibling scout | **no** (no edit/write tool) | prose, non-blocking |

If a run ever reports `Unknown agent: fr-implementer`, the installed copy predates this or a
package filter dropped the directory: `pi update`, `/reload`, and check `/subagents`. That was
the first-install failure mode for real — the definitions used to exist only on the author's
machine, so a fresh install died on its first child while the guard suite stayed green.
`tests/probe_install.ts` now fails if an agent the driver spawns is not shipped and declared.

Then, in each repo the batch should work on:

```jsonc
// <repo>/.pi/fr-batch/queue.json   — yours; the driver only reads it
{
  "armed": false,                  // run refuses while false. Arm it deliberately.
  "defaultVerify": ["scons", "scons test && bin/ange_test"],   // this repo's own gate
  "items": [
    { "id": "L0-base", "plan": "docs/FR_base_PLAN.md" }
  ]

  // optional; shown with their defaults:
  // "maxFixRounds": 4,      // consecutive BARREN rounds, not rounds — see below
  // "maxTotalRounds": 12,   // total rounds, as a cost stop
  // "childTimeoutMs": 10800000,     // 3h — one child
  // "verifyTimeoutMs": 5400000      // 90min, PER VERIFY COMMAND (not per pass)
}
```

`defaultVerify` and `items` are the only REQUIRED fields, and `defaultVerify` is required for a
reason a default cannot satisfy: an empty gate silently passes everything. The three budgets are
optional — omit one and it takes the default above; give one a value that is not a positive
number and the queue is **refused at load, naming the field**. Both halves are new. They used to
be read raw, and an omitted `childTimeoutMs` travelled as `undefined` into
`setTimeout(fn, timeoutMs + 60_000)`, i.e. `setTimeout(fn, NaN)`, which fires immediately: every
child died milliseconds after launch with `child exceeded undefinedms`, and an omitted
`maxFixRounds` left the fix loop unbounded. `status` prints the resolved budgets, so a defaulted
one is visible without diffing this file against the defaults.

Take the gate from the project's own context file rather than inventing one. `/fr-batch` then
renders the queue and `action: "add"` appends to it, so this file is written by hand exactly once.

## Files and who owns them

All per-project state lives under `<repo>/.pi/fr-batch/`:

| file | owner | contents |
|---|---|---|
| `queue.json` | **you** | items, order, `armed`, budgets, `defaultVerify`, `repoRules`, model/effort config, `transient` policy. The driver only reads it. |
| `progress.json` | **the driver** | per-item `status` / `fixRounds` / `sha` / pause state. You only read it. |
| `history.jsonl` | `archive` | append-only record of swept items: id, plan, sha, commit subject, fixRounds, timestamps, closing note. One JSON object per line, never rewritten. |
| `archive/<id>/` | `archive` | the swept item's frozen contract + gap ledger + out-of-scope notes, moved out of the flat base dir. |
| `<id>.contract.md` | the driver | the item's **frozen audit contract**: the PLAN's `## Tests` matrix as committed at HEAD, before implementation. Written once. |
| `<id>.gaps.json` | the driver | gap adjudication ledger: every gap id ever raised, which rounds raised it, and `open` / `closed` / `rejected` + the fixer's reason. |
| `<id>.out-of-scope.md` | the driver | auditor findings the frozen contract does not ask for. Non-blocking; promote to a follow-up FR if worth having. |
| `.run.lock` | the driver | single-driver interlock. Stale after 15 min; a live driver refreshes it every minute so a long run is never mistaken for a dead one. |
| `<repo>/.pi-subagents/fr-batch/` | the driver | per-child output artifacts and audit verdicts. Intermediate rounds are pruned when the item commits; a blocked item keeps everything. |

Both of those live **inside the repo**, and every item commits with `git add -A` — so `run`
refuses to start until `.pi/` and `.pi-subagents/` are gitignored, naming the two lines to add. A
commit that has already swallowed the driver's own queue, contract, ledger and child transcripts
is not something this driver can un-make.

The split is not cosmetic — it is what makes **adding an FR while the batch runs**
safe. A single-file design would have the driver write back its in-memory snapshot
on every state transition and silently clobber your append.

## The live pair is sized by work in flight, not by project history

`queue.json` and `progress.json` are on every hot path: the driver re-reads the queue at
every item boundary, and `status` renders from both. A project with hundreds of PLANs that
never sweeps pays for all of them on every single look. Measured on ange's own queue: **409 B
per queue item** and a **354 B prose note per progress entry**, so 300 items is ~123 KB of
queue plus ~106 KB of notes — and, before the summary view, ~300 lines of `status` output per
inspection, of which at most a handful were actionable.

Two mechanisms keep both bounded, and they are independent:

**1. `status` is a summary by default.** It always shows everything not at rest — in flight,
paused, blocked, with the paused item's verbatim question — plus a 3-row preview of what is
next. Committed rows and the deep pending tail fold into one line each that *counts what it
folded*, so nothing is silently omitted:

```
  ⋯ 280  hidden — 280 committed
  … 18. port-ptex-pipeline       fixing        ebb33f7ae fixes:3 verify:default contract:frozen
    19. three-materials          pending       verify:default
  ⋯  57  hidden — 57 pending
```

The render is then the same size for a 342-item queue as for a 31-item one (pinned by
`tests/probe_scale.ts`). `all: true` restores every row; `only: "<id>"` trades the listing for
one item in depth — resolved verify commands, model per role, gap ledger summary, and the
**whole** note instead of its first line. That last one is the reason not to read `queue.json`
by hand.

**2. `archive` sweeps committed items out.**

```
fr_batch { action: "archive" }                   # every committed item
fr_batch { action: "archive", only: "L1-rock" }  # just one
fr_batch { action: "history" }                   # newest 20, one line each
fr_batch { action: "history", limit: 100 }
fr_batch { action: "history", only: "L1-rock" }  # one item in full, incl. its closing note
```

The committed item leaves `queue.json` and `progress.json`, and a line lands in
`history.jsonl` carrying its sha, commit subject, fixRounds, timestamps and closing note. Its
frozen contract and gap ledger are **moved**, not deleted, to `archive/<id>/` — a contract
runs to tens of KB and is the retrospective evidence for the commit.

Why JSONL and append-only: archiving item 400 costs what archiving item 1 did, a torn or
hand-mangled line loses **one** item instead of failing the parse of the whole file, and
`grep '"id":"foo"' history.jsonl` answers the common question without loading anything.
Nothing on the status path reads it — only a line count, for the `N archived` chip.

Why it is a separate action and not automatic on commit: *the driver only reads `queue.json`*
is the entire safety argument for editing the queue mid-run. Sweeping from inside the driver
would make it a writer. Conversely `archive` **refuses while a driver is live or a fresh
`.run.lock` is present** — unlike `add` / `remove`, it deletes from `progress.json`, which the
driver read-modify-writes at every phase transition, so a sweep landing between its read and
its write would be silently undone and the entries would come back as orphans. Archiving is
retrospective work; waiting for the batch to end costs nothing.

Re-queueing an id that is already in history is allowed — a PLAN can grow a follow-up phase —
but `add` says so, with the sha it committed as, because the queue no longer carries that
evidence.

## Why the audit loop terminates

The audit is adversarial on purpose, which makes its termination a design problem
rather than a matter of the auditor being satisfied. Three rules give the loop a fixed
point:

1. **The contract is frozen before the first audit.** `<id>.contract.md` snapshots the
   PLAN's `## Tests` matrix from HEAD. The fixer is still told to append rows to the live
   PLAN — that keeps the document truthful — but those rows are not in the contract, so
   they cannot come back as new demands.
2. **Only in-contract ids can block.** A gap whose `id` does not appear in the frozen contract
   **as a token** is recorded in `<id>.out-of-scope.md` and dropped from the gate. This is
   enforced in the driver, not just asked for in the prompt — and it is a token match, not a
   substring one: a bare `includes` made `T1` "in contract" for any PLAN mentioning `T10`, so an
   invented id could pass the one gate that keeps an item from being blocked by out-of-scope work.
3. **Nothing is re-litigated.** The ledger remembers every id and the rounds that raised it. A
   re-raised id stops the batch for a human instead of spending another round. The fixer's
   `rejected` list is durable, so an invalid gap dies once instead of every round.

Without (1) the loop has no fixed point at all: the fixer adds matrix rows and production
branches while closing gaps, and an auditor judged against the live PLAN then demands tests
for both. `maxFixRounds` only hides that as "blocked after N rounds".

**There used to be a fourth rule — block when a round's in-contract gap count did not fall — and it
was wrong by construction.** `repeats` is evaluated first and returns, so the count check could only
run when *no* gap that round had ever been raised before. Its firing condition was therefore "the
fixer closed every gap from the last round AND the auditor found at least as many previously
unexamined contract rows" — the best trajectory available, blocked as if it were the worst.

The premise behind it was that an audit is exhaustive at round 0. It is not: coverage is established
empirically, a row at a time, so a large matrix takes several rounds to walk and **incremental
discovery is the normal shape**. Observed on a real batch: a small matrix was exhausted in one round
with zero gaps, while a matrix several times larger was still surfacing new rows in a third round —
and it was stopped with budget left, then idled for hours waiting for a human, for converging
correctly. Both exits it offered (`reset`, or fix by hand) cost far more than the round it refused.

Nothing replaced it. Every count-based variant is unreachable behind `repeats`: if the ledger's
distinct-id total did not grow, every id that round was already in it, so every one has a non-empty
`raisedRounds`, so `repeats` already fired. Rule 3 plus `maxFixRounds` are jointly sufficient.

**What that leaves open, stated rather than hidden:** if one audit round cannot walk a whole matrix,
then `complete` means "found nothing in what I examined", not "examined everything". A green verdict
on the first round of a large contract is therefore weaker than it reads. That is the same vacuity
`planTestGate` exists to prevent, one level in — and unlike a false block it is invisible. Closing it
needs the auditor to report which rows it actually reached, which is a change to its schema and its
contract, not to this loop.

## Disk footprint

The driver's own files are KB-scale and self-pruning (intermediate round artifacts go away
when an item commits; `remove` and `reset` take an item's state with them).

The real cost is upstream: **every child spawn leaves ~1-2MB of transcript in pi-subagents'
artifact root**, and its default `artifactDir: "project"` writes to `<repo>/.pi-subagents/`
which is *not* age-scanned — it grows forever. Set this once in
`~/.pi/agent/extensions/subagent/config.json`:

```json
{ "artifactDir": "session" }
```

That moves artifacts under the pi session directory, which `cleanupAllArtifactDirs` does
age-clean. Existing `<repo>/.pi-subagents/artifacts/` content is not migrated — delete it by
hand once.

## The run is a background driver

`action: "run"` starts the loop and **returns immediately**. Everything else in this
document depends on that: pi delivers a queued user message only "after the current
assistant turn finishes executing its tool calls", so a tool that awaited a multi-hour
batch would freeze the supervising conversation for the whole batch — every message you
typed would sit in the steering queue, and `status`, `add`, `remove` and `stop` could not
run at all. The live append this queue was built for was unreachable from the session that
started the run.

Nothing in the loop needed the turn: children are already async subagent runs, and every
phase transition is already persisted in `progress.json`. The two things the turn did
provide are replaced explicitly — esc-abort by `action: "stop"`, the streaming card by
`action: "status"`.

- **One driver per repo**, enforced by `.run.lock` plus in-process state; a second `run`
  reports what the live one is doing instead of starting a rival.
- **Fast refusals still come back inline.** A disarmed queue, a dirty tree or a held lock
  settles within a 2 s grace window, and that text is the tool result — not a notification
  arriving after the tool already said "started".
- **The driver reports back on its own** when it finishes, pauses, or needs a decision: a
  TUI notification plus a `followUp` message that wakes a turn only once the conversation
  is idle. Do not poll `status` in a loop.
- **A quit or `/reload` ends the driver** (`session_shutdown` aborts it and drops the lock).
  The item's phase is in `progress.json`, so the next `run` resumes from it.

## Stopping a run

```
fr_batch { action: "stop" }        # graceful: end after the current child settles
fr_batch { action: "stop" }        # again: abandon that child now
```

Two steps, because **the driver cannot kill what it launched**: pi-subagents' RPC `stop`
refuses a running workflow ("not controlled by this extension runtime") and children are
spawned as workflows.

- The **first** stop is free of loss. The in-flight child runs to completion (bounded by
  `childTimeoutMs`), then the batch ends at the next phase boundary with its progress
  saved. `run` resumes; no `reset` needed.
- The **second** stop only stops the driver *waiting*. The child is **abandoned, not
  killed** — it may keep editing the tree for a while, so let it settle before the next
  run. The item is recorded as `paused` with `pauseKind: "stopped"` and **no child id**:
  reviving an orphan that may still be alive would put two children in one tree, so the
  next run re-enters that phase fresh over whatever it left on disk.

Flipping `armed` to `false` mid-run is the third, coarsest stop: the driver exits at the
next **item** boundary.

## Use

```
/fr-batch                  # status: summary — in flight, next few pending, driver state
/fr-batch all              # status with every queue row
/fr-batch plan             # dry run: what would execute, in order
/fr-batch run              # start the background driver (needs armed: true)
/fr-batch stop             # end it (twice to hard-stop)
/fr-batch archive          # sweep committed items into history.jsonl
/fr-batch history          # list archived items, newest first
```

or through the tool, which is what the command delegates to:

```
fr_batch { action: "status" }                        # summary
fr_batch { action: "status", all: true }             # every row
fr_batch { action: "status", only: "L1-rock" }       # one item in depth, full note
fr_batch { action: "plan" }
fr_batch { action: "run" }                          # returns at once; the batch runs on
fr_batch { action: "stop" }
fr_batch { action: "continue" }                     # after a network pause
fr_batch { action: "continue", only: "L1-rock",     # after a DECISION NEEDED stop
           answer: "Vendor the .ptex; the transcription is a reference artifact, not the shipped material." }
fr_batch { action: "add", plan: "docs/FR_x_PLAN.md", verify: ["scons", "scons test"] }
fr_batch { action: "add", plan: "...", model: "anthropic/claude-sonnet-4-5", thinking: "high" }
fr_batch { action: "add", plan: "...", after: "L0b-vertex-channels" }
fr_batch { action: "remove", only: "L1-rock" }
fr_batch { action: "reset",  only: "L1-tree" }       # redo from scratch
fr_batch { action: "archive" }                       # committed items → history.jsonl
fr_batch { action: "history", only: "L1-rock" }
```

`remove` only takes an item that is `pending` or `blocked`. One that is mid-flight needs a
`stop` first, and one that is `paused` holds uncommitted work — `reset` it before removing
it, or those edits are orphaned with no queue entry that explains them. A **committed** item
is not removable at all: `archive` is its exit, and it keeps the record.

## Two kinds of item

An item's `kind` picks its pipeline. Omit it and you get `"fr"`, so every existing `queue.json`
keeps working untouched.

```jsonc
{ "id": "L0-base",  "plan": "docs/FR_base_PLAN.md" }                                  // kind:"fr"
{ "id": "clobber",  "kind": "bug",
  "plan": "tests/fixtures/velocity_clobber_bug/BUG_REPORT.md" }                        // fixture = the plan's dir
{ "id": "foreach",  "kind": "bug",
  "plan": "docs/FIX_foreach_over_event_array.md",
  "fixture": "tests/fixtures/foreach_over_event_array_bug" }                           // report elsewhere
```

```
implement → verify → adversarial audit → [fix → verify → audit]×N → commit      kind:"fr"
capture  →  [fix → gate]×N  →  scope  →  commit                                 kind:"bug"
```

**One kind per run**, because one working tree takes one writer: two pipelines alternating in it
would let one item's `git add -A` swallow the other's half-finished state.

```
/fr-batch run          # kind:"fr"
/fr-batch run-bug      # kind:"bug"
fr_batch { action: "run", kind: "bug" }
```

`only:<id>` overrides the filter, and dispatch always follows the **item's** own kind — otherwise
every `continue` / `reset` command a bug item's own messages print would filter that item out and
report "finished. 0 of 0".

### Why the bug pipeline has no audit loop

The FR pipeline's frozen contract and three convergence guards exist for one reason: **its
implementer writes the tests it will be judged by**, so under-testing is invisible to the project's
own gate and only an adversarial auditor can catch it. That audit is open-ended, hence the machinery
that makes it terminate.

A bug fixture inverts the premise. The pin **pre-exists the fix** and was written by someone who did
not have to make it pass, so the verdict is the project's own runner and the anti-cheat is a
comparison against a state captured before anything was edited. No contract, no ledger, no auditor —
about 60% of the FR pipeline's complexity has nothing to bite on here.

One cheat survives that argument, and it is the reason this pipeline looks the way it does: **the pin
is a file in the tree and the fixer holds `edit`/`write`.** Invert one assertion and a naive gate
sees the reproduction go green, the project's suite never runs fixtures, and the batch commits the
destruction of the only record of the defect. So:

- **the pin must be committed** before capture — git reports no changes for a path it does not
  track, so an untracked pin has no protection at all;
- **the pin and the report may not change**, checked with `git status --porcelain` and not
  `git diff --name-only HEAD`. Measured: with a tracked pin edited *and* an untracked file added
  inside the fixture, `diff` reports only the first. Tracked-only would let a fixer add a second pin
  the runner picks up, and would make `requirePin` red every correct fix, since a new in-suite test
  is untracked until the driver's own `git add -A`.

### The protocol comes from your repo

This driver knows no test runner either. `queue.bugProtocol` (overridable per item) says how to run
one pin and how to read its verdict:

```jsonc
"bugProtocol": {
  "run": ["./run-one-fixture.sh {fixture}"],         // your project's own runner
  "results": "{fixture}/.results.jsonl",             // JSONL: one {name, passed} per line
  "redExit": [1], "greenExit": [0], "invalidExit": [2],
  "requirePin": true, "pinPattern": "^tests/test_.*\\.cpp$"
}
```

**Two verdict modes, decided once at capture and recorded in `<id>.baseline.json`:**

| mode | when | verdict | anti-cheat |
|---|---|---|---|
| scenario | `results` resolves | the per-row `name`/`passed` map | full — `false→true` required, `true→true` required, a missing row is a failure |
| exit | `results` is `null` | the exit code | one bit; said so in the log |

`"results": null` **explicitly unsets** an inherited sink. That sentinel is not cosmetic: a
field-by-field merge has no spelling for "absent", so a queue that sets `results` for its
scenario-shaped fixtures would force the same path onto its exit-shaped ones — whose runner never
writes it — and each would block forever. In a real corpus the two shapes coexist: the large
majority of fixtures carry a per-scenario record and a minority are exit-code-only probes, so one
queue certainly holds both.

The mode is **never re-derived** at the gate. An item that captured a red scenario baseline and whose
runner later stopped writing the sink would otherwise be re-classified into exit mode, read exit 0 as
green, and commit with the defect unfixed.

### What the bug gate does NOT stop

Written down because a known limit that is not written down is not a known limit. Each of these was
found by attacking the gate, not by reading it.

**The runner's environment is outside every check.** The fixer holds `bash`, and the pin runs through
`bash -lc` — a **login** shell, so it sources the operator's profile. A `PATH` entry, an environment
variable, a gitignored cache directory the runner trusts, or any state outside `pinPaths` can decide
the verdict, and none of it leaves a trace in git. This is not closable here: a child that can execute
arbitrary commands can eventually influence any verdict computed on the same machine. **The boundary is
a sandbox, not this gate.** What the gate does guarantee is that the *pin and the report* are
byte-identical to what was captured.

**`requirePin` proves a file arrived, not that it asserts anything.** It matches changed paths against
`pinPattern`. An empty file, a whitespace edit to an existing match, or a deletion of a matching file
all satisfy it. The deeper guarantee comes from the project's own suite, which runs as `defaultVerify`
in the same gate — `requirePin` is a fast fail, not a proof.

**`requireMechanismTouch` is a heuristic, and off by default.** It checks that the diff touches a file
the report's `file:line` citations name. A cosmetic edit to a cited file satisfies it. Only path-qualified
citations are matched by suffix, so a bare `foo.c:12` no longer matches any same-named file anywhere —
but the check is file-level, never line-level.

**`.pi/fr-batch/` is gitignored, so no git check sees a write to it.** The captured baseline is read
once at capture and the gate compares against the in-memory copy, so a mid-item write cannot reach that
run's verdict — pinned by a test. On **resume** the file is read back, and there the one tamper worth
making is refused: an all-green scenario map cannot have come from capture, which records an
already-green pin as `skipped` instead. A subtler edit to a resumed baseline is not caught. Setting
pi-subagents' `artifactDir` to `session` keeps child transcripts out of the repo but does not change
this.

### `skipped`

A pin that is already green when the batch reaches it needs no work, and `committed` would be a lie —
there is no commit. It becomes `skipped`, which is a **terminal** status: the driver's selection, its
pre-lock clean-tree guard, the dry run and the `finished` line all treat it like `committed`, or a
skipped item is re-selected forever and the clean-tree refusal silently stops firing. `archive`
sweeps it with no sha; `remove` accepts it.

This is what makes fixing one defect that greens a whole cluster free: the siblings are skipped
without spawning anything.

## Arming

`queue.json` should ship with `"armed": false` and `run` refuses. Set it to `true` only
when you actually want the batch writing to this repo, and only when **no other
session is working in it** — the implementer edits the tree in place, and two
writers corrupt each other.

Flipping `armed` back to `false` mid-run is a **graceful stop**: the driver
finishes nothing new and exits at the next item boundary. For a finer one, use
`action: "stop"` — it ends the batch at the next *phase* boundary.

## Adding an FR mid-run

The driver re-reads `queue.json` at every item boundary, so `action: "add"` lands
on the next iteration with no restart. Two guard rails:

- Order matters here (L0 → L0b → L0c → L1s), so `add` takes `after` / `before`.
  An insert that would land only among already-committed items is **refused**, not
  silently accepted, because the driver picks the first uncommitted item and would
  never reach it.
- Omitting `verify` inherits `queue.defaultVerify`. That is visible in `status` as
  `verify:default` — an item's real gate should usually come from its PLAN's own
  "Build, validate, test" section.

## Per-project configuration

`queue.json` carries everything repo-specific:

- **`defaultVerify`** — the project's acceptance gate. Take it from the project's
  own context file rather than inventing one (ANGE: `scons` / `scons test`; a
  React Native repo: `npm run lint` / `npx tsc --noEmit` / `npx jest`).
- **`repoRules`** — optional emphasis appended to every child's task. Use it ONLY
  for a trap the context file already documents but agents keep ignoring: a stale
  incremental-build cache, a required codegen step. Do **not** restate the context
  file here; `inheritProjectContext: true` already injects it.
- **`transient`** — network retry policy (see below).
- **`defaultModel` / `defaultThinking` / `roles`** — which model and reasoning effort
  each child runs on (see below).

## Model and reasoning effort per child

Configure nothing and every child runs on **the model and effort of the conversation that
started the batch**. That inheritance is explicit, not incidental: pi-subagents passes the
parent's *model* down on its own but not its *effort*, so leaving it implicit would inherit
half the setting and quietly run a 30-hour batch at the global default effort.

Four layers, most specific first, and **each field resolves on its own**:

```
item.roles[role]  →  item  →  queue.roles[role]  →  queue.default*  →  this session
```

```json
{
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "defaultThinking": "medium",
  "roles": { "auditor": { "thinking": "high" } },
  "items": [
    { "id": "L0-base", "plan": "docs/FR_base_PLAN.md" },
    { "id": "L1-hard", "plan": "docs/FR_hard_PLAN.md",
      "model": "anthropic/claude-opus-4-1", "thinking": "high",
      "roles": { "fixer": { "thinking": "low" } } }
  ]
}
```

- **Three roles, not four phases**: `implementer`, `auditor`, `fixer`. Both fix phases
  (verify-red and audit-gap) are the same agent doing the same job, so one knob covers them.
- Per-**field** resolution is what makes `roles: { auditor: { thinking: "high" } }` compose
  with a batch-wide `defaultModel` instead of having to restate it.
- `"model": "sonnet-4-5:high"` is read as model + effort, so a more specific layer can
  still override just the effort.
- `"model": "inherit"` sets no model at that layer, so
  `{ "defaultModel": "inherit", "defaultThinking": "high" }` means "this session's model, at
  high effort".
- Efforts are pi's own: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. An
  unrecognised one is **rejected when the queue loads**, not dropped in silence — the
  failure it prevents is a queue that reads as configured while every child runs on the
  default.
- The effort travels as the `:<effort>` suffix on the model id, because that is the only
  channel pi-subagents' spawn RPC has for it. So an effort with no model anywhere to carry
  it cannot be delivered; the driver logs that instead of pretending it applied.
- `status` prints the resolved baseline plus what `inherit` currently means, and chips only
  the items that differ from it. `plan` prints the resolved value per item.
- A **resumed** child (network pause, decision pause) keeps the model it launched with:
  `resume` revives a retained session, it does not re-decide its contract.

## What a run owes the tree it leaves behind

Three things end a child's supervision, and the driver **cannot kill any of them** — pi-subagents'
RPC `stop` refuses a running workflow and children are workflows. So all three behave the same way,
and the one thing they owe you is the truth and a handle:

| | recorded | resumable | says the child may still be running |
|---|---|---|---|
| `stop` twice (hard) | `paused` | yes | yes |
| `childTimeoutMs` expiring | `paused` | yes | yes, **with the run id** |
| a `/reload` or quit | `paused` | yes | yes |

The timeout used to `block()` instead, which is sticky, said nothing about the loose process, and
invited an immediate re-run into a tree two children were writing. Measured on a real batch: an
abandoned child still editing files, its orphaned build colliding with the operator's over one
`build/`, a 40-minute test run competing for the same result files, and two orphans at 2h47m and 48m
burning CPU — all with parent pid 1, invisible to the driver.

**The message names the run id**, because that is the only handle that works:

```
subagent interrupt <run id>
```

Let it settle before the next run. Two children in one tree corrupt each other.

### A block says what it invalidated

`blocked` used to mean two unrelated things, and only one of them justified being sticky:

| scope | when | a plain `run` |
|---|---|---|
| `verdict` | the gate returned against the item — verify still red at budget, in-contract gaps at budget, a re-raised id, a laundered pin | **refuses.** A human changed something and the driver cannot tell whether the phase or the frozen spec still stands |
| `attempt` | the attempt never happened — a child that could not launch, a bad install, a dead workflow | **resumes** the recorded phase over the files on disk |

For a `verdict` block there is still a work-preserving exit, and it is an explicit operator act
rather than a guess by the driver:

```
fr_batch { action: "continue", only: "<id>" }    # keeps the tree, re-enters the phase
fr_batch { action: "reset",    only: "<id>" }    # starts over — and does NOT clean the tree
```

`reset` leaving the tree dirty is what made this expensive: the next `run` then refuses those very
changes as a dirty tree, so the only way out was a WIP commit — breaking the one invariant the driver
exists to keep. It now says so, and names `continue`.

### The fix budget counts BARREN rounds

`maxFixRounds` bounds **consecutive rounds that closed nothing and rejected nothing**, not rounds.

Counting rounds punished the healthy trajectory. An auditor establishes coverage empirically, a row
at a time, so a large matrix takes several rounds to walk — and an item that closes everything it is
handed each round while the auditor reaches deeper is *converging*. Measured on a real batch: 3 gaps
closed, then 3 more closed, then 1, and the budget ran out anyway.

This is not a looser bound. An item that closes nothing is stopped **sooner**, because barren rounds
are counted consecutively instead of being diluted by productive ones. `maxTotalRounds` is the cost
stop on top, for an auditor/fixer pair that alternates one closure with one discovery and so never
goes barren.

The verify-red loop still counts rounds, deliberately: there the fixer is handed one concrete failing
command with its output, so a round that leaves it failing produced nothing by definition.

**Know the worst case before you raise it.** At the defaults, one item can spend
`12 × (3h auditor + 3h fixer + 90m verify)` = **90 hours** before `maxTotalRounds` stops it. The
round-counting version capped that at 4 rounds, so ~30 hours. Three times the exposure is the price
of not stopping a converging item, and it is a price you can decline: `maxTotalRounds` is the knob,
`status` prints it and each item's `barren:N`, and the numbers above are just
`maxTotalRounds × (2 × childTimeoutMs + verifyTimeoutMs)`. There is deliberately no separate
wall-clock budget — a third bound on the same loop would be one more thing to keep consistent, and
these two already express it.

### Prove freshness by CONTENT, not by timestamp

If your `defaultVerify` checks that a build is current, do not check mtimes:

```bash
test -z "$(find src tests -newer bin/thing)"     # ← a false-red generator. Do not.
strings bin/thing | grep -c 'a literal your change adds'   # ← asks whether the change is IN there
```

`git checkout` touches mtimes without changing content, and a build then correctly declines to
relink — so the timestamp check reds on a tree that is perfectly current. Measured on a real batch:
three false reds, one of which burned a whole fix round and then the item.

### The run lock knows who holds it

The lock records the holder's pid, and liveness is decided by asking whether that process exists —
not by the file's age. A driver that crashed, was reloaded, or quit leaves a lock that is reclaimed
immediately, instead of refusing `reset` and `archive` for fifteen minutes. A lock naming a live pid
is respected however old it is.

A superseded driver also stops reporting: a `/reload` leaves the old in-process loop's timers alive,
and its completion message would otherwise arrive carrying budgets from a queue since edited, or
naming an item since removed.

## Network outages

The layering is deliberate and the reason is a hard constraint: **a model-API
outage cannot be reported by the subagent, because the reporter is the thing that
broke.** The child is a `pi --mode json -p` subprocess; when its model call fails
the failure is in the harness and the model never gets a turn in which it could
call `contact_supervisor`.

So:

| failure locus | detection | recovery |
|---|---|---|
| model API (the common case) | post-mortem, from the child's `error` / `modelAttempts[].error` | driver backs off, then **`resume`s** the same child — its session, context, and already-written files are intact |
| a tool the child ran (fetch, install, clone) | the child reports it via `contact_supervisor` with a `NETWORK_DOWN:` message and blocks | driver holds it blocked through the same backoff, then writes the reply file to release it |

That second row is only true if the driver looks in the right place, and for a long time it did
not: the channel root is `PI_SUBAGENTS_TEMP_ROOT` or `<tmpdir>/pi-subagents-<uid-scope>`
(pi-subagents `shared/types.ts`), not `<tmpdir>/pi-subagents`. With the wrong root every ask went
unanswered, pi-subagents detached the child, and the driver saw an opaque `status: "paused"`. The
roots are now derived from that rule and scanned as a list, and an expired request — one the child
has already stopped polling — is skipped rather than surfaced as a live question.

Three layers, three jobs:

- **pi's in-child retry** (`retry.maxRetries: 3`, `baseDelayMs: 2000` → ~14 s) is
  the *blip* filter. Left alone on purpose; a single 502 should not wake the driver.
- **this driver** is the *outage* handler: exponential backoff with full jitter,
  `transient.maxRetries` attempts, `baseDelayMs → maxDelayMs`.
- **you** are the last resort: after the retries are spent the item is persisted
  as `paused` and the driver asks. In a TUI you get a confirm dialog; headless or
  after 10 minutes it returns with instructions and you resume with
  `fr_batch { action: "continue" }`.

`transient.probeUrl` is optional. Set it to something on the path to your model
provider and a recovered network shortens the wait instead of idling out the full
backoff. Left empty, the retry attempt is itself the probe.

Classification is a **conservative allowlist** (`ECONNRESET`, `ENOTFOUND`,
`EAI_AGAIN`, `socket hang up`, `fetch failed`, `429`, `502/503/504`, `overloaded`,
`rate limit`, `stream ended without a stop reason`, …). Anything unmatched is treated as a real
failure, because retrying a real failure wastes an hour and hides a bug. Bare `timeout` is
deliberately **not** a signature — our own wall-clock expiry is a budget problem
that needs human eyes, not another 90-minute attempt.

The cost of a signature that is one word short is the whole item, not a slower retry.
`stream (?:error|interrupted|closed)` did not match `Bedrock stream ended without a stop
reason`, so a transport fault was filed as a real failure and **blocked an implementer that had
already written three complete files** and was starting the fourth — work `resumeOnRetry` would
have revived intact. A miss here does not degrade gracefully; add the phrasing when you see one.

`fallbackModels` is empty on all three agents on purpose: switching models during
an outage is pure waste and disguises one outage as "several models failed for
real".

That rule predates per-role models, and a fallback across *different providers* is
not the same outage twice — so it is an open question rather than a settled ban. It
stays unconfigured, and these two mechanical facts bound anyone revisiting it:

- **A fallback list is static, agent-scoped config.** `buildModelCandidates()` reads
  `agent.fallbackModels`; no `spawn` / RPC / workflow-child param carries one. So
  "fall back to whatever the supervising session runs" cannot be written in pi's own
  fallback mechanism at all — only fr-batch knows the live session.
- **A driver-side fallback cannot resume.** pi's in-child fallback re-invokes with the
  same `--session <file>`, so the second model continues the transcript and sees what
  the first already wrote. RPC `resume` takes `{ id, message }` and reads the model
  from the persisted descriptor, so a model switch here means a **fresh** child over a
  half-edited tree — losing the work preservation this layer exists for.

## A child that never started is reported in seconds, not in hours

The completion event is best-effort. A workflow that dies at launch — `Unknown agent:
fr-implementer`, measured at **37 ms** from `startedAt` to `endedAt` — writes no result for
pi-subagents' result watcher to publish, so `subagent:async-complete` never fires. The driver was
then waiting on a promise nobody would settle: the item read `implementing` for 51 minutes and
would have read it until `childTimeoutMs` (3 h) expired into a second, equally uninformative
WALLCLOCK error. The run's own state said `failed` the entire time.

So `rpc.ts` no longer trusts the event alone:

- **Events that arrive before the launch RPC replies are buffered, not dropped.** Subscribing
  early was already the intent; `if (!asyncId) return` threw away exactly the events that
  subscription existed to catch.
- **The run's state is polled** (`status` RPC, every 15 s) and, once terminal, settles the child:
  after 20 s for `failed` / `stopped` / `rejected`, after 120 s for `complete` — longer there
  because the event is the normal path and carries the child's `structuredOutput`, which a
  synthesised outcome cannot.
- **Every child's non-success status now blocks its own phase**, and the message carries the
  child's `error`, not just its `summary` — which for a workflow that never started is the empty
  string. `Implementer ended with status "failed". Summary:` used to be the whole report. An
  `Unknown agent` in there also prints what to do about it, because that is an install problem
  and its fix is not a diagnosis.

## A PLAN with no test matrix is refused before anything runs

`ange`-style PLANs are graded by their `## Tests` behavior-branch matrix: the implementer is
told to turn every row into a real test, and the auditor may only raise a gap that NAMES a row
of the frozen contract. A PLAN with no matrix therefore has no test obligation to satisfy and
an audit gate that passes by vacuity — it would report a green item that was never checked.

So the driver reads the PLAN **before spawning any child** and blocks the item if it has no
tests section, or a tests section with no rows. Nothing is written and nothing is committed;
the message names the PLAN and what to add.

The heading is matched by its TEXT, not by an exact spelling — `## 6. Tests — the branch
matrix` and `### Tests` both count. That matters: the original `^## Tests$`-only matcher
silently treated 10 of the first 15 committed items as "no matrix" and froze the WHOLE PLAN as
the audit contract, announced by one log line in a 24-line rolling window.

## A decision the driver cannot make

A child that hits a real blocker — a PLAN row whose premise is false, a prerequisite that does
not exist in the tree — is told to call `contact_supervisor({ reason: "need_decision", ... })`
rather than guess. The driver **cannot** answer that: it is a batch driver, not a supervisor,
and the operator's answer can be hours away. Leaving the child blocked on its channel that long
is not an option either — pi-subagents detaches a child waiting on an unanswered ask, the
driver then saw only `status: "paused"`, and the item was blocked with `Implementer ended with
status "paused". Summary: Detached for intercom coordination before task completion.` — the
question itself reached nobody and lived only inside the child's own report file.

So the driver watches for **every** unanswered ask, not just `NETWORK_DOWN:` ones:

1. a non-network ask is released immediately with a directive: stop, and write the question,
   the options you measured and your recommendation into your report;
2. the item is persisted as a **decision** pause with the question verbatim (`pendingAsk`),
   and the child's run id, so it can be revived;
3. the question is reported to the supervising session verbatim — inline when the pause
   happens inside the grace window, otherwise through the driver's own `followUp` message.
   `action: "status"` shows it too, for as long as the item stays paused;
4. `action: "continue"` **refuses** such an item without `answer:` (reviving the child without
   its answer just makes it ask again). With `answer:`, that exact child session is revived and
   told the decision is binding — its context and already-written files are intact.

The post-outcome sweep of the channel matters: a child that detaches the instant it asks can
finish inside the watcher's 3 s poll gap, and the unanswered request file outlives it. That
sweep is what stops the question from being lost in exactly the case the child could not
report itself.

## Stopping conditions

| outcome | meaning | tree | next items |
|---|---|---|---|
| `committed` | verify green, audit found nothing in the frozen contract | clean | continue |
| `paused` (network) | network unreachable after the retries | holds this item's work | not started |
| `paused` (decision) | a child asked a question only you can answer | holds this item's work | not started |
| `paused` (stopped) | you hard-stopped the driver mid-child; that child was abandoned, not killed | holds this item's work, plus whatever the abandoned child was mid-way through writing | not started |
| `blocked` | PLAN missing / has no test matrix (nothing ran); a child that could not run at all (bad install, dead workflow); verify still red; audit still finds in-contract gaps after `maxFixRounds`; or the audit is **not converging** (an adjudicated id was re-raised, or the gap count did not fall) | holds this item's work | not started |

`blocked` and `paused` both stop the batch — later items depend on the earlier one
landing. Neither commits anything.

**`blocked` is sticky, and `run` does not retry it.** The next run sees the recorded note and
re-reports it. That is deliberate: the item's phase and its frozen contract are still on disk and
the driver cannot tell which of them your fix invalidated. Clear it yourself — `reset` to
re-implement from scratch against a re-frozen contract, or `remove` to drop it.

A non-convergence block is not a budget timeout: it means the loop cannot terminate on its
own. Read `<id>.gaps.json` — either the fixer's closing test really is vacuous (fix it by
hand) or the auditor is re-litigating a settled row (record the rejection in the ledger).

## The modules

One file per concern, dependencies pointing one way. `index.ts` is a registration shim and
declares nothing of its own — so "where does this behaviour live" is answered by the file list,
not by scrolling.

| file | lines | what |
|---|---|---|
| `index.ts` | 262 | `registerTool` + `registerCommand` + `session_shutdown`. The architecture note at the top is the map. |
| `driver.ts` | 858 | `runBatch` — the item loop: gate, freeze, implement, verify, audit, fix rounds, commit. |
| `resilience.ts` | 513 | transient-failure signatures, backoff, connectivity probe, the child's supervisor-ask channel, `NetworkPause`. |
| `rpc.ts` | 375 | pi-subagents' in-process RPC: launch a child, settle on its completion event **or on its run state**. |
| `types.ts` | 320 | every interface, both JSON schemas, the shared constants. No logic. |
| `store.ts` | 314 | on-disk state: queue (+ budget defaults/validation), progress, history, run lock, artifact pruning. |
| `render.ts` | 298 | `status` (summary / all / one item) and `history` rendering. |
| `contract.ts` | 301 | the frozen audit contract, the gap ledger, out-of-scope recording, verdict parsing. |
| `bug_pipeline.ts` | 801 | `runBugItem` — the `kind:"bug"` pipeline: capture the red baseline, fix, gate, scope. |
| `queue_ops.ts` | 292 | `add` / `remove` / `reset` / `archive` — the only writers of `queue.json`. |
| `background.ts` | 188 | start / stop / finish the background driver, and how it reports back. |
| `prompts.ts` | 144 | the three agents' per-item task text. Prose, not logic. |
| `config.ts` | 128 | the model + reasoning-effort layer stack. |
| `state.ts` | 70 | live-driver registry and its formatters. The only shared mutable state. |
| `paths.ts` | 30 | every path under `.pi/fr-batch/`, plus `writeAtomic`. |
| `agents/*.md` | 210 | the three agent DEFINITIONS — who each child is, and the two escalation protocols the driver implements. Shipped, not assumed. |

The split between `agents/*.md` and `prompts.ts` is the standing/per-item split: the definition
is the child's identity and its protocol obligations (never commit, `NETWORK_DOWN:`,
`need_decision`), the prompt is this item's PLAN and gap list.

Three invariants hold the split together, all pinned by `tests/probe_modules.ts`:

- **No import cycle.** A cycle typechecks and then fails as an undefined binding at load
  time, in a user's session. (The probe rejects type-only back-edges too — those cannot break
  at runtime, but they mean the boundary is drawn wrong; `SupervisorAsk` moved to `types.ts`
  for exactly that reason.)
- **Only `index.ts` imports a *value* from a pi package.** This is what lets the probes
  import the real modules under plain node: `import type` is erased before resolution, a
  value import is not.
- **No TS constructor parameter properties.** They are a runtime feature node's
  type-stripping loader cannot execute.

## After editing

```bash
node tests/typecheck.mjs   # link .types/ + typecheck (prints the tsc version it used)
node tests/run.mjs         # guard tests (~70s)
node tests/mutation.mjs    # prove each fix's guard goes RED when the fix is reverted (~1min)
```

`tests/mutation.mjs` is the answer to this suite's worst moment: the whole suite stayed green with
all three agent definitions deleted. It reverts each fix in source, runs the probe that is supposed
to catch it, and fails if the probe stays green — so "verified RED when reverted" is a command
anyone can re-run instead of a claim in a commit message. It restores every file and re-runs the
whole suite before it exits, and exits non-zero if any fix is left uncovered — so the current count
is whatever `node tests/mutation.mjs` reports, not a number in this file that goes stale between
commits. It has caught dead code twice: a cause-chain unwrap and a `realpathSync` call, both of which
could not change any outcome and were deleted rather than pinned.

A `pi install git:` copy lives at `~/.pi/agent/git/github.com/AllenDang/fr-batch`, and
`pi update` **resets and cleans** that clone — so edit your own checkout and point pi at it
with a local-path package (`pi install /path/to/fr-batch`) rather than editing in place.

`tests/run.mjs` runs eight probe files against the real modules and throwaway git repos — 323
assertions. It covers the supervisor-ask classification and reply file, the detach marker, the
tests-section matcher, the pre-flight gate, `runBatch`'s decision-pause refusal, the
model/effort layer stack (both in isolation and end-to-end into the spawn params of every
role), the background driver's whole lifecycle (immediate return, mid-run `add`, graceful vs
hard `stop`, the resumable stopped pause, one-notification-per-run, the run-lock heartbeat),
the module invariants above, the install surface (below), and the scale contract: that `status`
renders the same number of lines for a 342-item queue as for a 31-item one while never folding
an actionable row, and that an `archive` sweep moves the record to `history.jsonl` without
losing a note, a contract file, or a refusal. Each fix it covers was verified to turn it RED
when reverted.

`tests/probe_install.ts` is the newest file and it exists because of a specific hole: the suite
asserted that the spawn param `agent` equals the string `"fr-implementer"` and never that
anything answers to that name, so deleting all three agent definitions changed no assertion
while making a fresh install fail on its first child. It now derives the agent list by grepping
`driver.ts`, so a fourth agent cannot be added without either shipping its definition or turning
this red, and it checks the definitions carry what the driver's contract needs
(`inheritProjectContext`, `contact_supervisor`, both escalation protocols, write tools for the
two writers and none for the auditor). It also pins the budget defaults and refusals, that a
completion event arriving inside the launch round-trip still settles the child, and that a
block message states the child's `error` rather than its empty `summary`.

The same vacuity had a **second instance**, and it hid a dead feature: `probe_channel.ts` wrote its
supervisor-ask fixture *into* `SUPERVISOR_CHANNEL_ROOT` and read it back, which holds for any value
that constant can have. It held `<tmpdir>/pi-subagents/supervisor-channels`, a directory nothing
creates — pi-subagents' root is `PI_SUBAGENTS_TEMP_ROOT` or `<tmpdir>/pi-subagents-<uid-scope>` —
so `findPendingAsks` returned `[]` in production forever: no `NETWORK_DOWN:` report was ever held
through an outage and no decision ask was ever answered, which is exactly why every such child
ended up "Detached for intercom coordination" instead. `probe_install.ts` now pins the roots
against pi-subagents' own rule, spelled out from upstream rather than imported, so a wrong root
cannot satisfy its own test.

`tests/probe_audit2.ts` covers the second audit wave: token-bounded gap-id scoping (a bare
`includes` let `T1` match a contract containing `T10`, and an out-of-contract gap that passes the
scope gate blocks the item), that an unparseable verdict re-runs the auditor **only** and not the
whole verify gate, `reset`'s live-driver refusal, that a status-less progress patch keeps a pause's
revival fields, that an expired supervisor request is not reported as a live question, and that
artifact pruning keeps the audit verdict rather than a fixer report whose filename also ends in
`-audit-<N>.json`.

**A hard quit records nothing.** `session_shutdown` aborts the loop, retires the driver and drops the
run lock, but the abandonment note is written by the loop itself as it unwinds — and on a real process
exit the loop never runs again. So a killed session can leave `progress.json` reading `implementing`
with no explanation. That is a missing *artifact*, not a stuck item: a stale `implementing` is treated
as re-enterable and the next `run` picks the item up over the files on disk. Writing the note from the
shutdown handler would mean duplicating the abandonment record in a second place that cannot know what
the loop knows, which is the divergence the single abandonment path exists to prevent.

An audit now leaves **two** files: the narration at `<id>-audit-<N>.md` and the machine-readable
verdict at `<id>-audit-<N>.verdict.json`. One consequence is worth stating because it is silent: an
item audited before that split and committed after it loses its audit artifact, because
`<id>-audit-<N>.json` matches neither keeper and prune deletes what it does not keep. Nothing else
reads those files, so the loss is cosmetic — but it is a loss, and it happens without a word.

The probes `import { runBatch } from "../driver.ts"` directly. They used to run against a
regenerated *copy* of a single 3.5k-line `index.ts` with three fragments rewritten to make it
executable — a copy that bailed out with "index.ts no longer contains the text this harness
rewrites" on any reformat, and that needed an appended export block to reach module-private
functions. The split removed the whole mechanism.

Then `/reload` in any running session to pick the change up — **but not while a batch is
running**: the driver is an in-process loop, and `session_shutdown` aborts it.

`tsconfig.json` maps the three pi packages out of pi's own global install, so this works
without a local `npm install`. It reaches them through `.types/`, a gitignored symlink farm
that `tests/typecheck.mjs` builds from `npm root -g` (override with `PI_PKG_ROOT`); the paths
used to be spelled `/opt/homebrew/...` in the committed config, which is one node
installation out of several — under nvm the directory does not exist, and both `tsc` and an
editor then reported every pi import as unresolved. `--link-only` refreshes the links without
typechecking, which is all an LSP needs. `allowImportingTsExtensions` is on because pi
resolves `./x.ts` specifiers as written.

That class of defect recurred once more and is worth knowing about: a local
`node_modules/typescript` is gitignored, so a long-lived checkout can sit on an old tsc while
every fresh clone gets the current one. Measured on a fresh clone of this repo: `typecheck:
clean` under 5.9.3, and under 7.0.2 three `TS5090`s (a `paths` value must start with `./`) plus
`TS5102` (`baseUrl` was removed). The config is now valid under both, `typecheck.mjs` prints the
version it used so a green run is attributable, and `probe_install.ts` fails if either spelling
comes back.
