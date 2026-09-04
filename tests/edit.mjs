/**
 * A replace that CANNOT silently do nothing.
 *
 * Five false claims reached commit messages in this repo's history because a scripted
 * `str.replace()` whose target had the wrong indentation returned the input unchanged, the
 * typecheck stayed clean over the unchanged code, the suite stayed green, and nothing said
 * a word. "The edit applied" was assumed from "the command exited 0".
 *
 * So this exits non-zero on a miss, and on an ambiguous hit, and prints what it changed.
 * It is a development tool, not part of the extension.
 *
 *   node tests/edit.mjs <file> <<'EOF'
 *   ---FIND---
 *   exact text
 *   ---REPLACE---
 *   new text
 *   EOF
 *
 * Multiple FIND/REPLACE pairs in one invocation are applied in order, each asserted.
 * FIND is matched with leading whitespace SIGNIFICANT, because that is the thing that
 * kept going wrong; use --loose-indent to match a unique line by its trimmed content
 * and re-indent the replacement to whatever the file actually uses.
 */
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const looseIndent = args.includes("--loose-indent");
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: node tests/edit.mjs <file> [--loose-indent] < spec");
  process.exit(2);
}

const spec = readFileSync(0, "utf8");
const pairs = [];
for (const chunk of spec.split("---FIND---").slice(1)) {
  const i = chunk.indexOf("---REPLACE---");
  if (i < 0) {
    console.error("每个 ---FIND--- 必须跟一个 ---REPLACE---");
    process.exit(2);
  }
  // Strip exactly one leading and one trailing newline around each side, so the heredoc
  // reads naturally without the newlines becoming part of the match.
  const trim1 = (s) => s.replace(/^\n/, "").replace(/\n$/, "");
  pairs.push({ find: trim1(chunk.slice(0, i)), replace: trim1(chunk.slice(i + "---REPLACE---".length)) });
}
if (pairs.length === 0) {
  console.error("no ---FIND---/---REPLACE--- pair in the spec");
  process.exit(2);
}

let text = readFileSync(file, "utf8");
let n = 0;
for (const { find, replace } of pairs) {
  n += 1;
  if (looseIndent) {
    // One-line loose mode: locate the unique line whose trimmed content matches, then apply the
    // file's own indentation to every line of the replacement.
    const want = find.trim();
    const lines = text.split("\n");
    const hits = lines.map((l, k) => [k, l]).filter(([, l]) => l.trim() === want);
    if (hits.length === 0) {
      console.error(`pair ${n}: NO LINE with trimmed content:\n  ${want}`);
      process.exit(1);
    }
    if (hits.length > 1) {
      console.error(`pair ${n}: ${hits.length} lines match (ambiguous): ${hits.map(([k]) => k + 1).join(", ")}`);
      process.exit(1);
    }
    const [k, line] = hits[0];
    const indent = line.slice(0, line.length - line.trimStart().length);
    const body = replace === "" ? [] : replace.split("\n").map((l) => (l.trim() === "" ? "" : indent + l.trim()));
    lines.splice(k, 1, ...body);
    text = lines.join("\n");
    console.log(`pair ${n}: line ${k + 1} -> ${body.length} line(s), indent ${indent.length}sp`);
    continue;
  }
  const count = text.split(find).length - 1;
  if (count === 0) {
    console.error(`pair ${n}: FIND matched NOTHING in ${file}. First line of the target was:\n  ${JSON.stringify(find.split("\n")[0])}`);
    process.exit(1);
  }
  if (count > 1) {
    console.error(`pair ${n}: FIND matched ${count} times — refusing an ambiguous edit. Add context.`);
    process.exit(1);
  }
  text = text.replace(find, replace);
  console.log(`pair ${n}: 1 hit, ${find.split("\n").length} line(s) -> ${replace === "" ? 0 : replace.split("\n").length}`);
}

writeFileSync(file, text, "utf8");
console.log(`edit.mjs: ${file} — ${pairs.length} edit(s) applied and verified`);
