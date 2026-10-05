#!/usr/bin/env node
// 第五道闸门：payload 的**出处**。
//
// 为什么要有它（2026-10-05 实测到的现状）：`build-clients.yml` 的默认 payload_url 指向 OSS 上那份
// `sp-client-payload.tar.gz`，用 Range 读它内嵌的 `build.json` 得到 `describe:"v0.1.3-dirty"` ——
// 也就是这份产物是从**未提交的工作树**打出来的。版本号闸门（`expect_app`）与离线闸门都会放行它，
// 于是 CI 会绿着发一个没人能追到 commit 的 exe/apk。游戏侧本来就没有 CI 兜底，出处一旦断了就彻底接不上。
//
// 判据两条，都是"能不能复现"而不是"好不好看"：
//   1) `game.dirty` 必须是 false —— 打包时那棵树必须干净；
//   2) `game.describe` 必须带 `-g<7+ 位 hex>` 后缀 —— `git describe` 落在 tag 上时没有这段，
//      那种 payload 只能说出"是 0.1.3 时代的"，说不出是哪个 commit。
// 打印 app/server/describe 是为了日志里能一眼对回 `gh api … /releases/tags/…` 与线上 `/healthz.app`。
//
// 用法： node tools/check-payload-provenance.mjs <wwwDir>   （目录里有 build.json）
//       node tools/check-payload-provenance.mjs <wwwDir> --expect-app 0.1.3
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DIR_RE = /-g[0-9a-f]{7,}$/;

export function checkProvenance(doc, expectApp = null) {
  const problems = [];
  const g = (doc && doc.game) || {};
  if (expectApp && g.app !== expectApp) problems.push(`game.app=${JSON.stringify(g.app)}，要求 ${expectApp}`);
  if (g.dirty !== false) problems.push(`game.dirty=${JSON.stringify(g.dirty)} —— 打包用的树不干净，这份产物复现不出来`);
  if (typeof g.describe !== 'string' || !g.describe) problems.push('game.describe 缺失或为空');
  else if (!DIR_RE.test(g.describe)) problems.push(`game.describe="${g.describe}" 没有 -g<sha> 后缀 —— 追不到具体 commit`);
  return { ok: problems.length === 0, problems, app: g.app, server: doc && doc.server, describe: g.describe, dirty: g.dirty };
}

export function main(argv) {
  const dir = argv[0];
  if (!dir) { console.error('用法：node tools/check-payload-provenance.mjs <wwwDir> [--expect-app 0.1.3]'); return 2; }
  const i = argv.indexOf('--expect-app');
  const expectApp = i > -1 ? argv[i + 1] : null;
  let doc;
  try {
    doc = JSON.parse(readFileSync(path.join(dir, 'build.json'), 'utf8'));
  } catch (e) {
    console.error(`读不到 ${path.join(dir, 'build.json')}：${e.message}`);
    return 1;
  }
  const r = checkProvenance(doc, expectApp);
  console.log(`payload 出处：app=${r.app} server=${r.server} describe=${JSON.stringify(r.describe)} dirty=${JSON.stringify(r.dirty)}`);
  if (!r.ok) {
    for (const p of r.problems) console.error(`  ✗ ${p}`);
    console.error('结论：这份 payload 不许出厂。在干净的提交上重打（或换一个 describe 带 -g<sha> 的 payload）。');
    return 1;
  }
  console.log('  ✓ 树是干净的，describe 能追到 commit');
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main(process.argv.slice(2));
}
