#!/usr/bin/env node
// Write Android's bundled EasyTier config from CI secrets without printing it.
// Deliberately never checked into Git; the native VpnService reads this asset.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLanConfig } from './fetch-lan-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'mobile/android/app/src/main/assets/lan-config.json');
const required = process.argv.includes('--require');
const result = buildLanConfig(process.env);
if (result.skip) {
  fs.rmSync(target, { force: true });
  if (required) {
    console.error('Android EasyTier: 缺少必要 SP_LAN_* 构建配置');
    process.exitCode = 1;
  } else {
    console.log('Android EasyTier: 未配置，禁用内置联机');
  }
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(result.config), { mode: 0o600 });
  console.log('Android EasyTier: 联机配置已写入 APK assets（不打印密钥）');
}
