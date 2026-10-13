import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fetchLanStatus, setLanUp } from '../shell/lanRooms.js';

test('Android native LAN bridge returns status and bypasses HTTP /lan/status', async () => {
  const prev = globalThis.StrongholdLanBridge;
  try {
    globalThis.StrongholdLanBridge = {
      getStatus: () => JSON.stringify({
        ok: true, state: 'up', message: 'connected',
        directoryUrl: 'https://sp.lain42.top/api/lan/v1/rooms'
      }),
      setEnabled: (enabled) => JSON.stringify({ ok: true, state: enabled ? 'starting' : 'stopped' }),
    };
    const bomb = () => { throw new Error('native calls must not use desktop HTTP endpoint'); };
    const state = await fetchLanStatus(bomb);
    assert.equal(state.state, 'up');
    assert.equal((await setLanUp(true, bomb)).state, 'starting');
    assert.equal((await setLanUp(false, bomb)).state, 'stopped');
  } finally {
    if (prev === undefined) delete globalThis.StrongholdLanBridge;
    else globalThis.StrongholdLanBridge = prev;
  }
});

test('no native bridge keeps browser and iOS LAN card hidden', async () => {
  const prev = globalThis.StrongholdLanBridge;
  try {
    delete globalThis.StrongholdLanBridge;
    assert.equal(await fetchLanStatus(async () => ({ ok: false })), null);
    assert.equal(await setLanUp(true, async () => ({ ok: false })), null);
  } finally {
    if (prev !== undefined) globalThis.StrongholdLanBridge = prev;
  }
});

test('Android VPN requires explicit user permission and routes only 10.126.126/24', () => {
  const base = 'mobile/android/app/src/main';
  const service = fs.readFileSync(base + '/java/site/starst/stronghold/StrongholdLanVpnService.java', 'utf8');
  const bridge = fs.readFileSync(base + '/java/site/starst/stronghold/StrongholdLanBridge.java', 'utf8');
  const manifest = fs.readFileSync(base + '/AndroidManifest.xml', 'utf8');
  assert.match(service, /addRoute\(MESH_CIDR, MESH_PREFIX\)/);
  assert.doesNotMatch(service, /addRoute\("0\.0\.0\.0"/);
  assert.match(service, /setTunFd\(INSTANCE, tun\.getFd\(\)\)/);
  // Official EasyTier v2.6.4 Rust export takes only JNIEnv and JClass.
  // The upstream example Kotlin wrapper incorrectly documents an extra maxLength arg.
  const jni = fs.readFileSync(base + '/java/com/easytier/jni/EasyTierJNI.java', 'utf8');
  assert.match(jni, /native String collectNetworkInfos\(\)/);
  assert.match(service, /EasyTierJNI\.collectNetworkInfos\(\)/);
  assert.match(service, /startForeground\(/);
  assert.match(bridge, /VpnService\.prepare\(activity\)/);
  assert.match(bridge, /isTrustedLanPage\(\)/);
  const activity = fs.readFileSync(base + '/java/site/starst/stronghold/MainActivity.java', 'utf8');
  assert.match(activity, /volatile boolean lanTrustedPage/);
  assert.match(activity, /onPageStarted\(WebView view, String url, Bitmap favicon\)/);
  assert.match(activity, /lanTrustedPage = false/);
  assert.match(activity, /lanTrustedPage = isLocalCapacitorUrl\(url\)/);
  assert.match(manifest, /android\.net\.VpnService/);
  assert.match(manifest, /android\.permission\.BIND_VPN_SERVICE/);
  assert.match(manifest, /FOREGROUND_SERVICE_SPECIAL_USE/);
});

test('CI builds pinned EasyTier JNI and FFI, and rejects incomplete APK', () => {
  const yaml = fs.readFileSync('.github/workflows/build-clients.yml', 'utf8');
  assert.match(yaml, /--branch v2\.6\.4 https:\/\/github\.com\/EasyTier\/EasyTier/);
  assert.match(yaml, /build --release -p easytier-android-jni --locked/);
  assert.match(yaml, /build --release -p easytier-ffi --locked/);
  assert.match(yaml, /node tools\/write-android-lan-config\.mjs --require/);
  assert.match(yaml, /unzip -Z1 "\$APK" \| grep -Fx 'lib\/arm64-v8a\/libeasytier_android_jni\.so'/);
  assert.match(yaml, /unzip -Z1 "\$APK" \| grep -Fx 'assets\/lan-config\.json'/);
  assert.match(yaml, /install -m 0644 shell\/lanRooms\.js build\/client\/www\/js\/shell\/lanRooms\.js/);
  assert.match(yaml, /install -m 0644 shell\/picker\.js build\/client\/www\/js\/shell\/picker\.js/);
});
