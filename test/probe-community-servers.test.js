// The probe's own contract, tested against a WebSocket *server* written here from RFC 6455 rather than against the
// probe's client code. That distinction is the point: on 2026-10-08 a `rid: 'probe1'` string made every healthy
// server answer `BAD_MSG`, and the run reported ten of ten dead. No shared constant between the frame builder and
// the assertion would have caught it; a second implementation of the transport does, because the fake server can
// answer exactly like `server/net.js` does.
//
// The frame rules are transcribed from the game repo with their sources, so a future edit here is a deliberate act:
//   shared/protocol.js:435  — `if (msg.rid != null && !isInt(msg.rid, 0, 2 ** 31)) return 'bad rid'`
//   shared/protocol.js:334  — hello needs `name` non-blank and `isStr(name, NAME_MAX_LEN)`
//   shared/constants.js:22  — `NAME_MAX_LEN = 12`
//   server/net.js:328       — `errorMsg()` puts the reason in `detail`, the machine code in `code`

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import {
  NAME_MAX_LEN, PROTOCOL_VERSION, FAKE_IP,
  helloFrame, describeFrame, probe, summarize, parseArgv, resolvedIp,
} from '../tools/probe-community-servers.mjs';
import { COMMUNITY_SERVERS } from '../shell/picker-core.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Client→server frames are masked (RFC 6455 §5.1); server→client frames are not. */
function decodeFrame(buf) {
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let p = 2;
  if (len === 126) { len = buf.readUInt16BE(p); p += 2; } else if (len === 127) { len = Number(buf.readBigUInt64BE(p)); p += 8; }
  const key = masked ? buf.subarray(p, p + 4) : null;
  if (masked) p += 4;
  const payload = Buffer.from(buf.subarray(p, p + len));
  if (key) for (let i = 0; i < payload.length; i += 1) payload[i] ^= key[i % 4];
  return { opcode: buf[0] & 0x0f, payload };
}

function encodeFrame(opcode, payload) {
  const body = Buffer.from(payload);
  if (body.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  if (body.length < 65536) {
    const head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(body.length, 2);
    return Buffer.concat([head, body]);
  }
  const head = Buffer.alloc(10);
  head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([head, body]);
}

/**
 * @param {(hello: any, socket: net.Socket) => void} onHello — replies by writing frames, or does nothing to stand
 *   in for a server that handshakes and then stays silent (which is what a reverse proxy looks like).
 */
function startWsServer(onHello) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  // `upgrade` hands us the socket, so the server no longer tracks it — closing the listener would otherwise wait
  // for a WebSocket that the probe has already half-shut down. Keep the list and destroy it on close.
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n`
      + 'Connection: Upgrade\r\n\r\n');
    socket.once('data', (buf) => {
      const { opcode, payload } = decodeFrame(buf);
      if (opcode === 8) { socket.end(encodeFrame(8, '')); socket.destroy(); return; }
      let hello = null;
      try { hello = JSON.parse(payload.toString('utf8')); } catch { hello = { parseFailed: true, raw: payload.toString('utf8') }; }
      onHello(hello, socket);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      address: `http://127.0.0.1:${server.address().port}/`,
      close: async () => {
        for (const s of sockets) { s.removeAllListeners('data'); s.destroy(); }
        sockets.clear();
        await new Promise((done) => server.close(done));
      },
    }));
  });
}

const reply = (socket, obj) => socket.write(encodeFrame(1, JSON.stringify(obj)));

test('helloFrame 的 rid 必须是整数，这正是 2026-10-08 把十台健康服务器读成死亡的那个 bug', () => {
  const frame = helloFrame({});
  assert.equal(frame.t, 'hello');
  assert.equal(typeof frame.rid, 'number');
  assert.ok(Number.isInteger(frame.rid), `rid 必须是整数，收到 ${typeof frame.rid}`);
  assert.equal(frame.version, PROTOCOL_VERSION);
  assert.throws(() => helloFrame({ rid: 'probe1' }), /整数/);
  assert.throws(() => helloFrame({ rid: 1.5 }), /整数/);
});

test('helloFrame 的 name 受 NAME_MAX_LEN 约束，且与游戏仓 constants.js:22 的 12 一致', () => {
  assert.equal(NAME_MAX_LEN, 12);
  assert.equal(helloFrame({}).name.length <= NAME_MAX_LEN, true);
  assert.throws(() => helloFrame({ name: '这个探针名字长得超过十二个字符限制' }), /NAME_MAX_LEN/);
  assert.throws(() => helloFrame({ name: '   ' }), /不能为空/);
  // 9 个汉字的默认名要留有余量：`validateC2S` 用的是 `v.length`，中日韩一个假名就是一个字符，不是 3 个字节。
  assert.equal(helloFrame({}).name.length, 2);
});

test('describeFrame 把 error 帧的 detail 带出来（只读 code 会把探针 bug 读成对方宕机）', () => {
  assert.equal(describeFrame({ t: 'error', code: 'BAD_MSG', msg: '消息格式错误', detail: 'bad rid' }), 'error BAD_MSG · bad rid');
  assert.equal(describeFrame({ t: 'error', code: 'INTERNAL', detail: 'server full' }), 'error INTERNAL · server full');
  assert.equal(describeFrame({ t: 'ok', rid: 1 }), 'ok');
  assert.equal(describeFrame('not json'), 'not json');
});

test('阳性对照：服务器按协议回 welcome 时，探针必须报 welcome 并带上 app', async () => {
  let received = null;
  const srv = await startWsServer((hello, socket) => {
    received = hello;
    reply(socket, { t: 'welcome', playerId: 'p1', token: 'tk', name: hello.name, app: '0.2.1', version: PROTOCOL_VERSION, resumed: false });
  });
  try {
    const r = await probe({ address: srv.address }, { timeoutMs: 5000, diagnose: false });
    assert.equal(r.verdict, 'welcome');
    assert.equal(r.app, '0.2.1');
    // 这一步才是"探针是否 load-bearing"的证据：服务器收到的帧本身必须通过 validateC2S 的三条规则。
    assert.equal(received.t, 'hello');
    assert.ok(Number.isInteger(received.rid));
    assert.ok(typeof received.name === 'string' && received.name.length <= NAME_MAX_LEN && received.name.trim());
  } finally { await srv.close(); }
});

test('阴性对照：服务器回 BAD_MSG 时，verdict 与 detail 都要能看出是被拒而不是连不上', async () => {
  const srv = await startWsServer((hello, socket) => {
    reply(socket, { t: 'error', code: 'BAD_MSG', msg: '消息格式错误', detail: `bad rid (${typeof hello.rid})` });
  });
  try {
    const r = await probe({ address: srv.address }, { timeoutMs: 5000, diagnose: false, frame: { t: 'hello', rid: 'probe1', name: '探针', version: 1 } });
    assert.equal(r.verdict, 'hello 被拒');
    assert.match(r.detail, /BAD_MSG/);
    assert.match(r.detail, /bad rid \(string\)/, 'detail 是唯一的诊断信息，丢掉它等于丢掉答案');
  } finally { await srv.close(); }
});

test('对照用的必须是"探针能失败"的分支：只握手不回帧 ⇒ 超时，而不是 welcome', async () => {
  const srv = await startWsServer(() => { /* 反向代理的样子：101 之后一声不吭 */ });
  try {
    const r = await probe({ address: srv.address }, { timeoutMs: 400, diagnose: false });
    assert.equal(r.verdict, '只握手不回 welcome');
    assert.equal(r.app, '');
  } finally { await srv.close(); }
});

test('端口没人听 ⇒ 连不上，而且 TCP 那一列要给出原因（WebSocket error 事件不带原因）', async () => {
  // 先占一个端口再关掉，确保这是一个"曾经可查"的端口号而不是碰巧的 1。
  const srv = await startWsServer((hello, socket) => reply(socket, { t: 'welcome' }));
  const port = srv.port;
  await srv.close();
  const r = await probe({ address: `http://127.0.0.1:${port}/` }, { timeoutMs: 3000 });
  assert.equal(r.verdict, '连不上');
  assert.match(r.tcp, /ECONNREFUSED/, `TCP 列应解释失败原因，实际「${r.tcp}」`);
});

test('坏地址与 app 字段缺失都要分开记账：没有 app 是旧服务器，不是死服务器', async () => {
  const srv = await startWsServer((hello, socket) => {
    reply(socket, { t: 'welcome', playerId: 'p2', token: 'tk', name: hello.name, resumed: false });
  });
  try {
    const r = await probe({ address: srv.address }, { timeoutMs: 5000, diagnose: false });
    assert.equal(r.verdict, 'welcome');
    assert.equal(r.app, '(不带 app 字段)', '2026-10-08 实测：线上与全部网友服的 welcome 都还没有 app 字段');
  } finally { await srv.close(); }
  const bad = await probe({ address: '这不是地址' }, { timeoutMs: 1000, diagnose: false });
  assert.equal(bad.verdict, '坏地址');
  // `toWsUrl` happily builds `wss://这不是地址/ws`, so without the picker's own `addressError` a typo would be
  // reported as a server that died. The message has to be the one the player already sees in the picker.
  assert.match(bad.detail, /地址无法识别/);
  assert.equal((await probe({ address: 'https://foo bar/', timeoutMs: 1000, diagnose: false })).verdict, '坏地址');
});

test('summarize：对照失败时排名不作数，候选条目不参与闸门', () => {
  const row = (o) => ({ verdict: 'welcome', seeded: true, ...o });
  const ok = summarize([row({ control: true }), row({}), row({})]);
  assert.equal(ok.code, 0);
  assert.equal(ok.alive.length, 2, '对照不算进种子存活数');

  const deadSeed = summarize([row({ control: true }), row({}), row({ verdict: '连不上' })]);
  assert.equal(deadSeed.code, 1);
  assert.equal(deadSeed.dead.length, 1);

  const deadControl = summarize([row({ control: true, verdict: '连不上' }), row({})]);
  assert.equal(deadControl.code, 1, '对照失败 ⇒ 整张表无效');

  const candidateOnly = summarize([row({ control: true }), row({ seeded: false, verdict: 'hello 被拒' })]);
  assert.equal(candidateOnly.code, 0, '候选是待定的东西，不是已经许出去的承诺');
});

test('parseArgv：--add 是候选、坏格式被单独收集，且对照永远在最前', () => {
  const p = parseArgv(['--add', '网友服 · foo=https://foo.example/', '--add', '没有等号', '--timeout', '1234', '--name', '探针']);
  assert.equal(p.timeoutMs, 1234);
  assert.equal(p.name, '探针');
  assert.deepEqual(p.bad, ['没有等号']);
  assert.deepEqual(p.dupes, []);
  assert.equal(p.targets[0].control, true);
  const last = p.targets[p.targets.length - 1];
  assert.deepEqual({ name: last.name, address: last.address, seeded: last.seeded }, { name: '网友服 · foo', address: 'https://foo.example/', seeded: false });
});

test('候选里重复已有条目（或彼此重复）不会把存活/死亡数算歪 —— 去重键和 picker 用同一个', () => {
  const seededOne = COMMUNITY_SERVERS[0];
  const p = parseArgv(['--add', `网友服 · 重复=${seededOne.address}`]);
  assert.equal(p.dupes.length, 1, `同一台服务器该被认出来：${seededOne.address}`);
  assert.ok(p.dupes[0].includes(seededOne.address));
  assert.equal(p.targets.filter((t) => t.address === seededOne.address).length, 1, '重复条目不进目标表');
  const twice = parseArgv(['--add', '网友服 · a=https://a.example/', '--add', '网友服 · b=https://a.example/']);
  assert.equal(twice.targets.filter((t) => t.address === 'https://a.example/').length, 1);
  assert.equal(twice.dupes.length, 1);
});

test('FAKE_IP 只圈住 198.18.0.0/15 —— 那是 TUN 代理的地址段，不是公网', () => {
  assert.equal(FAKE_IP.test('198.18.0.56'), true);
  assert.equal(FAKE_IP.test('198.19.9.9'), true);
  assert.equal(FAKE_IP.test('198.20.0.1'), false);
  assert.equal(FAKE_IP.test('183.66.27.19'), false, '183.66.27.19 是一台真实播种服务器的地址');
});

test('resolvedIp 对裸 IP 直接返回，不发查询', async () => {
  assert.equal(await resolvedIp('ws://127.0.0.1:20522/ws'), '127.0.0.1');
  assert.match(await resolvedIp('ws://127.0.0.1/x'), /^127\.0\.0\.1$/);
});
