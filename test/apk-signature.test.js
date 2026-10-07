// tools/check-apk-signature.mjs is the reader that proves *after the fact* which key an APK was signed with —
// CI's `apksigner` gate says the build was fine, but the file a player actually downloaded may not be the file CI
// produced (mirror, truncation, or someone else's build claiming to be ours). The five published debug apks
// (c14/c17/c20/c21/c22) each carry a *different* `CN=Android Debug` certificate, which is exactly the bug that
// made players report 「与已安装应用签名不同(-7)」; see docs/ANDROID-SIGNING.md.
//
// These tests give the reader a positive control (a signing block built around the repo's own pinned certificate)
// and two negatives, because a scanner that silently returns "no certificate" is the failure mode this tool exists
// to avoid — an early version of it did exactly that: `x.validity.notAfter` (undefined on this Node) sat inside a
// bare `catch {}`, so five real apks read as unsigned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { apkSignerCerts } from '../tools/check-apk-signature.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DER = readFileSync(path.join(ROOT, 'test', 'fixtures', 'upload-signer-cert.der'));
const PIN = readFileSync(path.join(ROOT, 'mobile', 'android', 'upload-key-sha256.txt'), 'utf8').trim();

const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const MAGIC = Buffer.from('APK Sig Block 42', 'latin1');

/** A minimal "apk": some file data, an APK Signing Block, then an empty central directory + EOCD. */
function syntheticApk(pairs, dir) {
  const blockSize = pairs.length + 24; // pairs + trailing size field + magic
  const block = Buffer.concat([u64(blockSize), pairs, u64(blockSize), MAGIC]);
  const fileData = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(1234, 0x5a)]);
  const cdOffset = fileData.length + block.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt32LE(cdOffset, 16);
  const p = path.join(dir, `synthetic-${pairs.length}.apk`);
  writeFileSync(p, Buffer.concat([fileData, block, eocd]));
  return p;
}

test('the pinned certificate and the pinned fingerprint are the same key (fixture ↔ pin, no drift)', () => {
  const fingerprint = crypto.createHash('sha256').update(CERT_DER).digest('hex');
  assert.equal(fingerprint, PIN, 'test/fixtures/upload-signer-cert.der 必须就是 upload-key-sha256.txt 那张证书');
  // A certificate is public; a private key in here would be a supply-chain incident (docs/ANDROID-SIGNING.md §2).
  assert.ok(!CERT_DER.includes(Buffer.from('PRIVATE KEY')), '只能提交公钥证书，不能提交私钥/PKCS8');
});

test('the reader recovers the pinned certificate from a v2 signing block', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-apksig-'));
  // The real v2 pair wraps the DER in length prefixes and two levels of sequences; the reader does not depend on
  // that nesting (it sniffs), so this fixture uses the simplest wrapper that still contains a length prefix.
  const v2Data = Buffer.concat([u32(CERT_DER.length), CERT_DER]);
  const v2Pair = Buffer.concat([u64(4 + v2Data.length), u32(0x7109871a), v2Data]);
  // A non-signature pair (0x42726577 = the "Brewed" dependency-info pair AGP really writes) must not confuse the walk.
  const brewed = Buffer.from('x'.repeat(40));
  const brewedPair = Buffer.concat([u64(4 + brewed.length), u32(0x42726577), brewed]);
  const certs = apkSignerCerts(syntheticApk(Buffer.concat([v2Pair, brewedPair]), dir));
  assert.equal(certs.length, 1, `应当只读出一张证书，实得 ${certs.length}`);
  assert.equal(certs[0].scheme, 'v2');
  assert.equal(certs[0].fingerprint, PIN);
});

test('the reader refuses files that are not v2/v3-signed apks, loudly', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-apksig-neg-'));
  const notZip = path.join(dir, 'tar.gz');
  writeFileSync(notZip, Buffer.alloc(4096, 7));
  assert.throws(() => apkSignerCerts(notZip), /EOCD/, '不是 zip 要说"找不到 EOCD"，不能报"没有证书"');

  const v2Data = Buffer.concat([u32(CERT_DER.length), CERT_DER]);
  const pair = Buffer.concat([u64(4 + v2Data.length), u32(0xf05368c0), v2Data]); // v3
  const signed = syntheticApk(pair, dir);
  // Same file with the magic destroyed: this is the shape of a re-zipped / truncated artifact.
  const broken = path.join(dir, 'broken.apk');
  const buf = readFileSync(signed);
  buf.writeUInt32LE(0xdeadbeef, buf.length - 22 - 16);
  writeFileSync(broken, buf);
  assert.throws(() => apkSignerCerts(broken), /没有 APK Signing Block/, '签名块魔数被改要报错，不能静返回空');

  // And it must be a *reported* failure, not a silent [].
  assert.equal(apkSignerCerts(signed)[0].scheme, 'v3', 'v3 pair 也要认（release 包可能带 v2+v3）');
});

test('a different certificate reads as a different fingerprint (the check is discriminating)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-apksig-mut-'));
  const other = Buffer.from(CERT_DER);
  other[other.length - 20] ^= 0x01; // last bytes of the signature: still parses as a certificate, is not the same key
  const data = Buffer.concat([u32(other.length), other]);
  const pair = Buffer.concat([u64(4 + data.length), u32(0x7109871a), data]);
  const certs = apkSignerCerts(syntheticApk(pair, dir));
  assert.notEqual(certs[0].fingerprint, PIN, '改过内容的证书必须读到别的指纹，否则这个闸门是摆设');
});
