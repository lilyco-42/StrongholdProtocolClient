// The payload is lowered to what Safari 15 / iOS 15 can parse (tools/safari15-syntax.mjs). The failure this prevents
// is silent — an ES2022 class static block makes `import('/vendor/three.module.js')` reject, and
// public/js/render/board3d/load.js turns a rejection into its 2D fallback — so the rewrite is pinned here rather than
// trusted: the shape it accepts, the shape it refuses (fail-closed), and that the flag really is set at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { lowerClassStaticBlocks } from '../tools/safari15-syntax.mjs';

/** The exact formatting three.js emits: tab-indented, JSDoc inside the block. */
const THREE_SHAPE = [
  'class Vector2 {',
  '',
  '\tstatic {',
  '',
  '\t\t/**',
  '\t\t * This flag can be used for type testing.',
  '\t\t *',
  '\t\t * @type {boolean}',
  '\t\t * @readonly',
  '\t\t * @default true',
  '\t\t */',
  '\t\tVector2.prototype.isVector2 = true;',
  '',
  '\t}',
  '',
  '\tconstructor(x = 0) { this.x = x; }',
  '',
  '}',
  '',
  'class Quaternion { constructor() {} }',
  '',
  'export { Vector2, Quaternion };',
  '',
].join('\n');

const staticBlocks = (src) => src.match(/\bstatic\s*\{/g) || [];

test('the three.js shape moves out of the class body and nothing else changes', () => {
  const out = lowerClassStaticBlocks(THREE_SHAPE);
  assert.equal(staticBlocks(out).length, 0, 'no class static block may survive — it is the ES2022 syntax iOS 15 lacks');
  assert.equal((out.match(/Vector2\.prototype\.isVector2 = true;/g) || []).length, 1, 'the flag assignment itself is kept');
  // it must land *outside* the class body: before ES2022 a class body cannot hold statements at all
  assert.ok(out.indexOf('Vector2.prototype.isVector2 = true;') > out.indexOf('constructor(x = 0)'),
    'the assignment goes after the class, not back inside it');
  // and the rest of the module is untouched
  assert.ok(out.includes('class Quaternion { constructor() {} }'));
  assert.ok(out.includes('export { Vector2, Quaternion };'));
  assert.equal(out.includes('This flag can be used for type testing'), false, 'the block (JSDoc included) is gone');
});

test('the flag is really on the prototype once the module has been evaluated', async () => {
  // The claim being pinned is about *when* the assignment runs, so it is checked by running it, not by reading it.
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-safari15-'));
  try {
    const file = path.join(dir, 'm.mjs');
    writeFileSync(file, lowerClassStaticBlocks(THREE_SHAPE));
    const mod = await import(pathToFileURL(file).href);
    assert.equal(mod.Vector2.prototype.isVector2, true);
    assert.equal(new mod.Vector2(3).x, 3, 'the rest of the class still works');
    assert.equal(mod.Quaternion.prototype.isVector2, undefined, 'only the flagged class is touched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a module without a class static block comes back byte-identical', () => {
  for (const src of [
    'export const a = 1;\n',
    'class A { static make() { return new A(); } static get x() { return 1; } }\nexport { A };\n',
    'const s = "static {";\n// static {\nexport { s };\n',
    'class A {\n\tm() { return `x${ { a: 1 } }`; }\n}\nexport { A };\n',
  ]) {
    assert.equal(lowerClassStaticBlocks(src), src, `must be a no-op:\n${src}`);
  }
});

test('running it twice changes nothing (it is applied to every vendored module)', () => {
  const once = lowerClassStaticBlocks(THREE_SHAPE);
  assert.equal(lowerClassStaticBlocks(once), once);
});

test('a static block that is not a plain prototype flag throws instead of emitting something unknown', () => {
  // Fail closed: this module knows exactly one shape. Anything else has to be looked at by a human, because silently
  // dropping or mis-placing a statement would break the 3D board on *every* platform instead of just old iOS.
  const cases = {
    'a call': 'class A {\n\n\tstatic {\n\n\t\tregister(A);\n\n\t}\n\n}\nexport { A };\n',
    'this-based': 'class A {\n\n\tstatic {\n\n\t\tthis.prototype.isA = true;\n\n\t}\n\n}\nexport { A };\n',
    'a block that is never closed': 'class A {\n\n\tstatic {\n\n\t\tA.prototype.isA = true;\n\n}\nexport { A };\n',
    'an empty block': 'class A {\n\n\tstatic {\n\n\t}\n\n}\nexport { A };\n',
  };
  for (const [what, src] of Object.entries(cases)) {
    assert.throws(() => lowerClassStaticBlocks(src), /safari15-syntax/, `${what} must throw`);
  }
});

test('the brace scan survives strings, template literals and comments inside the class body', () => {
  // A stray `}` in a string must not be mistaken for the end of the class, or the assignment lands inside the body.
  const src = [
    'class A {',
    '',
    '\tstatic {',
    '',
    '\t\tA.prototype.isA = true;',
    '',
    '\t}',
    '',
    '\tm() { return "}"; }',
    '\tn() { return `x${ { a: 1 } }`; }',
    '\t// }',
    '\to() { /* } */ return 1; }',
    '',
    '}',
    '',
    'export { A };',
    '',
  ].join('\n');
  const out = lowerClassStaticBlocks(src);
  assert.equal(staticBlocks(out).length, 0);
  assert.ok(out.indexOf('A.prototype.isA = true;') > out.indexOf('o() {'), 'the assignment is after the whole class body');
  assert.ok(out.includes('m() { return "}"; }'), 'the class body is left intact');
});

test('a `}` line that is not the end of the class throws instead of mis-placing the assignment', () => {
  // A template literal holding a column-0 `}` is exactly the shape that would be mistaken for the class end. Getting
  // it wrong would put a statement inside a class body — a syntax error on every platform, not just old iOS.
  const src = [
    'class A {',
    '',
    '\tstatic {',
    '',
    '\t\tA.prototype.isA = true;',
    '',
    '\t}',
    '',
    '\tm() {',
    '\t\treturn `',
    '}',
    '`;',
    '\t}',
    '',
    '}',
    '',
    'export { A };',
    '',
  ].join('\n');
  assert.throws(() => lowerClassStaticBlocks(src), /safari15-syntax/, 'must not guess');
});

test('two flagged classes in one module each get their own hoisted line', () => {
  const src = [
    'class A {',
    '',
    '\tstatic {',
    '',
    '\t\tA.prototype.isA = true;',
    '',
    '\t}',
    '',
    '\ta() {}',
    '',
    '}',
    '',
    'class B {',
    '',
    '\tstatic {',
    '',
    '\t\tB.prototype.isB = true;',
    '',
    '\t}',
    '',
    '\tb() {}',
    '',
    '}',
    '',
    'export { A, B };',
    '',
  ].join('\n');
  const out = lowerClassStaticBlocks(src);
  assert.equal(staticBlocks(out).length, 0);
  assert.ok(out.indexOf('A.prototype.isA = true;') > out.indexOf('a() {}'));
  assert.ok(out.indexOf('A.prototype.isA = true;') < out.indexOf('class B'));
  assert.ok(out.indexOf('B.prototype.isB = true;') > out.indexOf('b() {}'));
  assert.ok(out.indexOf('B.prototype.isB = true;') < out.indexOf('export { A, B };'));
});
