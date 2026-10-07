// Read the signing certificate out of an APK **without an Android SDK**.
//
// Why this exists: whether an installed player can upgrade in place is decided by the APK's signing certificate,
// not by the version number — the c22 → 0.2.1 report was `INSTALL_FAILED_UPDATE_INCOMPATIBLE(-7)`「与已安装应用签名不同」
// because every CI runner had generated its own throwaway debug keystore (docs/ANDROID-SIGNING.md). CI proves each
// build with Google's `apksigner`; this is the *second* reader, for a file that is already published and already in
// someone's hands — a Release asset, a mirror copy, a phone's download folder. It needs only Node.
//
// It parses the APK Signing Block (the thing that carries scheme v2/v3 signatures) rather than the JAR signature,
// because AGP does not add a v1 signature when minSdk ≥ 24 — `unzip -l` on our own published apks shows META-INF
// holding only `.version` files and `app-metadata.properties`, and `keytool -printcert -jarfile` reads nothing.
//
//   node tools/check-apk-signature.mjs <apk> [<apk> …]
//   node tools/check-apk-signature.mjs --expect "$(cat mobile/android/upload-key-sha256.txt)" <apk>
//
// `--expect` exits 1 unless one of the signer certificates hashes to that value: the same check CI runs, against a
// file you downloaded yourself.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('APK Sig Block 42', 'latin1');
const EOCD_SIGNATURE = 0x06054b50;
/** Pair ids of the APK Signing Block (Android source, `_apksigner::Source::kApkSigningBlock`) */
const SCHEMES = new Map([[0x7109871a, 'v2'], [0xf05368c0, 'v3'], [0x1b2acec1, 'v3.1']]);

const u32 = (b, o) => b.readUInt32LE(o);
const u64 = (b, o) => Number(b.readBigUInt64LE(o));

/** Partial reads are the norm at EOF-adjacent offsets, so ask for exactly `len` and refuse less. */
function readAt(fd, len, pos) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  if (n !== len) throw new Error(`只读到 ${n}/${len} 字节（偏移 ${pos}）`);
  return b;
}

/**
 * Every distinct X.509 certificate inside the signing block, with the SHA-256 of its DER —
 * that hash is what `apksigner verify --print-certs` prints as "certificate SHA-256 digest".
 * @param {string} file
 * @returns {{scheme: string, fingerprint: string, subject: string, derLength: number}[]}
 */
export function apkSignerCerts(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557); // 64 KiB comment maximum + 22-byte EOCD
    const tail = readAt(fd, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === EOCD_SIGNATURE) { eocd = i; break; }
    if (eocd < 0) throw new Error(`${file}: 找不到 zip 的 EOCD —— 这不是 apk/zip`);
    const cdOffset = u32(tail, eocd + 16);
    if (cdOffset < 24) throw new Error(`${file}: 没有 APK Signing Block 的位置（cdOffset=${cdOffset}）`);

    // The block sits directly before the central directory: … [size_of_block:8][magic:16]
    const end = readAt(fd, 24, cdOffset - 24);
    if (!end.subarray(8, 24).equals(MAGIC)) {
      throw new Error(`${file}: 没有 APK Signing Block —— 这个包没做 v2/v3 签名（v1-only 请改用 keytool -printcert -jarfile）`);
    }
    const blockSize = u64(end, 0);
    // `size_of_block` counts everything after its own field, and is written again just before the magic.
    const blockStart = cdOffset - 8 - blockSize;
    if (blockStart < 0 || u64(readAt(fd, 8, blockStart), 0) !== blockSize) {
      throw new Error(`${file}: signing block 的头尾长度不一致（文件被改过？）`);
    }

    const pairs = readAt(fd, blockSize - 24, blockStart + 8);
    const found = [];
    for (let p = 0; p + 12 <= pairs.length;) {
      const pairSize = u64(pairs, p);
      if (pairSize < 4) break;
      const id = u32(pairs, p + 8);
      const scheme = SCHEMES.get(id);
      if (scheme) for (const c of sniffCertificates(pairs.subarray(p + 12, p + 8 + pairSize), scheme, found)) found.push(c);
      p += 8 + pairSize;
    }
    if (!found.length) throw new Error(`${file}: signing block 里没有 v2/v3 pair，或里面读不出证书`);
    return found;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Certificates inside a scheme block are DER, length-prefixed, nested two levels deep — the surrounding structure
 * differs between scheme versions, so instead of re-implementing ASN.1 we look for `30 82 <len:2>` and let OpenSSL
 * decide. A miss is only possible if a *different* cert is at that offset, and OpenSSL rejects those.
 *
 * ⚠️ The parse and the record-building are separated on purpose: an early version of this function put
 * `x.validity.notAfter` (undefined on the Node we ran it on) inside a bare `catch {}`, which swallowed a
 * **successful** parse and reported "no certificate" for five published apks. Only the parse may be guarded.
 */
function* sniffCertificates(buf, scheme, already) {
  const seen = new Set(already.map((c) => c.fingerprint));
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] !== 0x30 || buf[i + 1] !== 0x82) continue;
    const derLength = 4 + buf.readUInt16BE(i + 2);
    if (derLength > buf.length - i) continue;
    let x;
    try {
      x = new crypto.X509Certificate(buf.subarray(i, i + derLength));
    } catch {
      i += derLength - 1;
      continue;
    }
    const fingerprint = crypto.createHash('sha256').update(Buffer.from(x.raw)).digest('hex');
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      yield { scheme, fingerprint, subject: x.subject.replace(/\n/g, ' '), derLength };
    }
    i += derLength - 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const norm = (v) => String(v ?? '').replace(/[:\s]/g, '').toLowerCase();
  let expect = '';
  let sawExpect = false;
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === '--expect') { expect = norm(args[i + 1]); sawExpect = true; args.splice(i, 2); }
    else if (args[i].startsWith('--expect=')) { expect = norm(args[i].slice('--expect='.length)); sawExpect = true; args.splice(i, 1); }
  }
  if (!args.length) {
    console.error('用法: node tools/check-apk-signature.mjs [--expect <sha256>] <apk> …');
    process.exit(2);
  }
  if (sawExpect && !/^[0-9a-f]{64}$/.test(expect)) {
    console.error(`--expect 得是 64 位十六进制指纹，实为 "${expect}"`);
    process.exit(2);
  }
  let bad = 0;
  for (const f of args) {
    try {
      const certs = apkSignerCerts(f);
      const hit = !expect || certs.some((c) => c.fingerprint === expect);
      if (!hit) bad++;
      console.log(`${f}\n  ${certs.map((c) => `${c.scheme} ${c.fingerprint}  (DN: ${c.subject})`).join('\n  ')}`
        + (expect ? `\n  ${hit ? 'MATCH' : 'MISMATCH'} 期望 ${expect}` : ''));
    } catch (e) {
      bad++;
      console.log(`${f}\n  读取失败: ${e.message}`);
    }
  }
  process.exit(bad ? 1 : 0);
}
