package site.starst.stronghold;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import com.easytier.jni.EasyTierJNI;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * In-app EasyTier for the Capacitor player.
 *
 * Owns the Android VpnService TUN and the pinned upstream Rust JNI instance.
 * Routes only the game mesh CIDR. In particular, never routes 0.0.0.0/0:
 * EasyTier's own public peer connection must remain on the underlying network.
 *
 * The only UI permission prompt is VpnService.prepare(), initiated by a real
 * player button in StrongholdLanBridge. No root or separate APK is required.
 */
public final class StrongholdLanVpnService extends VpnService {
    public static final String ACTION_START = "site.starst.stronghold.lan.START";
    public static final String ACTION_STOP = "site.starst.stronghold.lan.STOP";
    private static final String TAG = "StrongholdLAN";
    private static final String INSTANCE = "stronghold-android";
    private static final String CHANNEL = "stronghold-lan";
    private static final int NOTIFICATION_ID = 2005;
    private static final int STARTUP_POLLS = 25;
    private static final String MESH_CIDR = "10.126.126.0";
    private static final int MESH_PREFIX = 24;

    private static volatile String state = "stopped";
    private static volatile String message = "联机未开启";
    private static volatile String hint = "";
    private static volatile boolean activeService = false;
    private final AtomicBoolean stopped = new AtomicBoolean(false);
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private ParcelFileDescriptor tun;

    public static void markStarting() {
        state = "starting";
        message = "正在连接 EasyTier";
        hint = "";
    }
    public static void markError(String reason) {
        state = "error";
        message = "联机启动失败";
        hint = reason;
    }
    public static boolean isConfigured(Context context) {
        try {
            JSONObject cfg = readConfig(context);
            return !cfg.optString("networkName").isEmpty()
                && !cfg.optString("networkSecret").isEmpty()
                && cfg.optJSONArray("peers") != null
                && cfg.optJSONArray("peers").length() > 0;
        } catch (Exception e) {
            return false;
        }
    }
    private static JSONObject readConfig(Context context) throws Exception {
        try (InputStream in = context.getAssets().open("lan-config.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] chunk = new byte[2048];
            int count;
            while ((count = in.read(chunk)) != -1) bytes.write(chunk, 0, count);
            return new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
        }
    }

    /** Read-only, intentionally never exposes networkName or networkSecret. */
    public static String statusJson(Context context) {
        try {
            boolean available = isConfigured(context) && EasyTierJNI.tryLoad();
            JSONObject out = new JSONObject();
            out.put("ok", available);
            out.put("state", available ? state : "disabled");
            out.put("message", available ? message : "当前安装包未内置 EasyTier 网络配置");
            out.put("hint", available ? hint : "");
            if (available) out.put("directoryUrl", readConfig(context).optString("directoryUrl",
                "https://sp.lain42.top/api/lan/v1/rooms"));
            return out.toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"state\":\"disabled\"}";
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? "" : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            worker.execute(this::stopNetwork);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (activeService) return START_NOT_STICKY; // second tap does not create a second TUN
        activeService = true;
        startForegroundSafely();
        worker.execute(this::startNetwork);
        return START_NOT_STICKY; // VPN must only start from an explicit player action
    }

    private void startForegroundSafely() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "卫戍协议联机",
                NotificationManager.IMPORTANCE_LOW);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            nm.createNotificationChannel(channel);
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Notification note = b.setContentTitle("卫戍协议 · 虚拟局域网")
            .setContentText("EasyTier 正在运行；在游戏内可关闭联机")
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setOngoing(true).build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, note);
        }
    }

    private static String quoteToml(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"")
            .replace("\r", "\\r").replace("\n", "\\n") + "\"";
    }
    private static String createConfig(JSONObject cfg) throws Exception {
        String name = cfg.getString("networkName");
        String secret = cfg.getString("networkSecret");
        JSONArray peers = cfg.getJSONArray("peers");
        StringBuilder toml = new StringBuilder();
        toml.append("inst_name = ").append(quoteToml(INSTANCE)).append("\n");
        toml.append("network = ").append(quoteToml(name)).append("\n");
        toml.append("network_secret = ").append(quoteToml(secret)).append("\n");
        toml.append("dhcp = true\n");
        toml.append("peers = [");
        int count = 0;
        for (int i = 0; i < peers.length(); i++) {
            String peer = peers.getString(i);
            if (!(peer.startsWith("tcp://") || peer.startsWith("udp://") ||
                  peer.startsWith("ws://") || peer.startsWith("wss://"))) {
                throw new IllegalArgumentException("不支持的 EasyTier Peer 协议");
            }
            if (count++ > 0) toml.append(", ");
            toml.append(quoteToml(peer));
        }
        toml.append("]\n");
        return toml.toString();
    }
    private void startNetwork() {
        if (stopped.get()) return;
        if (!EasyTierJNI.tryLoad()) {
            markError("安装包缺少 EasyTier JNI 库");
            stopSelf();
            return;
        }
        try {
            JSONObject config = readConfig(this);
            String toml = createConfig(config); // never log: contains the shared network secret
            if (EasyTierJNI.parseConfig(toml) != 0) throw new IOException("EasyTier 配置不兼容");
            if (EasyTierJNI.runNetworkInstance(toml) != 0) throw new IOException("EasyTier 核心无法启动");
            for (int i = 0; i < STARTUP_POLLS && !stopped.get(); i++) {
                String ip = assignedIpv4();
                if (ip != null) {
                    Builder builder = new Builder().setSession("卫戍协议 EasyTier")
                        .setMtu(1400).addAddress(ip, MESH_PREFIX)
                        .addRoute(MESH_CIDR, MESH_PREFIX);
                    // Only mesh traffic goes through the VPN. The native Rust process
                    // still talks to sp.lain42.top:11010 on the regular connection.
                    tun = builder.establish();
                    if (tun == null) throw new IOException("Android 拒绝创建 TUN 设备");
                    if (EasyTierJNI.setTunFd(INSTANCE, tun.getFd()) != 0)
                        throw new IOException("EasyTier TUN 绑定失败");
                    state = "degraded";
                    message = "EasyTier 已连接，正在检测官方服";
                    if (officialHealth()) {
                        state = "up";
                        message = "虚拟局域网已连接";
                    } else {
                        hint = "官方服尚未响应，可稍后刷新";
                    }
                    return;
                }
                Thread.sleep(1200);
            }
            if (!stopped.get()) throw new IOException("未获取虚拟 IP，请检查网络和服务器");
        } catch (Exception | LinkageError e) {
            // Never record TOML/config values in exceptions or logs.
            Log.w(TAG, "EasyTier Android VPN failed (native/permission/network)");
            if (!stopped.get()) markError("网络或 VPN 接口初始化失败");
            stopNetwork();
            stopSelf();
        }
    }

    /** EasyTier v2.6.4 collectNetworkInfos JSON: map[inst].my_node_info.virtual_ipv4.address.addr. */
    private String assignedIpv4() {
        try {
            String raw = EasyTierJNI.collectNetworkInfos();
            if (raw == null || raw.isEmpty()) return null;
            JSONObject root = new JSONObject(raw);
            JSONObject map = root.optJSONObject("map");
            if (map == null) map = root;
            JSONObject inst = map.optJSONObject(INSTANCE);
            if (inst == null || !inst.optBoolean("running", false)) return null;
            JSONObject node = inst.optJSONObject("my_node_info");
            if (node == null) node = inst.optJSONObject("myNodeInfo");
            if (node == null) return null;
            JSONObject ipv4 = node.optJSONObject("virtual_ipv4");
            if (ipv4 == null) ipv4 = node.optJSONObject("virtualIpv4");
            if (ipv4 == null) return null;
            JSONObject addr = ipv4.optJSONObject("address");
            if (addr == null) return null;
            long bits = addr.optLong("addr") & 0xffffffffL;
            if (bits == 0L) return null;
            return ((bits >>> 24) & 255) + "." + ((bits >>> 16) & 255) + "."
                + ((bits >>> 8) & 255) + "." + (bits & 255);
        } catch (Exception e) {
            return null;
        }
    }

    private boolean officialHealth() {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL("http://10.126.126.1:5150/healthz").openConnection();
            conn.setConnectTimeout(3500);
            conn.setReadTimeout(3500);
            return conn.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void stopNetwork() {
        if (!stopped.compareAndSet(false, true)) return;
        try { if (EasyTierJNI.tryLoad()) EasyTierJNI.retainNetworkInstance(null); }
        catch (Exception | LinkageError ignored) {}
        if (tun != null) {
            try { tun.close(); } catch (Exception ignored) {}
            tun = null;
        }
        activeService = false;
        state = "stopped";
        message = "联机已关闭";
        hint = "";
    }
    @Override public void onRevoke() {
        worker.execute(this::stopNetwork);
        stopSelf();
    }
    @Override public void onDestroy() {
        stopNetwork();
        worker.shutdownNow();
        super.onDestroy();
    }
}
