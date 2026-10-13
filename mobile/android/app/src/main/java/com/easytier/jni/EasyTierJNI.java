package com.easytier.jni;

/** Java ABI for EasyTier v2.6.4's official easytier-android-jni Rust exports.
 * Keep method names/package in sync with v2.6.4/src/lib.rs.
 * JNI + FFI libraries are built in GitHub Actions; no third-party binaries are committed.
 */
public final class EasyTierJNI {
    private EasyTierJNI() {}
    private static volatile boolean loaded = false;

    public static synchronized boolean tryLoad() {
        if (loaded) return true;
        try {
            System.loadLibrary("easytier_ffi");
            System.loadLibrary("easytier_android_jni");
            loaded = true;
        } catch (LinkageError e) {
            return false;
        }
        return loaded;
    }
    public static native int parseConfig(String toml);
    public static native int runNetworkInstance(String toml);
    public static native int setTunFd(String instanceName, int fd);
    public static native int retainNetworkInstance(String[] instanceNames);
    public static native String collectNetworkInfos();
    public static native String getLastError();
}
