// Lowers a vendored ES module to what Safari 15 / iOS 15 can parse.
//
// Why this exists — the 3D board never appeared on iOS 15.x–16.3:
//
//   three.js (the official 3D board, DESIGN §15) tags its type-test flags with **class static blocks**:
//
//       class Vector2 { static { Vector2.prototype.isVector2 = true; } … }
//
//   A class static block is ES2022 and Safari only learned it in **16.4** (WebKit «Features in Safari 16.4»).
//   The packaged app declares iOS 15.0 (mobile/ios … `IPHONEOS_DEPLOYMENT_TARGET = 15.0`), so on iOS 15.0–16.3 the
//   dynamic `import('/vendor/three.module.js')` in public/js/render/board3d/load.js **rejects with a SyntaxError** —
//   and that file turns any rejection into `null`, its documented "no three → 2D board" path. The 3D board is then
//   never built, silently: no exception reaches the console, `?board=3d` changes nothing, the player just sees the 2D
//   board. three.core.js is the only file in the payload above ES2021.
//
// The rewrite moves those assignments to just after the class declaration they belong to. Nothing about *when* they run
// changes — a class static block runs while the class is defined, and the statements being moved are plain prototype
// assignments. They cannot simply stay put: before ES2022 a class body may hold no statements at all.
//
// How it finds the blocks: **by line**, not by tokenising. The file is a rollup build, so a static block is always
//     <indent>static {
//     …
//     <indent>}
// and a class body always ends on a `}` line of its own. Tokenising instead would mean handling regular-expression
// literals, and three.core.js has regexes with quotes in them (`line 45238` — a `"` inside a regex derails a naive
// string scanner for the next 32 000 characters). Every assumption above is asserted rather than assumed: anything
// unexpected throws, so a three.js that reformats or adds a different kind of static block fails the build loudly
// instead of shipping a payload that is broken on every platform.

/** A line that is nothing but a class static block opener. */
const BLOCK_LINE = /^([ \t]*)static[ \t]*\{[ \t]*\r?$/;

/**
 * `Name.prototype.prop = <literal>;` — the only statement shape this rewrite accepts.
 *
 * The receiver has to be a module-scope binding, because the statement is moved to module top level: `this` (which
 * inside a static block *is* the class) is therefore refused rather than hoisted into a ReferenceError.
 */
const FLAG_STATEMENT = /^(?!this\b|super\b|arguments\b)([A-Za-z_$][\w$]*)\.prototype\.([A-Za-z_$][\w$]*)\s*=\s*(true|false|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")\s*;$/;

/** What may follow a class body. Anything else means the `}` line was not the end of one. */
const AFTER_CLASS = /^(class\b|\/\*|function\b|export\b|const\b|let\b|var\b|if\b|for\b|import\b|async\b)/;

/** Offsets each line starts at, so line text can be read without splitting (and without losing the last empty line). */
function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

/** Every `Name.prototype.prop = <literal>;` in a static block body (comments and blank lines are ignored). */
function readFlagStatements(body, line) {
  const bare = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const statements = bare.split(';').map((s) => s.trim()).filter(Boolean).map((s) => `${s};`);
  if (!statements.length) throw new Error(`safari15-syntax: the static block on line ${line} holds no statement`);
  for (const s of statements) {
    if (!FLAG_STATEMENT.test(s)) {
      throw new Error(
        `safari15-syntax: the static block on line ${line} is not a plain prototype flag (${JSON.stringify(s.slice(0, 80))}). `
        + 'This rewrite only knows the three.js shape `Name.prototype.prop = <literal>;` — lower the new shape by hand '
        + 'and teach this module about it.',
      );
    }
  }
  return statements;
}

/**
 * Rewrite every class static block whose body is a plain prototype flag into the same assignment placed after the
 * class. Returns the input unchanged when there is nothing to do, so it is safe to run over every vendored module.
 * @param {string} src
 * @returns {string}
 */
export function lowerClassStaticBlocks(src) {
  const starts = lineStarts(src);
  const line = (n) => src.slice(starts[n], n + 1 < starts.length ? starts[n + 1] - 1 : src.length).replace(/\r$/, '');
  const edits = [];

  for (let n = 0; n < starts.length; n++) {
    const m = BLOCK_LINE.exec(line(n));
    if (!m) continue;
    const indent = m[1];
    let close = -1;
    for (let k = n + 1; k < starts.length; k++) if (line(k) === `${indent}}`) { close = k; break; }
    if (close < 0) throw new Error(`safari15-syntax: the static block on line ${n + 1} has no closing \`${indent}}\` line`);
    const statements = readFlagStatements(
      Array.from({ length: close - n - 1 }, (_, i) => line(n + 1 + i)).join('\n'), n + 1);

    let classEnd = -1;
    for (let k = close + 1; k < starts.length; k++) if (line(k) === '}') { classEnd = k; break; }
    if (classEnd < 0) throw new Error(`safari15-syntax: no \`}\` line after the static block on line ${n + 1}`);
    // Assert the `}` line really did end the class body: what follows must be a blank line and then a top-level
    // construct. A template literal holding a line that is exactly `}` would otherwise be taken for the class end.
    let next = classEnd + 1;
    while (next < starts.length && line(next).trim() === '') next++;
    if (next < starts.length && !AFTER_CLASS.test(line(next))) {
      throw new Error(`safari15-syntax: line ${classEnd + 1} is not the end of a class body — line ${next + 1} is `
        + `${JSON.stringify(line(next).slice(0, 60))}`);
    }
    edits.push({ from: n, to: close, after: classEnd, statements });
  }
  if (!edits.length) return src;

  const drop = new Set();
  const insertAfter = new Map();
  for (const e of edits) {
    for (let k = e.from; k <= e.to; k++) drop.add(k);
    insertAfter.set(e.after, e.statements);
  }
  const out = [];
  for (let n = 0; n < starts.length; n++) {
    if (!drop.has(n)) out.push(line(n));
    const ins = insertAfter.get(n);
    if (ins) out.push(...ins);
  }
  return out.join('\n');
}
