//! 虚拟局域网 sidecar —— Tauri 壳这一侧。
//!
//! 与 `desktop/lan.mjs` 是同一件事的两份实现，规则逐条对齐（`test/tauri-parity.test.js` 之外，
//! 本文件的单元测试钉住纯逻辑那一半）：
//!
//!   GET  /lan/status   状态（永远不含密钥）
//!   POST /lan/up       拉起隧道（幂等）
//!   POST /lan/down     拆掉隧道（幂等）
//!   GET  /lan/rooms    本壳**不实现** —— 页面会回落到直接取 directoryUrl（目录服务发 ACAO: *）
//!
//! 三个刻意的取舍，与 Electron 壳完全一致：
//!
//! 1. **密钥走 `-c` 配置文件，不走 argv。** 网络口令是所有玩家共用的，`ps` / 任务管理器一眼就能看到
//!    命令行。落盘是 0600 的 TOML（Windows 上 mode 位无意义，但那份文件在用户数据目录里，不是安装目录）。
//! 2. **不静默提权。** Windows 建 TUN 网卡需要管理员权限。这里的表现**不是 spawn 失败** —— 进程起得来、
//!    拿不到网卡、一两秒内退出。所以判据是"刚启动就死了"，提示直接说清右键 →「以管理员身份运行」。
//! 3. **缺组件不是错误。** 没打进 sidecar 的构建（浏览器版 / 自己编的）`/lan/status` 答 `disabled`，
//!    选服页据此**不显示**这张卡片 —— 不给玩家一个点了注定失败的按钮（P1，与 `docs/SERVER-LIST.md` 同）。
//!
//! 为什么 `/lan/rooms` 不在这里实现：本壳是刻意零依赖的（整个存在的理由就是省那 320 MiB），
//! 而目录是 `https://…` —— 自己发这个请求就得拉进一整套 TLS。目录服务本来就带
//! `access-control-allow-origin: *`，所以让页面直接取它更省、也更少一处可能过期的转发。

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 页面上的四个端点共用的前缀。`/lan/rooms` 不在其中（见文件头）。
pub const LAN_PREFIX: &str = "/lan/";
pub const CONFIG_FILE: &str = "lan-config.json";
/// sidecar 在安装目录里的子目录名（`tauri.conf.json` 的 `bundle.resources`）。
pub const RESOURCE_SUBDIR: &str = "lan";
/// 与 Electron 壳同一个不常见的 RPC 端口：玩家同时开着官方 EasyTier GUI（默认 15888）时两边不打架。
pub const RPC_PORTAL: &str = "127.0.0.1:15988";
pub const DEV_NAME: &str = "stronghold-lan";

/// 上游二进制名。
pub fn core_binary_name() -> &'static str {
    if cfg!(windows) {
        "easytier-core.exe"
    } else {
        "easytier-core"
    }
}

/* ------------------------------------------------------------------ 配置 */

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanConfig {
    pub network_name: String,
    pub network_secret: String,
    pub peers: Vec<String>,
    pub directory_url: String,
    pub official_virtual_ip: String,
    pub port: u16,
}

/// 解析并校验 `lan-config.json`。**不 panic、不抛** —— 一个写坏的构建期文件应该降级成"联机不可用"，
/// 而不是让整个壳起不来。
pub fn parse_config(raw: &str) -> Result<LanConfig, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("lan-config.json 不是合法 JSON：{e}"))?;
    let obj = value
        .as_object()
        .ok_or_else(|| "lan-config.json 不是对象".to_string())?;
    let text = |key: &str| -> String {
        obj.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };

    let network_name = text("networkName");
    if network_name.is_empty() {
        return Err("lan-config.json 缺少 networkName".into());
    }
    let network_secret = text("networkSecret");
    if network_secret.is_empty() {
        return Err("lan-config.json 缺少 networkSecret".into());
    }
    let peers: Vec<String> = obj
        .get("peers")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|p| p.as_str())
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if peers.is_empty() {
        return Err("lan-config.json 缺少 peers（至少要有一个共享节点）".into());
    }
    let mut official_virtual_ip = text("officialVirtualIp");
    if official_virtual_ip.is_empty() {
        official_virtual_ip = "10.126.126.1".to_string();
    }
    let port = obj
        .get("port")
        .and_then(|v| v.as_u64())
        .filter(|p| (1..=65535).contains(p))
        .unwrap_or(5150) as u16;

    Ok(LanConfig {
        network_name,
        network_secret,
        peers,
        directory_url: text("directoryUrl"),
        official_virtual_ip,
        port,
    })
}

fn toml_string(v: &str) -> String {
    format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
}

/// 子进程真正读的那份 TOML。与 `buildCoreArgs` 分开就是为了密钥不进 argv。
pub fn render_toml(cfg: &LanConfig) -> String {
    let mut s = String::new();
    s.push_str("instance_name = \"stronghold-client\"\n");
    // 客户端必须拿地址，否则根本不会建 TUN（dhcp = true 是默认，写出来是为了"读一眼就懂"）。
    s.push_str("dhcp = true\n");
    s.push_str(&format!("rpc_portal = \"{RPC_PORTAL}\"\n"));
    // 客户端不监听：它只往外连，少开一个端口就少一处被扫的面。
    s.push_str("listeners = []\n\n");
    s.push_str("[network_identity]\n");
    s.push_str(&format!("network_name = {}\n", toml_string(&cfg.network_name)));
    s.push_str(&format!("network_secret = {}\n\n", toml_string(&cfg.network_secret)));
    for uri in &cfg.peers {
        s.push_str("[[peer]]\n");
        s.push_str(&format!("uri = {}\n\n", toml_string(uri)));
    }
    s.push_str("[flags]\n");
    s.push_str(&format!("dev_name = \"{DEV_NAME}\"\n"));
    s
}

/// 从日志与状态里抹掉共享密钥。子进程可能把它回显到 stderr 上。
pub fn redact(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        text.to_string()
    } else {
        text.replace(secret, "***")
    }
}

/* ------------------------------------------------------------------ 探测 */

/// 一个极小的 HTTP/1.1 GET，只用来问虚拟网段上的官方服"你在不在"。
///
/// 刻意不是一个通用客户端：它只说明文 HTTP、不跟随跳转、只看状态行。`/healthz` 需要的就这些，
/// 而这样本壳就不必拉进任何 TLS 栈 —— 那正是这个壳存在的理由。
pub fn http_ok(host: &str, port: u16, path: &str, timeout: Duration) -> bool {
    let addr = match (host, port).to_socket_addrs().ok().and_then(|mut it| it.next()) {
        Some(a) => a,
        None => return false,
    };
    let mut sock = match TcpStream::connect_timeout(&addr, timeout) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = sock.set_read_timeout(Some(timeout));
    let _ = sock.set_write_timeout(Some(timeout));
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    if sock.write_all(req.as_bytes()).is_err() {
        return false;
    }
    // 状态行可能不跟第一个 read 一起来，所以读到第一个 CRLF 为止（有上限，坏服务端不能把我们挂住）。
    let mut head: Vec<u8> = Vec::with_capacity(256);
    let mut chunk = [0u8; 256];
    while head.len() < 1024 {
        match sock.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                head.extend_from_slice(&chunk[..n]);
                if head.windows(2).any(|w| w == b"\r\n") {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let line = String::from_utf8_lossy(&head);
    line.starts_with("HTTP/1.1 2") || line.starts_with("HTTP/1.0 2")
}

/* ------------------------------------------------------------------ 状态机 */

/// 状态与给玩家看的那句话。纯函数，注入事实进去就得到结果（与 `describeStatus` 同一套判断）。
pub fn describe(
    has_config: bool,
    config_error: Option<&str>,
    child_alive: bool,
    reachable: Option<bool>,
    error: Option<&str>,
    died_early: bool,
) -> (&'static str, String, String) {
    if let Some(e) = config_error {
        return (
            "error",
            format!("联机组件配置有误：{e}"),
            "请重新安装客户端，或向服主反馈。".into(),
        );
    }
    if !has_config {
        return (
            "disabled",
            "这个客户端没有内置联机组件。".into(),
            "从官网下载桌面版即可一键联机。".into(),
        );
    }
    if let Some(e) = error {
        // Windows 上缺 TUN 网卡**不会**让 spawn 失败：进程起得来、建不了网卡、一两秒内退出。
        // 所以真正会触发的是"刚启动就死了"，而提权是它压倒性的原因。
        let hint = if died_early {
            "最常见的原因是 Windows 需要管理员权限才能创建虚拟网卡：关掉客户端，右键图标 →「以管理员身份运行」。"
        } else {
            "可以重试；不影响直接连官方服。"
        };
        return ("error", format!("联机启动失败：{e}"), hint.into());
    }
    if child_alive {
        return match reachable {
            Some(true) => (
                "up",
                "联机已开启，可以看到局域网里的房间。".into(),
                String::new(),
            ),
            Some(false) => (
                "degraded",
                "虚拟局域网已连上，但还没探到官方服。".into(),
                "再等几秒；若是自建房间，直接看下面的局域网列表。".into(),
            ),
            None => ("starting", "正在开启联机…".into(), String::new()),
        };
    }
    (
        "stopped",
        "联机未开启。".into(),
        "开启后可以玩局域网房间，也能少挤官方服。".into(),
    )
}

/* ------------------------------------------------------------------ 管理器 */

struct Inner {
    config: Option<LanConfig>,
    config_error: Option<String>,
    config_source: Option<String>,
    core_path: Option<PathBuf>,
    child: Option<Child>,
    started_at: Option<Instant>,
    last_error: Option<String>,
    died_early: bool,
    /// 子进程输出（stdout+stderr）的尾巴。读流的线程必须是 `'static`，所以共享的是这个 `Arc` 而不是 `&self`。
    tail: Arc<Mutex<String>>,
    reachable: Option<bool>,
    loaded: bool,
}

/// 找 sidecar 的候选目录，最好的排前面。与 `main.rs` 的 `locate_www` 同一种写法：
/// **先看 `$SP_LAN_DIR`（测试与"组件放在安装目录外"的机器），再看安装目录的两种布局。**
pub fn candidates(exe_dir: &Path) -> Vec<(&'static str, PathBuf)> {
    let mut out: Vec<(&'static str, PathBuf)> = Vec::new();
    if let Ok(dir) = std::env::var("SP_LAN_DIR") {
        if !dir.trim().is_empty() {
            out.push(("SP_LAN_DIR", PathBuf::from(dir)));
        }
    }
    out.push(("安装目录", exe_dir.join(RESOURCE_SUBDIR)));
    out.push(("安装目录(resources/lan)", exe_dir.join("resources").join(RESOURCE_SUBDIR)));
    out
}

pub struct LanManager {
    inner: Mutex<Inner>,
    candidates: Vec<(&'static str, PathBuf)>,
    user_data_dir: PathBuf,
}

impl LanManager {
    pub fn new(candidates: Vec<(&'static str, PathBuf)>, user_data_dir: PathBuf) -> Self {
        Self {
            inner: Mutex::new(Inner {
                config: None,
                config_error: None,
                config_source: None,
                core_path: None,
                child: None,
                started_at: None,
                last_error: None,
                died_early: false,
                tail: Arc::new(Mutex::new(String::new())),
                reachable: None,
                loaded: false,
            }),
            candidates,
            user_data_dir,
        }
    }

    /// 定位 sidecar。只做一次（配置是构建期写死的，打包版永不改变）。
    fn locate(&self) -> (Option<LanConfig>, Option<String>, Option<String>, Option<PathBuf>) {
        for (label, dir) in &self.candidates {
            let config_path = dir.join(CONFIG_FILE);
            let Ok(raw) = std::fs::read_to_string(&config_path) else {
                continue; // 这里没有配置：不是"能联机"的那种构建
            };
            let source = Some((*label).to_string());
            return match parse_config(&raw) {
                Err(e) => (None, Some(e), source, None),
                Ok(cfg) => {
                    let core = dir.join(core_binary_name());
                    if !core.is_file() {
                        return (
                            None,
                            Some(format!("找到了 {CONFIG_FILE} 但同目录下没有 {}", core_binary_name())),
                            source,
                            None,
                        );
                    }
                    (Some(cfg), None, source, Some(core))
                }
            };
        }
        (None, None, None, None)
    }

    fn ensure_loaded(&self, inner: &mut Inner) {
        if inner.loaded {
            return;
        }
        inner.loaded = true;
        let (config, err, source, core) = self.locate();
        inner.config = config;
        inner.config_error = err;
        inner.config_source = source;
        inner.core_path = core;
    }

    /// 探一次官方服。**不持锁**：I/O 期间把锁放掉，否则选服页连点几下就会互相排队。
    fn refresh_reachable(&self) {
        let cfg = {
            let mut g = match self.inner.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            self.ensure_loaded(&mut g);
            if g.child.is_none() {
                g.reachable = None;
                return;
            }
            g.config.clone()
        };
        let Some(cfg) = cfg else { return };
        let ok = http_ok(
            &cfg.official_virtual_ip,
            cfg.port,
            "/healthz",
            Duration::from_millis(1200),
        );
        if let Ok(mut g) = self.inner.lock() {
            // 探测期间玩家可能已经关掉了隧道，那就不要把结果写回去。
            if g.child.is_some() {
                g.reachable = Some(ok);
            }
        }
    }

    fn status_body(&self) -> serde_json::Value {
        self.refresh_reachable();
        let g = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return serde_json::json!({ "ok": false, "error": { "code": "POISONED" } }),
        };
        let alive = g.child.is_some();
        let (state, message, hint) = describe(
            g.config.is_some(),
            g.config_error.as_deref(),
            alive,
            g.reachable,
            g.last_error.as_deref(),
            g.died_early,
        );
        let official = match (&g.config, state) {
            (Some(c), "up") | (Some(c), "degraded") => serde_json::json!({
                "virtualIp": c.official_virtual_ip,
                "port": c.port,
                "reachable": g.reachable.unwrap_or(false),
            }),
            _ => serde_json::Value::Null,
        };
        serde_json::json!({
            "ok": true,
            "schemaVersion": 1,
            "state": state,
            "message": message,
            "hint": hint,
            "official": official,
            "pid": g.child.as_ref().map(|c| c.id()),
            "since": g.started_at.map(|t| t.elapsed().as_millis() as u64),
            "source": g.config_source,
            "directoryUrl": g.config.as_ref().map(|c| c.directory_url.clone()).unwrap_or_default(),
        })
    }

    /// 拉起隧道。幂等：已经在跑就原样返回状态。
    fn start(&self) -> serde_json::Value {
        {
            let mut g = match self.inner.lock() {
                Ok(g) => g,
                Err(_) => return serde_json::json!({ "ok": false, "error": { "code": "POISONED" } }),
            };
            self.ensure_loaded(&mut g);
            if g.config.is_none() || g.child.is_some() {
                drop(g);
                return self.status_body();
            }
            g.last_error = None;
            g.died_early = false;
            if let Ok(mut t) = g.tail.lock() {
                t.clear();
            }
            g.reachable = None;
        }

        // 写 TOML（锁外做文件 I/O），再起进程。
        let (cfg, core) = {
            let g = match self.inner.lock() {
                Ok(g) => g,
                Err(_) => return serde_json::json!({ "ok": false, "error": { "code": "POISONED" } }),
            };
            match (&g.config, &g.core_path) {
                (Some(c), Some(p)) => (c.clone(), p.clone()),
                _ => {
                    drop(g);
                    return self.status_body();
                }
            }
        };

        let dir = self.user_data_dir.join(RESOURCE_SUBDIR);
        let config_path = dir.join("easytier-client.toml");
        if let Err(e) = write_private(&dir, &config_path, &render_toml(&cfg)) {
            if let Ok(mut g) = self.inner.lock() {
                g.last_error = Some(format!("无法写入联机配置：{e}"));
            }
            return self.status_body();
        }

        let spawned = Command::new(&core)
            .arg("-c")
            .arg(&config_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

        match spawned {
            Ok(mut child) => {
                // 子进程自己的话是"为什么起不来"唯一的真线索。读干净、只留尾部、密钥抹掉。
                let tail = {
                    let g = match self.inner.lock() {
                        Ok(g) => g,
                        Err(_) => return self.status_body(),
                    };
                    Arc::clone(&g.tail)
                };
                if let Some(err) = child.stderr.take() {
                    pump(err, Arc::clone(&tail));
                }
                if let Some(out) = child.stdout.take() {
                    pump(out, Arc::clone(&tail));
                }
                if let Ok(mut g) = self.inner.lock() {
                    g.child = Some(child);
                    g.started_at = Some(Instant::now());
                }
                // 给它一点时间建网卡，再做第一次可达性探测。
                std::thread::sleep(Duration::from_millis(1500));
                self.reap();
            }
            Err(e) => {
                if let Ok(mut g) = self.inner.lock() {
                    g.last_error = Some(format!("起不来 easytier-core：{e}"));
                }
            }
        }
        self.status_body()
    }

    /// 子进程是不是已经退出了？退出得早（< 8 s）就记成 `died_early` —— 那基本就是提权问题。
    fn reap(&self) {
        let Ok(mut g) = self.inner.lock() else { return };
        let exited = match g.child.as_mut() {
            Some(c) => match c.try_wait() {
                Ok(Some(status)) => Some(status.code()),
                _ => None,
            },
            None => return,
        };
        let Some(code) = exited else { return };
        let lived = g.started_at.map(|t| t.elapsed()).unwrap_or_default();
        let tail = g.tail.lock().map(|s| s.trim().to_string()).unwrap_or_default();
        let secret = g.config.as_ref().map(|c| c.network_secret.clone()).unwrap_or_default();
        g.child = None;
        g.started_at = None;
        g.reachable = None;
        if code != Some(0) {
            g.died_early = lived < Duration::from_secs(8);
            let last = tail
                .lines()
                .filter(|l| !l.trim().is_empty())
                .last()
                .unwrap_or("")
                .to_string();
            let last = redact(&last, &secret);
            g.last_error = Some(match code {
                Some(c) if !last.is_empty() => format!("easytier-core 退出，代码 {c}：{last}"),
                Some(c) => format!("easytier-core 退出，代码 {c}"),
                None => format!("easytier-core 被信号杀掉：{last}"),
            });
        }
    }

    /// 拆掉隧道。幂等。
    fn stop(&self) -> serde_json::Value {
        if let Ok(mut g) = self.inner.lock() {
            if let Some(mut c) = g.child.take() {
                let _ = c.kill();
                let _ = c.wait(); // 收尸，别留僵尸
            }
            g.started_at = None;
            g.reachable = None;
            g.died_early = false;
        }
        self.status_body()
    }

    /// 处理一个 `/lan/*` 请求。`None` = 不是我们的（交给静态服务去答 404）。
    pub fn handle(&self, method: &str, raw_url: &str) -> Option<(u16, String)> {
        let path = raw_url.split('?').next().unwrap_or("/");
        if !path.starts_with(LAN_PREFIX) {
            return None;
        }
        let route = path[LAN_PREFIX.len()..].trim_end_matches('/');
        let get = method == "GET" || method == "HEAD";
        match (route, method) {
            ("status", _) if get => Some((200, self.status_body().to_string())),
            ("up", "POST") => Some((200, self.start().to_string())),
            ("down", "POST") => Some((200, self.stop().to_string())),
            // 本壳不做目录转发（见文件头）；页面会回落到直接取 directoryUrl。
            _ => Some((
                404,
                serde_json::json!({ "ok": false, "error": { "code": "NOT_FOUND" } }).to_string(),
            )),
        }
    }

    /// 给日志用的一行摘要（不含密钥）。
    pub fn brief(&self) -> String {
        let mut g = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return "lan=poisoned".into(),
        };
        self.ensure_loaded(&mut g);
        let (state, ..) = describe(
            g.config.is_some(),
            g.config_error.as_deref(),
            g.child.is_some(),
            g.reachable,
            g.last_error.as_deref(),
            g.died_early,
        );
        match &g.config_source {
            Some(s) => format!("{state}（来自 {s}）"),
            None => state.to_string(),
        }
    }
}

impl Drop for LanManager {
    fn drop(&mut self) {
        if let Ok(mut g) = self.inner.lock() {
            if let Some(mut c) = g.child.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
}

/// 把一条流读到 EOF，尾巴留在 `tail` 里。为什么要有这个线程：管道写满会**阻塞子进程**，
/// 不读它的输出就等于把 sidecar 挂死在一句日志上。
fn pump<R: Read + Send + 'static>(mut reader: R, tail: Arc<Mutex<String>>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        let mut all = String::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    all.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if all.len() > 8192 {
                        all = all.split_off(all.len() - 4096);
                    }
                }
            }
        }
        if let Ok(mut slot) = tail.lock() {
            slot.push_str(&all);
            if slot.len() > 4096 {
                let cut = slot.len() - 2048;
                *slot = slot.split_off(cut);
            }
        }
    });
}

/// 建目录并写文件，Unix 上带 0600 —— 里面是共享密钥，不给同机其他用户读。
fn write_private(dir: &Path, file: &Path, body: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(file)?;
        f.write_all(body.as_bytes())?;
        f.flush()
    }
    #[cfg(not(unix))]
    {
        std::fs::write(file, body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{
      "networkName": "stronghold-lan",
      "networkSecret": "S3CRET-value-32-chars",
      "peers": ["tcp://sp.lain42.top:11010", "udp://sp.lain42.top:11010"],
      "directoryUrl": "https://sp.lain42.top/api/lan/v1/rooms"
    }"#;

    fn good_config() -> LanConfig {
        parse_config(GOOD).unwrap()
    }

    #[test]
    fn parse_config_applies_the_documented_defaults() {
        let c = good_config();
        assert_eq!(c.network_name, "stronghold-lan");
        assert_eq!(c.peers.len(), 2);
        assert_eq!(c.official_virtual_ip, "10.126.126.1");
        assert_eq!(c.port, 5150);
        assert_eq!(c.directory_url, "https://sp.lain42.top/api/lan/v1/rooms");
    }

    #[test]
    fn parse_config_rejects_each_missing_piece_with_a_readable_reason() {
        assert!(parse_config("{ not json").unwrap_err().contains("不是合法 JSON"));
        assert!(parse_config("[]").unwrap_err().contains("不是对象"));
        assert!(parse_config(r#"{"networkSecret":"s","peers":["a"]}"#).unwrap_err().contains("networkName"));
        assert!(parse_config(r#"{"networkName":"n","peers":["a"]}"#).unwrap_err().contains("networkSecret"));
        assert!(parse_config(r#"{"networkName":"n","networkSecret":"s"}"#).unwrap_err().contains("peers"));
        assert!(parse_config(r#"{"networkName":"n","networkSecret":"s","peers":["  "]}"#)
            .unwrap_err()
            .contains("peers"));
        // 端口越界时退回默认，而不是接受一个连不上的值。
        let c = parse_config(r#"{"networkName":"n","networkSecret":"s","peers":["a"],"port":70000}"#).unwrap();
        assert_eq!(c.port, 5150);
    }

    #[test]
    fn render_toml_keeps_the_secret_out_of_argv_and_quotes_it_safely() {
        let mut c = good_config();
        c.network_secret = "a\"b\\c".to_string();
        let toml = render_toml(&c);
        assert!(toml.contains("network_name = \"stronghold-lan\""));
        assert!(toml.contains("network_secret = \"a\\\"b\\\\c\""));
        assert!(toml.contains("dhcp = true"), "没有地址就根本不会建 TUN");
        assert!(toml.contains(&format!("rpc_portal = \"{RPC_PORTAL}\"")));
        assert!(toml.contains("uri = \"tcp://sp.lain42.top:11010\""));
        assert!(toml.contains("listeners = []"), "客户端不监听，少一个被扫的面");
        // 密钥只在 TOML 里 —— 也就是说 `-c <file>` 是唯一的传递方式。
        assert!(!toml.contains("--network-secret"));
    }

    #[test]
    fn redact_removes_the_shared_secret() {
        assert_eq!(
            redact("peer joined secret=S3CRET-value-32-chars ok", "S3CRET-value-32-chars"),
            "peer joined secret=*** ok"
        );
        assert_eq!(redact("nothing to hide", ""), "nothing to hide");
    }

    #[test]
    fn describe_covers_the_whole_state_machine() {
        assert_eq!(describe(false, None, false, None, None, false).0, "disabled");
        assert_eq!(describe(false, Some("缺少 peers"), false, None, None, false).0, "error");
        assert_eq!(describe(true, None, true, Some(true), None, false).0, "up");
        assert_eq!(describe(true, None, true, Some(false), None, false).0, "degraded");
        assert_eq!(describe(true, None, true, None, None, false).0, "starting");
        assert_eq!(describe(true, None, false, None, None, false).0, "stopped");
    }

    #[test]
    fn describe_puts_the_administrator_hint_on_a_sidecar_that_died_on_startup() {
        // Windows 上真会发生的那个情形：spawn 成功、拿不到 TUN 网卡、秒退。错误文本只是一句退出码，
        // 所以提示**不能**靠匹配 EPERM 之类的字符串。
        let (state, _, hint) = describe(true, None, false, None, Some("easytier-core 退出，代码 1"), true);
        assert_eq!(state, "error");
        assert!(hint.contains("以管理员身份运行"), "{hint}");
        // 跑了很久之后才死的**不是**提权问题，就不能这么说。
        let (_, _, later) = describe(true, None, false, None, Some("easytier-core 退出，代码 1"), false);
        assert!(!later.contains("以管理员身份运行"), "{later}");
    }

    #[test]
    fn describe_never_carries_the_secret() {
        let json = serde_json::json!({
            "a": describe(true, None, true, Some(true), None, false).1,
            "b": describe(true, None, false, None, Some("EPERM"), true).2,
        })
        .to_string();
        assert!(!json.contains("S3CRET"));
    }

    #[test]
    fn core_binary_name_is_platform_specific() {
        if cfg!(windows) {
            assert_eq!(core_binary_name(), "easytier-core.exe");
        } else {
            assert_eq!(core_binary_name(), "easytier-core");
        }
    }

    #[test]
    fn candidates_is_best_first_and_covers_both_packaged_layouts() {
        let list = candidates(Path::new("/app"));
        assert_eq!(list[0].0, "安装目录");
        assert_eq!(list[0].1, PathBuf::from("/app/lan"));
        assert_eq!(list[1].1, PathBuf::from("/app/resources/lan"));
    }

    #[test]
    fn http_ok_reads_the_status_line_of_a_real_socket() {
        use std::net::TcpListener;
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in l.incoming().take(2) {
                let mut s = stream.unwrap();
                let mut buf = [0u8; 512];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
            }
        });
        assert!(http_ok("127.0.0.1", port, "/healthz", Duration::from_millis(800)));
    }

    #[test]
    fn http_ok_is_false_for_a_refused_connection_and_a_non_2xx() {
        use std::net::TcpListener;
        // 关掉的监听端口：连不上就是 false，不是 panic。
        let dead = {
            let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            l.local_addr().unwrap().port()
        };
        assert!(!http_ok("127.0.0.1", dead, "/healthz", Duration::from_millis(300)));

        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 512];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
            }
        });
        assert!(!http_ok("127.0.0.1", port, "/healthz", Duration::from_millis(800)));
    }

    #[test]
    fn handle_only_claims_the_lan_prefix_and_only_the_routes_it_has() {
        let mgr = LanManager::new(vec![], std::env::temp_dir());
        assert!(mgr.handle("GET", "/index.html").is_none(), "静态资源不是我们的");
        assert!(mgr.handle("GET", "/js/main.js").is_none());

        let (code, body) = mgr.handle("GET", "/lan/status").unwrap();
        assert_eq!(code, 200);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["state"], "disabled", "没打进 sidecar 的构建是 disabled，不是 error");

        // 查询串与结尾斜杠都不影响路由。
        assert_eq!(mgr.handle("GET", "/lan/status?x=1").unwrap().0, 200);
        assert_eq!(mgr.handle("GET", "/lan/status/").unwrap().0, 200);

        // 本壳不实现目录转发 —— 页面靠 directoryUrl 回落。
        assert_eq!(mgr.handle("GET", "/lan/rooms").unwrap().0, 404);
        // 未定义的路由也是 404，而不是 200 加一句"不知道"。
        assert_eq!(mgr.handle("GET", "/lan/nope").unwrap().0, 404);
        // up / down 只收 POST：GET 一个写操作不能改状态。
        assert_eq!(mgr.handle("GET", "/lan/up").unwrap().0, 404);
        assert_eq!(mgr.handle("POST", "/lan/down").unwrap().0, 200);
    }

    #[test]
    fn status_reports_a_broken_config_instead_of_pretending_there_is_none() {
        let dir = std::env::temp_dir().join(format!("sp-lan-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(CONFIG_FILE), "{ oops").unwrap();
        let mgr = LanManager::new(vec![("测试", dir.clone())], std::env::temp_dir());
        let (_, body) = mgr.handle("GET", "/lan/status").unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["state"], "error");
        assert!(v["message"].as_str().unwrap().contains("配置有误"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_config_without_its_binary_is_an_error_not_a_disabled() {
        let dir = std::env::temp_dir().join(format!("sp-lan-nocore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(CONFIG_FILE), GOOD).unwrap();
        let mgr = LanManager::new(vec![("测试", dir.clone())], std::env::temp_dir());
        let (_, body) = mgr.handle("GET", "/lan/status").unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["state"], "error");
        assert!(v["message"].as_str().unwrap().contains(core_binary_name()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
