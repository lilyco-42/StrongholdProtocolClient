//! 《卫戍协议：盟约》的 Tauri 壳 —— 跑的是与 Electron 壳**同一份** payload，只是不再自带 Chromium。
//!
//! 为什么要这一个壳，只有两条玩家报的问题：包太大、启动太慢。目录版实测解包 1,145.4 MiB，其中 825.4 MiB 是
//! payload 素材，剩下 **320.0 MiB 是 Electron 自带的运行时**；WebView2 是系统组件，于是这 320 MiB 换成十几 MB。
//! 启动那条得说清楚：真正慢的是 `portable.exe` 每次启动都要自解压（实测它自己在临时目录里铺了 974 MB），
//! 跟壳是哪个无关 —— 所以这个壳只出"目录 + 安装器"，不出单文件版。
//!
//! 关键设计：壳自己起一个**只监听 127.0.0.1:47821** 的静态服务器，窗口加载 `http://127.0.0.1:47821/` ——
//! 与 Electron 壳同一个 origin。浏览器按 origin 划分 localStorage，博士代号、干员调配、设置、记住的服务器都在里面，
//! 换成随机端口或 `tauri://localhost` 就会让人以为存档丢了。HTTP 细节在 `server.rs`，逐条对着
//! `desktop/serve.mjs` 写，并由 `test/tauri-parity.test.js` 钉住两边不许漂移。

// 发布版不许带控制台窗口。Rust 的二进制默认是 **console 子系统**，双击启动时 Windows 会先给开一个黑窗，
// 里面是本壳的日志（2026-10-08 玩家真机报："启动有这个控制台，能去掉么"）。debug 构建保留，
// `cargo tauri dev` 的日志还要看得见；release 下日志改由 `die()` 弹原生框（见那里）。
#![cfg_attr(all(not(debug_assertions), not(test)), windows_subsystem = "windows")]

mod server;

use server::ServeStats;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// 认出"47821 上已经是我们自己的页面"的记号。
const ORIGIN_MARKER: &str = "卫戍协议";

fn main() {
    if let Err(e) = run() {
        die(&e.to_string());
    }
}

/// 启动失败怎么让人看见。
///
/// release 版没有控制台了（见文件头的 `windows_subsystem`），双击启动的人看不见 `eprintln!` ——
/// "点了没反应"比一个黑窗更难查。所以致命错误弹一个原生消息框，Electron 壳那边对应
/// `dialog.showErrorBox`（`desktop/main.mjs`）。**探针模式下绝不弹**：CI 会被模态框挂住 90 秒然后超时，
/// 而那一步要的是 stdout 上的 `boot_probe` 行。
fn die(msg: &str) -> ! {
    eprintln!("[tauri] {msg}");
    popup(msg, MB_ICONERROR);
    std::process::exit(1);
}

/// 不是故障、但必须解释一句的情况：47821 上已经是本游戏自己的页面了。
///
/// Electron 那边是 `app.requestSingleInstanceLock()` 失败就静默退出 + `second-instance` 把已有窗口抬到前面
/// （`desktop/main.mjs:79/236`）。本壳没有单实例插件，抬不了那个窗口，所以至少说清"已经开着了"——
/// 否则玩家双击完什么都没发生，只会以为客户端坏了。
fn notice(msg: &str) -> ! {
    eprintln!("[tauri] {msg}");
    popup(msg, MB_ICONINFORMATION);
    std::process::exit(0);
}

const MB_ICONERROR: u32 = 0x0000_0010;
const MB_ICONINFORMATION: u32 = 0x0000_0040;

/// 探针模式（CI 的启动测量）下静默；其余情况在 Windows 上弹一个原生框。
fn popup(msg: &str, icon: u32) {
    #[cfg(windows)]
    if std::env::var("SP_TAU_BOOT_PROBE").is_err() {
        message_box(msg, icon);
    }
    #[cfg(not(windows))]
    let _ = (msg, icon);
}

/// 直接声明 `MessageBoxW`，不为此加一个 windows 绑定的 crate（`#[link]` 让链接器去找 user32.lib）。
#[cfg(windows)]
fn message_box(msg: &str, icon: u32) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: *mut core::ffi::c_void, text: *const u16, caption: *const u16, utype: u32) -> i32;
    }
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let text = wide(msg);
    let caption = wide("卫戍协议：盟约");
    unsafe {
        MessageBoxW(core::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), icon);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let www = locate_www()?;
    if !www.join("index.html").is_file() {
        return Err(format!("这个包是坏的：{} 不存在", www.join("index.html").display()).into());
    }

    // 端口已被占用时先分清占它的是"另一个我们"还是别人。前者必须退出：第二个实例会退到 47822 上开出一个全新
    // origin，玩家看到的是代号、设置、调配全空 —— 那比启动慢更容易被当成存档丢了。
    if occupied_by_us()? {
        notice("已经有一个客户端在跑（47821 上就是本游戏的页面），不再开第二个。\n\n要看另一个服务器：在那个窗口里按 F2。");
    }

    let stats = Arc::new(ServeStats::default());
    let (port, _thread) = server::spawn_server(www.clone(), Arc::clone(&stats))?;
    let url = format!("http://127.0.0.1:{port}/");
    let probe = std::env::var("SP_TAU_BOOT_PROBE").is_ok();
    println!("[tauri] 静态服务 port={port} root={}", www.display());

    let probe_for_setup = probe;
    let stats_for_setup = Arc::clone(&stats);
    let url_for_setup = url.clone();

    let app = tauri::Builder::default()
        .setup(move |app| {
            let parsed: tauri::Url = url_for_setup
                .parse()
                .map_err(|e| format!("窗口地址不合法 {url_for_setup}: {e}"))?;
            let _win = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(parsed))
                .title("卫戍协议：盟约")
                .inner_size(1440.0, 810.0)
                .min_inner_size(960.0, 540.0)
                .resizable(true)
                // 探针模式下先别把窗口抬起来：我们要的是"页面自己的入口被取到没有"，不是给人看的画面
                .visible(!probe_for_setup)
                .build()
                .map_err(|e| format!("窗口建不起来: {e}"))?;

            if probe_for_setup {
                let s = Arc::clone(&stats_for_setup);
                std::thread::spawn(move || {
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
                    while std::time::Instant::now() < deadline {
                        let entry = s.entry_ms.load(Ordering::Relaxed);
                        if entry > 0 {
                            println!(
                                "boot_probe first_request_ms={} main_js_ms={} requests={}",
                                s.first_ms.load(Ordering::Relaxed),
                                entry,
                                s.requests.load(Ordering::Relaxed)
                            );
                            std::process::exit(0);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    println!(
                        "boot_probe TIMEOUT requests={} first_request_ms={}",
                        s.requests.load(Ordering::Relaxed),
                        s.first_ms.load(Ordering::Relaxed)
                    );
                    std::process::exit(2);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .map_err(|e| format!("壳起不来: {e}"))?;

    app.run(|_handle, _event| {});
    Ok(())
}

/// payload 在哪：`$SP_WWW`（测试与"素材放在安装目录外"的机器）→ 安装目录里的 `www` → exe 旁边 → 开发用的 checkout。
fn locate_www() -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Ok(p) = std::env::var("SP_WWW") {
        let pb = PathBuf::from(&p);
        if pb.is_dir() {
            return Ok(pb);
        }
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    for c in [
        exe_dir.join("www"),
        exe_dir.join("resources").join("www"),
        PathBuf::from("src-tauri/www"),
        PathBuf::from("www"),
    ] {
        if c.join("index.html").is_file() {
            return Ok(c);
        }
    }
    Err("找不到 payload 目录 www/ —— 构建时必须把 payload 解到 src-tauri/www 并当资源打进包里".into())
}

/// 47821 已经被人占用了，而且占它的就是本游戏的页面？
fn occupied_by_us() -> Result<bool, Box<dyn std::error::Error>> {
    let mut sock = match std::net::TcpStream::connect(("127.0.0.1", server::DEFAULT_PORT)) {
        Ok(s) => s,
        Err(_) => return Ok(false),
    };
    sock.set_read_timeout(Some(std::time::Duration::from_millis(800)))?;
    sock.set_write_timeout(Some(std::time::Duration::from_millis(800)))?;
    sock.write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")?;
    let mut buf = Vec::with_capacity(8192);
    let _ = sock.read_to_end(&mut buf);
    Ok(String::from_utf8_lossy(&buf).contains(ORIGIN_MARKER))
}
