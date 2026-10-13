package site.starst.stronghold;

import android.app.Activity;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.webkit.JavascriptInterface;
import com.easytier.jni.EasyTierJNI;

/** Narrow bridge for the existing web picker. No network secret is exposed to JavaScript.
 * Calls from addJavascriptInterface may arrive on a WebView bridge thread: user prompts
 * and service operations are explicitly posted to the Android UI thread.
 */
public final class StrongholdLanBridge {
    public static final int VPN_CONSENT_REQUEST = 44107;
    private final MainActivity activity;

    public StrongholdLanBridge(MainActivity activity) { this.activity = activity; }

    private boolean trustedPage() {
        return activity.isTrustedLanPage();
    }
    @JavascriptInterface
    public String getStatus() {
        return trustedPage() ? StrongholdLanVpnService.statusJson(activity)
            : "{\"ok\":false,\"state\":\"disabled\"}";
    }

    @JavascriptInterface
    public String setEnabled(boolean enable) {
        if (!trustedPage()) return "{\"ok\":false,\"state\":\"disabled\"}";
        if (!enable) {
            activity.runOnUiThread(() -> {
                Intent intent = new Intent(activity, StrongholdLanVpnService.class);
                intent.setAction(StrongholdLanVpnService.ACTION_STOP);
                activity.startService(intent);
            });
            return "{\"ok\":true,\"state\":\"stopped\",\"message\":\"正在关闭联机\"}";
        }
        if (!StrongholdLanVpnService.isConfigured(activity) || !EasyTierJNI.tryLoad()) {
            return "{\"ok\":false,\"state\":\"disabled\",\"message\":\"当前安装包未包含 EasyTier 原生库或网络配置\"}";
        }
        StrongholdLanVpnService.markStarting();
        activity.runOnUiThread(() -> {
            Intent prepared = VpnService.prepare(activity);
            if (prepared != null) {
                activity.startActivityForResult(prepared, VPN_CONSENT_REQUEST);
            } else {
                startApprovedVpn();
            }
        });
        return "{\"ok\":true,\"state\":\"starting\",\"message\":\"等待 VPN 授权并启动\"}";
    }

    void onVpnConsentResult(boolean approved) {
        if (approved) startApprovedVpn();
        else StrongholdLanVpnService.markError("未获得 Android VPN 授权");
    }

    private void startApprovedVpn() {
        Intent intent = new Intent(activity, StrongholdLanVpnService.class);
        intent.setAction(StrongholdLanVpnService.ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) activity.startForegroundService(intent);
        else activity.startService(intent);
    }
}
