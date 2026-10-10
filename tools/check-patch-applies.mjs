// Does patches/game-client.patch still apply to a given game tree?
//
// The client keeps its source-level hooks as a patch against the pristine upstream files (see
// tools/payload-patches.mjs), so the moment upstream rewrites one of those three files' context, packaging stops
// with "补丁打不上" — which is exactly what an automated release pipeline must not discover *after* it published.
// This is the cheap pre-flight: no npm install, no art copy, no packing — it applies the patch into a throwaway
// directory and runs the same assertPatched() the packer runs.
//
// Usage: node tools/check-patch-applies.mjs --game <gameRepoRoot> --out <scratchPayloadDir>
// Exit:  0 = applies and asserts clean; 3 = does not apply (message printed); 2 = the check itself couldn't run
//        (bad arguments / no such game tree) — reported as failure, never as a silent pass.

import fs from 'node:fs';
import path from 'node:path';
import { applyPayloadPatch, assertPatched, PATCHED_FILES } from './payload-patches.mjs';

function arg(name) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 2);
  }
  return '';
}

const gameRoot = arg('game');
const out = arg('out');
if (!gameRoot || !out) {
  console.error('用法：node tools/check-patch-applies.mjs --game <游戏仓根> --out <临时 payload 目录>');
  process.exit(2);
}
for (const rel of PATCHED_FILES) {
  if (!fs.existsSync(path.join(gameRoot, 'public', rel))) {
    console.error(`游戏树里没有 ${path.join('public', rel)} —— 这不是"补丁没问题"，这一跑什么都没检`);
    process.exit(2);
  }
}

fs.mkdirSync(out, { recursive: true });
try {
  const written = applyPayloadPatch({ gameRoot, payloadRoot: out });
  assertPatched(out);
  console.log(
    `✓ 补丁在这份游戏树上打得上：检 ${PATCHED_FILES.length} 个文件（${PATCHED_FILES.join(', ')}），` +
      `写出 ${written.length} 个`,
  );
} catch (e) {
  console.log(`✗ 补丁打不上：${(e && e.message) || e}`);
  console.log('  → 自动出包这一步就是会红的地方：先在这把上游那几行对回 patches/game-client.patch，再谈自动发布。');
  process.exit(3);
}
