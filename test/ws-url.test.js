// `tools/ws-url.mjs` claims to be a copy of what `patches/game-client.patch` adds to the game's `js/net.js`. A
// claim like that is only worth anything if something checks it, because this function is the key the picker
// deduplicates servers on: if the tool's copy and the shipped copy disagree, `tools/probe-community-servers.mjs`
// ranks a different set of "same server" entries than the player's own picker sees, and a seed can land as a
// duplicate or as a dead entry.
//
// So: extract the patch's added lines, compare each function as text, then run BOTH implementations over one
// corpus. The corpus is not decoration — a paraphrase of this file did drift, on IPv6 `[::1]` without a port, and
// only the behaviour diff shows what that changes for a player.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toWsUrl, isLocalAuthority, authorityPort } from '../tools/ws-url.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATCH = fs.readFileSync(path.join(ROOT, 'patches/game-client.patch'), 'utf8').split(/\r?\n/);
const TOOL = fs.readFileSync(path.join(ROOT, 'tools/ws-url.mjs'), 'utf8');

/** The `+` lines of the hunk that introduces `toWsUrl`, with the leading `+` removed. */
function patchAddedLines(marker) {
  const hit = PATCH.findIndex((l) => l.startsWith(`+${marker}`));
  assert.notEqual(hit, -1, `补丁里找不到 ${marker} —— 补丁被重排过，这个测试需要跟着改`);
  let from = hit;
  for (; from >= 0; from -= 1) if (/^@@/.test(PATCH[from])) break;
  let to = hit;
  for (; to < PATCH.length; to += 1) if (to > from && /^(@@|diff --git)/.test(PATCH[to])) break;
  const added = PATCH.slice(from + 1, to).filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
  // The hunk's added run can begin mid-JSDoc, because the opening `/**` was a context line.
  if (added[0] && /^ \* /.test(added[0])) added.unshift('/**');
  while (added.length && !added[added.length - 1].trim().endsWith('}')) added.pop();
  return added.join('\n');
}

/** Source of one function, from its `function name(` line to its matching closing brace. */
function functionSource(src, name) {
  const at = src.search(new RegExp(`^(?:export )?function ${name}\\b`, 'm'));
  if (at < 0) return null;
  let depth = 0;
  let seen = false;
  for (let i = src.indexOf('{', at); i < src.length; i += 1) {
    if (src[i] === '{') { depth += 1; seen = true; } else if (src[i] === '}') { depth -= 1; }
    if (seen && depth === 0) return src.slice(at, i + 1).replace(/^export /, '');
  }
  return null;
}

const NAMES = ['isLocalAuthority', 'authorityPort', 'toWsUrl'];
const patchSrc = patchAddedLines('export function toWsUrl');

test('tools/ws-url.mjs 的三个函数与补丁新增的行逐字一致（只允许 export 关键字之差）', () => {
  for (const name of NAMES) {
    const mine = functionSource(TOOL, name);
    const theirs = functionSource(patchSrc, name);
    assert.ok(mine, `tools/ws-url.mjs 里没有 ${name}`);
    assert.ok(theirs, `补丁里没有 ${name}`);
    assert.equal(mine, theirs, `${name} 与补丁里的版本不一致 —— 这是播种条目的去重键，两边必须同一份代码`);
  }
});

test('两份实现跑同一批输入，结果逐条相等', async () => {
  const mod = await import(`data:text/javascript,${encodeURIComponent(patchSrc)}`);
  const cases = [
    'game.starst.site', '192.168.1.9:3000', '10.0.0.5', '172.16.0.1', '172.32.0.1', 'localhost', 'LOCALHOST:3000',
    'https://x.io', 'http://x.io:3000/', 'ws://x.io:3000/game/ws', 'wss://host/play', 'host:443',
    '[::1]', '[::1]:3000', '[fd00::1]', 'sp.lain42.top', 'wei.linxia.dev/', 'https://game.misyra.com/play',
    'http://183.66.27.19:20522/', 'https://sk.cranepaul.dpdns.org:8443/',
  ];
  for (const c of cases) {
    assert.equal(toWsUrl(c), mod.toWsUrl(c), `${JSON.stringify(c)}：工具说 ${toWsUrl(c)}，补丁说 ${mod.toWsUrl(c)}`);
  }
  // 逐字一致之外再钉住几个具体答案：改动这段代码时，光看两份拷贝互相同意是不够的。
  assert.equal(toWsUrl('game.starst.site'), 'wss://game.starst.site/ws');
  assert.equal(toWsUrl('192.168.1.9:3000'), 'ws://192.168.1.9:3000/ws');
  assert.equal(toWsUrl('https://game.misyra.com/play'), 'wss://game.misyra.com/play/ws', '子路径要保留：服务器挂在 /play 下');
  assert.equal(toWsUrl('[::1]'), 'ws://[::1]/ws', 'IPv6 环回不带端口也是 ws');
  assert.equal(toWsUrl('host:443'), 'wss://host:443/ws');
});

test('同一条服务器的四种写法归一成同一个键（播种去重靠这个）', () => {
  const key = toWsUrl('https://wei.linxia.dev/');
  for (const written of ['wei.linxia.dev', 'https://wei.linxia.dev', 'https://wei.linxia.dev/', 'wss://wei.linxia.dev/ws']) {
    assert.equal(toWsUrl(written), key, `${written} 应该和 ${key} 撞在一起`);
  }
});

test('isLocalAuthority / authorityPort 的边界：只有环回与私网算本地，公网 host:port 仍然走 ws 猜测', () => {
  assert.equal(isLocalAuthority('localhost'), true);
  assert.equal(isLocalAuthority('LOCALHOST:3000'), true);
  assert.equal(isLocalAuthority('::1'), false, '补丁只认带方括号的 [::1]；裸 ::1 不是合法的 URL authority，这里钉住现状，别在拷贝里单方面"修好"');
  assert.equal(isLocalAuthority('127.0.0.1'), true);
  assert.equal(isLocalAuthority('192.168.1.9'), true);
  assert.equal(isLocalAuthority('172.31.0.1'), true);
  assert.equal(isLocalAuthority('172.32.0.1'), false);
  assert.equal(isLocalAuthority('8.153.102.122'), false);
  assert.equal(authorityPort('host'), '');
  assert.equal(authorityPort('host:3000'), '3000');
  assert.equal(authorityPort('[::1]:3000'), '3000');
  assert.equal(authorityPort('[::1]'), '');
});
