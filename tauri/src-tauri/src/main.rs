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
/// 单实例的内核对象名。命名互斥量在进程结束时由内核释放（崩溃也算），所以不会留下"以为还开着"的僵尸锁。
#[cfg(windows)]
const SINGLE_INSTANCE_MUTEX: &str = "Local\\StrongholdProtocolTauri.singleInstance";
/// `GetLastError()` 的这个值表示"互斥量本来就在"，也就是已经有一个本客户端在跑。
#[cfg(windows)]
const ERROR_ALREADY_EXISTS: u32 = 183;

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

/// 不是故障、但必须解释一句的情况：已经有一个在跑了。
///
/// Electron 那边是 `app.requestSingleInstanceLock()` 失败就静默退出 + `second-instance` 把已有窗口抬到前面
/// （`desktop/main.mjs:79/236`）。本壳认得出"已经有一个"（内核的命名互斥量 + 47821 的页面记号），但**抬不动**
/// 另一个进程的窗口 —— 那需要一个进程间信号加一次主线程调用，而窗口在别的进程里。所以至少说清"已经开着了"：
/// 双击完什么都没发生，玩家只会以为客户端坏了。
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

// 直接声明 `MessageBoxW`，不为此加一个 windows 绑定的 crate（`#[link]` 让链接器去找 user32.lib）。
// extern 块放在模块顶层：`#[link]` 写在函数体里虽然通常也认，但没必要赌。
// 这里是 `//` 而不是 `///`：rustdoc 不给 extern 块生成文档，`///` 只会多一条 unused_doc_comments 警告。
#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: *mut core::ffi::c_void, text: *const u16, caption: *const u16, utype: u32) -> i32;
}

// 单实例用的是内核的命名互斥量，同样手写声明，不加 windows crate。
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(attrs: *mut core::ffi::c_void, initial: i32, name: *const u16) -> *mut core::ffi::c_void;
    fn GetLastError() -> u32;
}

/// 已经有一个本客户端在跑了？
///
/// 为什么不能只靠"47821 上是不是我们的页面"：那个探针看得见**已经在服务**的实例，看不见**正在启动**的实例
/// —— 两次双击挤在一起时，第二个会以为自己抢到的是别的程序占的端口，退到 47822 开出一个新 origin，
/// 玩家看到的就是一份空存档。互斥量在 CreateFile 那一刻就把"同一个程序"这件事钉住了，而且早于绑端口。
/// 句柄故意不关：进程退出（含崩溃）时内核自己回收。
#[cfg(windows)]
fn already_running() -> bool {
    let wide: Vec<u16> = SINGLE_INSTANCE_MUTEX
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe { CreateMutexW(core::ptr::null_mut(), 0, wide.as_ptr()) };
    if handle.is_null() {
        // 拿不到句柄说明不了"另一个实例在跑"，不能因此拒绝启动
        return false;
    }
    // 整个比较放进 unsafe 块：`unsafe { f() } == X` 不是合法表达式（rustc 把 `unsafe {}` 当成语句，
    // 于是报 expected expression, found `==`），第一次编译就是这么红的。
    unsafe { GetLastError() == ERROR_ALREADY_EXISTS }
}

#[cfg(not(windows))]
fn already_running() -> bool {
    false
}

#[cfg(windows)]
fn message_box(msg: &str, icon: u32) {
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

    // 单实例先看内核对象，再看端口：顺序很重要 —— 互斥量连"正在启动、还没开始服务"的那个实例也算得到，
    // 而端口探针只看得见已经服务的。反过来（先探端口）会让两次挤在一起的双击里第二次退到 47822，
    // 开出一个 origin 不同、看起来是空的存档。
    if already_running() {
        notice("已经有一个客户端在跑，不再开第二个。\n\n要看另一个服务器：在那个窗口里按 F2。");
    }

    // 端口已被占用时先分清占它的是"另一个我们"还是别人。前者必须退出：第二个实例会退到 47822 上开出一个全新
    // origin，玩家看到的是代号、设置、调配全空 —— 那比启动慢更容易被当成存档丢了。
    if occupied_by_us()? {
        notice("已经有一个客户端在跑（47821 上就是本游戏的页面），不再开第二个。\n\n要看另一个服务器：在那个窗口里按 F2。");
    }

    let stats = Arc::new(ServeStats::default());
    let (port, _thread) = server::spawn_server(www.clone(), Arc::clone(&stats))?;
    // 端口挪走了就等于换了 origin，而 localStorage 是按 origin 存的：这件事必须说出来，不能让玩家自己发现"存档没了"。
    if port != server::DEFAULT_PORT {
        eprintln!("[tauri] 端口 {} 被占，改用 {port}", server::DEFAULT_PORT);
        popup(
            &format!(
                "本地端口 {} 被别的程序占着，这次改用 {port}。\n\n\
                 代号、编队、设置是按端口存的，所以这个窗口里它们会是空的；\n\
                 把占端口的程序关掉再开客户端，原来那份就回来了。",
                server::DEFAULT_PORT
            ),
            MB_ICONINFORMATION,
        );
    }
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
                                "boot_probe first_request_ms={} main_js_ms={} requests={} connections={}",
                                s.first_ms.load(Ordering::Relaxed),
                                entry,
                                s.requests.load(Ordering::Relaxed),
                                s.connections.load(Ordering::Relaxed)
                            );
                            std::process::exit(0);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    println!(
                        "boot_probe TIMEOUT requests={} connections={} first_request_ms={}",
                        s.requests.load(Ordering::Relaxed),
                        s.connections.load(Ordering::Relaxed),
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
