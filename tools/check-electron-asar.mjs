// Post-packaging guard: inspect the actual app.asar, not just electron-builder's inputs.
// Run after "cd desktop && npm install" and electron-builder on the Windows Actions runner.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'desktop');
const config = JSON.parse(readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const desktopRequire = createRequire(path.join(DESKTOP, 'package.json'));
const { listPackage } = desktopRequire('@electron/asar');

const archive = path.resolve(process.argv[2] || path.join(ROOT, 'build', 'desktop', 'win-unpacked', 'resources', 'app.asar'));
const present = new Set(listPackage(archive).map((name) => name.replaceAll('\\', '/').replace(/^\/+/, '')));
const expected = config.build.files.filter((name) => !name.startsWith('!') && !/[?*]/.test(name));
const missing = expected.filter((name) => !present.has(name));
if (missing.length) {
  console.error(`Electron app.asar 缺失必需文件：${missing.join(', ')} (${archive})`);
  process.exitCode = 1;
} else {
  console.log(`Electron app.asar 完整：${expected.join(', ')} (${archive})`);
}
