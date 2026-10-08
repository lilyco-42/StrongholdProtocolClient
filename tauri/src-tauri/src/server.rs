//! Loopback static server for the packaged client — the Rust twin of `desktop/serve.mjs`.
//!
//! `tools/package-client.mjs` flattens the game server's mount layout into one directory (`www/`), so the shell only
//! has to serve plain files. std only: no HTTP crate, because the surface we need is GET/HEAD + Range + ETag +
//! keep-alive, and every rule here is pinned against the JS original by `test/tauri-parity.test.js` (a drift between
//! the two shells is exactly the kind of bug that only shows up for one of the two platforms).
//!
//! Rules mirrored, with the reason each exists:
//! - `/media/<no extension>` → `assets/audio/<…>.mp3` (`public/js/media.js` rewrites every audio URL that way so IDM
//!   and 迅雷 don't grab each BGM; a host that can't answer the alias ships a silent client).
//! - `assets|fonts|vendor|webfonts` get a day of cache, everything else `no-cache` (`index.html` must always revalidate).
//! - a pinned port keeps the page's origin, and Chromium scopes localStorage by origin — identity token, loadout,
//!   settings and the remembered server all live there and are lost if the origin moves.

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Loopback port the shell asks for first (same number as `desktop/serve.mjs` DEFAULT_PORT).
pub const DEFAULT_PORT: u16 = 47821;
/// Consecutive ports tried before letting the OS pick one.
pub const PORT_SEARCH: u16 = 16;

pub const MEDIA_PREFIX: &str = "/media/";
/// Order matters: it is the order the JS server probes, and `test/tauri-parity.test.js` pins it.
pub const AUDIO_EXTS: [&str; 7] = [".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav"];
const AUDIO_ROOT: [&str; 2] = ["assets", "audio"];
pub const LONG_CACHE_DIRS: [&str; 4] = ["assets", "fonts", "vendor", "webfonts"];
const LONG_CACHE: &str = "public, max-age=86400";
const NO_CACHE: &str = "no-cache";

/// Extension → Content-Type. Keep in step with `MIME` in `desktop/serve.mjs` (pinned by test).
pub fn mime_of(ext: &str) -> &'static str {
    match ext {
        ".html" | ".htm" => "text/html; charset=utf-8",
        ".js" | ".mjs" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".json" | ".map" => "application/json; charset=utf-8",
        ".webmanifest" => "application/manifest+json; charset=utf-8",
        ".txt" => "text/plain; charset=utf-8",
        ".md" => "text/markdown; charset=utf-8",
        ".csv" => "text/csv; charset=utf-8",
        ".xml" => "application/xml; charset=utf-8",
        ".atlas" => "text/plain; charset=utf-8",
        ".skel" | ".bin" => "application/octet-stream",
        ".wasm" => "application/wasm",
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".avif" => "image/avif",
        ".svg" => "image/svg+xml; charset=utf-8",
        ".ico" => "image/x-icon",
        ".mp3" => "audio/mpeg",
        ".ogg" | ".oga" | ".opus" => "audio/ogg",
        ".wav" => "audio/wav",
        ".m4a" => "audio/mp4",
        ".aac" => "audio/aac",
        ".webm" => "video/webm",
        ".mp4" => "video/mp4",
        ".woff2" => "font/woff2",
        ".woff" => "font/woff",
        ".otf" => "font/otf",
        ".ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

/// Percent-decode what we actually need (`%20`, `%25`, …) — the payload never uses anything fancier, and the JS
/// original uses decodeURIComponent. Anything invalid comes back as None, which the caller turns into a refusal.
pub fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                if i + 3 > bytes.len() {
                    return None;
                }
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                let v = u8::from_str_radix(hex, 16).ok()?;
                out.push(v);
                i += 3;
            }
            b'+' => {
                out.push(b'+');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// Split a request target into its path and query, the way `rawUrl.indexOf('?')` does in JS.
fn split_query(raw: &str) -> (&str, Option<&str>) {
    match raw.find('?') {
        Some(i) => (&raw[..i], Some(&raw[i..])),
        None => (raw, None),
    }
}

fn push_segments(root: &Path, segments: &[&str]) -> PathBuf {
    let mut p = root.to_path_buf();
    for s in segments {
        p.push(s);
    }
    p
}

/// `/js/main.js?v=2` → `<root>/js/main.js`, or None for anything that tries to leave the root (traversal, a dot
/// segment, a backslash, a NUL, an absolute-ness failure). Mirrors `resolveTarget`.
pub fn resolve_target(root: &Path, raw_url: &str) -> Option<PathBuf> {
    let (path_part, _) = split_query(raw_url);
    let decoded = percent_decode(path_part)?;
    if !decoded.starts_with('/') || decoded.contains('\0') || decoded.contains('\\') {
        return None;
    }
    let segments: Vec<&str> = decoded.split('/').filter(|s| !s.is_empty()).collect();
    if segments.iter().any(|s| *s == ".." || *s == "." || s.starts_with('.')) {
        return None;
    }
    if segments.is_empty() {
        return Some(root.to_path_buf());
    }
    let target = push_segments(root, &segments);
    let root_s = root.to_string_lossy();
    let target_s = target.to_string_lossy();
    if target_s != root_s.as_ref() && !target_s.starts_with(&format!("{root_s}{}", std::path::MAIN_SEPARATOR)) {
        return None;
    }
    Some(target)
}

/// `/media/bgm/act1?v=3` → `<root>/assets/audio/bgm/act1.mp3`, following AUDIO_EXTS order. None when the request is
/// not an alias, addresses a directory, or matches no file — the caller then answers 404 (never `<root>/media/…`).
pub fn resolve_media_path(root: &Path, raw_url: &str) -> Option<PathBuf> {
    let (path_part, _) = split_query(raw_url);
    let decoded = percent_decode(path_part)?;
    if !decoded.starts_with(MEDIA_PREFIX) {
        return None;
    }
    let rest = &decoded[MEDIA_PREFIX.len()..];
    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() || rest.ends_with('/') {
        return None;
    }
    if segments
        .iter()
        .any(|s| *s == ".." || *s == "." || s.starts_with('.') || s.ends_with('.'))
    {
        return None;
    }
    let last = *segments.last()?;
    let lower = last.to_lowercase();
    let given: &str = AUDIO_EXTS.iter().copied().find(|e: &&str| lower.ends_with(*e)).unwrap_or("");
    let stem = if given.is_empty() {
        last.to_string()
    } else {
        last[..last.len() - given.len()].to_string()
    };
    if stem.is_empty() {
        return None;
    }
    let audio_root = push_segments(root, &AUDIO_ROOT);
    let dir = if segments.len() == 1 {
        audio_root.clone()
    } else {
        push_segments(&audio_root, &segments[..segments.len() - 1])
    };
    let dir_s = dir.to_string_lossy();
    let ar_s = audio_root.to_string_lossy();
    if dir_s != ar_s.as_ref() && !dir_s.starts_with(&format!("{ar_s}{}", std::path::MAIN_SEPARATOR)) {
        return None;
    }
    let candidates: Vec<String> = if given.is_empty() {
        AUDIO_EXTS.iter().copied().map(|e| format!("{stem}{e}")).collect()
    } else {
        vec![format!("{stem}{given}")]
    };
    for c in candidates {
        let cand = dir.join(c);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Mirrors `cacheControlFor`: html always revalidates, the content-addressed top-level dirs get a day.
pub fn cache_control_for(ext: &str, segments: &[&str]) -> &'static str {
    if ext == ".html" || ext == ".htm" {
        return NO_CACHE;
    }
    if segments.len() > 1 && LONG_CACHE_DIRS.contains(&segments[0]) {
        return LONG_CACHE;
    }
    NO_CACHE
}

/// `bytes=a-b` clamped to the file, suffix form included. None = "no usable range" (the caller then answers 416 if a
/// Range header was present at all).
pub fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    let trimmed = header.trim();
    let rest = trimmed.strip_prefix("bytes=")?;
    let (a, b) = rest.split_once('-')?;
    if a.is_empty() && b.is_empty() {
        return None;
    }
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        let start = size.saturating_sub(n);
        (start, size.saturating_sub(1))
    } else {
        let start: u64 = a.parse().ok()?;
        let end: u64 = if b.is_empty() { size.saturating_sub(1) } else { b.parse().ok()? };
        (start, end)
    };
    if size == 0 || start > end || start >= size {
        return None;
    }
    Some((start, end.min(size - 1)))
}

/// The ETag the JS server builds: `"${size}-${mtimeMs floor}"` both in hex.
fn etag_for(size: u64, mtime_ms: u64) -> String {
    format!("\"{:x}-{:x}\"", size, mtime_ms)
}

/// RFC 1123 in UTC, the way `Date.toUTCString()` prints it (Node and Rust must agree or every conditional request misses).
fn http_date(d: SystemTime) -> String {
    const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const MONS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let secs = d.duration_since(UNIX_EPOCH).map(|x| x.as_secs()).unwrap_or(0) as i64;
    let mut days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    // 1970-01-01 was a Thursday: index 3 in DAYS (Mon-first).
    let dow = DAYS[((days.rem_euclid(7) + 3) % 7) as usize];
    let mut y: i64 = 1970;
    loop {
        let leap = |yy: i64| (yy % 4 == 0 && yy % 100 != 0) || yy % 400 == 0;
        let len = if leap(y) { 366 } else { 365 };
        if days >= len {
            days -= len;
            y += 1;
        } else if days < 0 {
            y -= 1;
            days += if leap(y) { 366 } else { 365 };
        } else {
            break;
        }
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let mlen: [i64; 12] = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut m = 0usize;
    let mut d = days;
    while m < 12 && d >= mlen[m] {
        d -= mlen[m];
        m += 1;
    }
    format!(
        "{dow}, {:02} {} {} {:02}:{:02}:{:02} GMT",
        d + 1,
        MONS[m],
        y,
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

/// What the shell wants to know for the boot probe: how many requests were served, over how many *connections*,
/// when the first one arrived and when `js/main.js` (the app's real entry) was served. Atomic counters, no locks
/// beyond that. `connections` is the number that proves connection reuse: with it, a page that asks for 24 files
/// costs a handful of sockets; without it, 24 sockets and 24 OS threads.
#[derive(Debug, Default)]
pub struct ServeStats {
    pub requests: AtomicUsize,
    pub connections: AtomicUsize,
    pub first_ms: AtomicU64,
    pub entry_ms: AtomicU64,
}

/// One request line plus its headers.
struct Req {
    method: String,
    raw_url: String,
    version: String,
    headers: Vec<(String, String)>,
}

impl Req {
    fn header(&self, name: &str) -> Option<String> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    }

    /// HTTP/1.1 means the connection stays open unless either side says `close`; HTTP/1.0 means the opposite.
    /// Same reading `desktop/serve.mjs` gets from Node's `http.Server` for free.
    fn reusable(&self) -> bool {
        let conn = self.header("connection").map(|v| v.to_ascii_lowercase()).unwrap_or_default();
        if conn.contains("close") {
            return false;
        }
        self.version.eq_ignore_ascii_case("HTTP/1.1") || conn.contains("keep-alive")
    }
}

/// One connection: serve requests on it until the client goes away or a response says this end is finished.
///
/// Why the connection is the unit and not the request: Node's `http.Server` (which is what the Electron shell runs)
/// keeps HTTP/1.1 connections alive, and the game asks for hundreds of files during a match. Answering one request
/// per socket meant this shell paid a TCP connect plus a fresh OS thread for every PNG, while the other shell paid
/// about six of each for the same page.
fn serve_connection(mut sock: TcpStream, root: &Path, stats: &Arc<ServeStats>, t0: std::time::Instant) {
    stats.connections.fetch_add(1, Ordering::Relaxed);
    // 5 s idle, not 15: measured off `desktop/serve.mjs` on 2026-10-08, Node answers the first request with
    // `Connection: keep-alive` + `Keep-Alive: timeout=5` and its keepAliveTimeout is 5 s. Same number here means the
    // two shells hold a socket for the same length of time — and the Electron shell has been shipping that value
    // to players, so "a browser reused a socket we had just closed" is not a new risk either. A browser that picks
    // a dead pooled socket retries the GET itself, and every request here is a GET.
    sock.set_read_timeout(Some(Duration::from_secs(5))).ok();
    sock.set_write_timeout(Some(Duration::from_secs(30))).ok();
    sock.set_nodelay(true).ok();
    // Reads go through the BufReader, writes through `sock`. The reader keeps its buffer between requests on
    // purpose: a second request already sitting in that buffer must not be thrown away when we loop.
    let clone = match sock.try_clone() {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut reader = BufReader::new(clone);

    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line.is_empty() {
            return;
        }
        let mut parts = line.split_whitespace();
        let mut headers: Vec<(String, String)> = Vec::new();
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h).is_err() {
                return;
            }
            let t = h.trim_end();
            if t.is_empty() {
                break;
            }
            if let Some((k, v)) = t.split_once(':') {
                headers.push((k.trim().to_lowercase(), v.trim().to_string()));
            }
        }
        let req = Req {
            method: parts.next().unwrap_or("").to_string(),
            raw_url: parts.next().unwrap_or("/").to_string(),
            version: parts.next().unwrap_or("HTTP/1.0").to_string(),
            headers,
        };
        match handle_request(&mut sock, root, stats, t0, &req) {
            Ok(true) => continue,
            Ok(false) | Err(_) => return,
        }
    }
}

/// Answer one request on a connection. `Ok(true)` = this socket may be reused for the next request.
fn handle_request(
    sock: &mut TcpStream,
    root: &Path,
    stats: &Arc<ServeStats>,
    t0: std::time::Instant,
    req: &Req,
) -> std::io::Result<bool> {
    let method = req.method.as_str();
    let raw_url = req.raw_url.as_str();
    let header = |name: &str| -> Option<String> { req.header(name) };
    let keep = req.reusable();
    // The exact bytes Node's http.Server answers with, measured off `desktop/serve.mjs` on 2026-10-08: when reusing
    // a socket it sends `Connection: keep-alive` + `Keep-Alive: timeout=5`, when closing just `Connection: close`.
    // `test/tauri-parity.test.js` starts the JS server and compares against what it really sends, so this cannot
    // quietly rot when Node changes its mind.
    let tail = if keep {
        "Connection: keep-alive\r\nKeep-Alive: timeout=5\r\n"
    } else {
        "Connection: close\r\n"
    };

    stats.requests.fetch_add(1, Ordering::Relaxed);
    if stats.first_ms.load(Ordering::Relaxed) == 0 {
        stats.first_ms.store(t0.elapsed().as_millis() as u64, Ordering::Relaxed);
    }
    if raw_url.starts_with("/js/main.js") {
        let cur = stats.entry_ms.load(Ordering::Relaxed);
        if cur == 0 {
            stats.entry_ms.store(t0.elapsed().as_millis() as u64, Ordering::Relaxed);
        }
    }

    if method != "GET" && method != "HEAD" {
        // A request body we never read would desynchronise whatever came next on this socket, so 405 ends it.
        let _ = write_plain(sock, "405 Method Not Allowed", "method not allowed", "Allow: GET, HEAD");
        return Ok(false);
    }

    let target = match resolve_target(root, raw_url) {
        Some(p) => p,
        None => {
            let _ = write_plain(sock, "403 Forbidden", "forbidden", "");
            return Ok(false);
        }
    };

    let is_media_alias = split_query(raw_url).0.starts_with(MEDIA_PREFIX);
    let mut abs = match resolve_media_path(root, raw_url) {
        Some(p) => p,
        None => {
            if is_media_alias {
                let _ = write_plain(sock, "404 Not Found", "not found", "");
                return Ok(false);
            }
            target
        }
    };

    let md = match std::fs::metadata(&abs) {
        Ok(m) if m.is_dir() => {
            abs = abs.join("index.html");
            match std::fs::metadata(&abs) {
                Ok(m2) => m2,
                Err(_) => {
                    let _ = write_plain(sock, "404 Not Found", "not found", "");
                    return Ok(false);
                }
            }
        }
        Ok(m) => m,
        Err(_) => {
            let _ = write_plain(sock, "404 Not Found", "not found", "");
            return Ok(false);
        }
    };
    if !md.is_file() {
        let _ = write_plain(sock, "404 Not Found", "not found", "");
        return Ok(false);
    }
    let size = md.len();
    let mtime_ms = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let rel = abs.strip_prefix(root).unwrap_or(Path::new("")).to_string_lossy().to_string();
    let segments: Vec<&str> = rel.split(std::path::MAIN_SEPARATOR).filter(|s| !s.is_empty()).collect();
    let ext = Path::new(&abs)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();

    let etag = etag_for(size, mtime_ms);
    let mut out = String::new();
    let mut body_range: Option<(u64, u64)> = None;
    let mut status = "200 OK";
    let mut length = size;

    if header("if-none-match").as_deref() == Some(etag.as_str()) {
        status = "304 Not Modified";
        length = 0;
    } else if let Some(range_hdr) = header("range") {
        match parse_range(&range_hdr, size) {
            Some((s, e)) => {
                status = "206 Partial Content";
                body_range = Some((s, e));
                length = e - s + 1;
                out.push_str(&format!("Content-Range: bytes {s}-{e}/{size}\r\n"));
            }
            // No body, exactly like serve.mjs's 416 branch. Answering a 416 with the whole file was survivable
            // only because every response used to close the socket: on a reused connection a body the client does
            // not expect desynchronises the *next* response, so the framing has to be right here.
            None => {
                status = "416 Range Not Satisfiable";
                length = 0;
                out.push_str(&format!("Content-Range: bytes */{size}\r\n"));
            }
        }
    }

    out.push_str(&format!("Content-Type: {}\r\n", mime_of(&ext)));
    out.push_str(&format!("Cache-Control: {}\r\n", cache_control_for(&ext, &segments)));
    out.push_str(&format!("ETag: {etag}\r\n"));
    out.push_str(&format!(
        "Last-Modified: {}\r\n",
        http_date(UNIX_EPOCH + Duration::from_millis(mtime_ms))
    ));
    out.push_str("Accept-Ranges: bytes\r\n");
    out.push_str("X-Content-Type-Options: nosniff\r\n");
    if status != "304 Not Modified" {
        out.push_str(&format!("Content-Length: {length}\r\n"));
    }
    out.push_str(tail);
    out.push_str("\r\n");

    let head = format!("HTTP/1.1 {status}\r\n{out}");
    sock.write_all(head.as_bytes())?;
    if length == 0 || method == "HEAD" {
        sock.flush()?;
        return Ok(keep);
    }
    let send = |sock: &mut TcpStream, abs: &Path, rng: Option<(u64, u64)>| -> std::io::Result<()> {
        let mut f = std::fs::File::open(abs)?;
        if let Some((s, _e)) = rng {
            f.seek(SeekFrom::Start(s))?;
        }
        let mut buf = [0u8; 128 * 1024];
        let mut left = length as usize;
        while left > 0 {
            let want = left.min(buf.len());
            let n = match f.read(&mut buf[..want]) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            sock.write_all(&buf[..n])?;
            left -= n;
        }
        Ok(())
    };
    send(sock, &abs, body_range)?;
    sock.flush()?;
    Ok(keep)
}

/// A one-line text answer (403 / 404 / 405). These always end the connection, even though the framing would allow
/// reuse: `main.rs`'s "is 47821 already ours?" probe reads to EOF, and a not-found inside a locally-served payload
/// is rare enough that one reconnect is not the cost worth optimising (Node would keep that socket alive).
fn write_plain(sock: &mut TcpStream, status: &str, body: &str, extra: &str) -> std::io::Result<()> {
    let msg = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(msg.as_bytes())?;
    sock.flush()
}

/// Bind and serve on a background thread. Returns the bound port (the caller builds the window URL from it, and the
/// whole point of pinning is that the page's origin — and therefore its localStorage — stays put across launches).
pub fn spawn_server(root: PathBuf, stats: Arc<ServeStats>) -> std::io::Result<(u16, thread::JoinHandle<()>)> {
    let mut listener: Option<TcpListener> = None;
    if DEFAULT_PORT <= u16::MAX - PORT_SEARCH {
        for i in 0..PORT_SEARCH {
            let p = DEFAULT_PORT + i;
            match TcpListener::bind(("127.0.0.1", p)) {
                Ok(l) => {
                    listener = Some(l);
                    break;
                }
                Err(_) => continue,
            }
        }
    }
    let l = match listener {
        Some(l) => l,
        None => TcpListener::bind(("127.0.0.1", 0))?,
    };
    let port = l.local_addr()?.port();
    let t0 = std::time::Instant::now();
    let h = thread::spawn(move || {
        for sock in l.incoming().flatten() {
            let root = root.clone();
            let stats = Arc::clone(&stats);
            thread::spawn(move || serve_connection(sock, &root, &stats, t0));
        }
    });
    Ok((port, h))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    // 显式再导入一遍：连接级测试要 read / write_all / flush，而 `use super::*` 能不能带进父模块的私有 import
    // 不是该赌的东西（显式的盖掉 glob，重复也不报错）。
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::{Duration, UNIX_EPOCH};

    /// 每个用例一个独立目录：并行跑的时候不能互相踩。
    fn sandbox(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("sp-tauri-test-{}-{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(p.join("assets/audio/bgm")).unwrap();
        p
    }

    #[test]
    fn resolve_target_refuses_every_way_out_of_the_root() {
        let root = PathBuf::from("/base/www");
        assert_eq!(resolve_target(&root, "/js/main.js"), Some(PathBuf::from("/base/www/js/main.js")));
        assert_eq!(resolve_target(&root, "/"), Some(root.clone()));
        assert_eq!(resolve_target(&root, "/js/main.js?v=2"), Some(PathBuf::from("/base/www/js/main.js")));
        assert!(resolve_target(&root, "/../etc/passwd").is_none(), "traversal");
        assert!(resolve_target(&root, "/a/../../b").is_none(), "double traversal");
        assert!(resolve_target(&root, "/.hidden").is_none(), "dotfile");
        assert!(resolve_target(&root, "relative/path").is_none(), "must be absolute");
        assert!(resolve_target(&root, "/with%5Cbackslash").is_none(), "backslash is how Windows sneaks around checks");
        assert!(resolve_target(&root, "/a%00b").is_none(), "NUL after decoding");
        assert!(resolve_target(&root, "/bad%zz").is_none(), "undecodable percent");
    }

    #[test]
    fn media_alias_resolves_to_the_real_audio_file_in_the_declared_order() {
        let root = sandbox("media-order");
        let bgm = root.join("assets/audio/bgm");
        fs::write(bgm.join("act1.ogg"), "ogg").unwrap();
        fs::write(bgm.join("act1.mp3"), "mp3").unwrap();
        // AUDIO_EXTS 的第一项赢，跟 JS 那份一致
        assert_eq!(resolve_media_path(&root, "/media/bgm/act1"), Some(bgm.join("act1.mp3")));
        // 明确给了扩展名就只找那一个
        assert_eq!(resolve_media_path(&root, "/media/bgm/act1.ogg"), Some(bgm.join("act1.ogg")));
        assert_eq!(resolve_media_path(&root, "/media/bgm/act1.wav"), None);
        // 带查询、带子目录、别名不在 audio 根下
        assert_eq!(resolve_media_path(&root, "/media/bgm/act1?v=3"), Some(bgm.join("act1.mp3")));
        assert_eq!(resolve_media_path(&root, "/media/bgm/"), None, "trailing slash addresses a directory");
        assert_eq!(resolve_media_path(&root, "/media/../passwd"), None);
        assert_eq!(resolve_media_path(&root, "/js/main.js"), None, "not an alias at all");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_rules_match_the_js_shell() {
        assert_eq!(cache_control_for(".html", &["index.html"]), NO_CACHE);
        assert_eq!(cache_control_for(".js", &["index.html"]), NO_CACHE);
        assert_eq!(cache_control_for(".png", &["assets", "char", "a.png"]), LONG_CACHE);
        assert_eq!(cache_control_for(".js", &["vendor", "pixi.min.js"]), LONG_CACHE);
        assert_eq!(cache_control_for(".css", &["webfonts", "google", "g.css"]), LONG_CACHE);
        assert_eq!(cache_control_for(".json", &["data", "chess.json"]), NO_CACHE);
        assert_eq!(cache_control_for(".js", &["data.js"]), NO_CACHE, "one segment = not a content-addressed dir");
    }

    #[test]
    fn ranges_are_clamped_the_way_browsers_send_them() {
        assert_eq!(parse_range("bytes=0-999", 854143), Some((0, 999)));
        assert_eq!(parse_range("bytes=5-", 100), Some((5, 99)));
        assert_eq!(parse_range("bytes=-500", 854143), Some((853643, 854142)), "suffix form");
        assert_eq!(parse_range("bytes=900-1200", 1000), Some((900, 999)), "clamp the end");
        assert_eq!(parse_range("bytes=1000-", 1000), None, "start at EOF is unsatisfiable");
        assert_eq!(parse_range("bytes=", 1000), None);
        assert_eq!(parse_range("bytes=5-2", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
        assert_eq!(parse_range("", 1000), None);
        assert_eq!(parse_range("bytes=0-10", 0), None, "empty file");
    }

    #[test]
    fn etag_and_dates_are_byte_identical_with_node() {
        assert_eq!(etag_for(854143, 1730000000000), "\"d087f-192cc091400\"");
        // 这几条的期望值是从 `new Date(ms).toUTCString()` 抄下来的（Node 与 Rust 的格式必须一致，否则条件请求全 miss）
        let cases = [
            (0u64, "Thu, 01 Jan 1970 00:00:00 GMT"),
            (1730000000000, "Sun, 27 Oct 2024 03:33:20 GMT"),
            (1791406800000, "Wed, 07 Oct 2026 21:00:00 GMT"),
            (951868800000, "Wed, 01 Mar 2000 00:00:00 GMT"),
            (1709208000000, "Thu, 29 Feb 2024 12:00:00 GMT"),
        ];
        for (ms, want) in cases {
            assert_eq!(http_date(UNIX_EPOCH + Duration::from_millis(ms)), want, "ms={ms}");
        }
    }

    #[test]
    fn mime_table_has_no_silent_holes() {
        // 骨骼、图集、字体、音频这几类一旦落到 octet-stream，Spine 与 woff2 就会静默失败
        assert_eq!(mime_of(".skel"), "application/octet-stream");
        assert_eq!(mime_of(".atlas"), "text/plain; charset=utf-8");
        assert_eq!(mime_of(".woff2"), "font/woff2");
        assert_eq!(mime_of(".mp3"), "audio/mpeg");
        assert_eq!(mime_of(".js"), "text/javascript; charset=utf-8");
        assert_eq!(mime_of(".JSON"), "application/octet-stream", "caller lowercases; this pins the contract");
        assert_eq!(mime_of(".png"), "image/png");
    }

    /// Accumulate bytes until `needle` shows up, or the socket gives nothing more. Deliberately not an HTTP parser:
    /// the question in these tests is "does a second response reach this same socket", and a plain substring hunt
    /// answers that without re-implementing framing (which would be a second thing to get wrong).
    fn read_until(sock: &mut TcpStream, needle: &str) -> String {
        let mut got = String::new();
        let mut buf = [0u8; 4096];
        for _ in 0..64 {
            if got.contains(needle) {
                break;
            }
            match sock.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => got.push_str(&String::from_utf8_lossy(&buf[..n])),
                Err(_) => break,
            }
        }
        got
    }

    fn ask(sock: &mut TcpStream, request: &str) {
        sock.write_all(request.as_bytes()).ok();
        sock.flush().ok();
    }

    /// Everything still in flight up to EOF, after the response head was already matched. A connection the server
    /// closed can still hand over the tail bytes of its last answer — but never another status line, which is the
    /// part these assertions are about.
    fn drain_to_eof(sock: &mut TcpStream) -> String {
        read_until(sock, "___a_marker_no_response_ever_contains___")
    }

    /// The whole point of serving by connection: one socket carries many requests, so a page that asks for
    /// hundreds of files does not pay a TCP connect and an OS thread each.
    #[test]
    fn a_connection_carries_more_than_one_request() {
        let root = sandbox("keepalive");
        fs::write(root.join("a.html"), "AAAAAAAA").unwrap();
        fs::write(root.join("b.html"), "BBBBBBBB").unwrap();
        let stats = Arc::new(ServeStats::default());
        let (port, _h) = spawn_server(root.clone(), Arc::clone(&stats)).unwrap();
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).ok();

        ask(&mut s, "GET /a.html HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        let got = read_until(&mut s, "200 OK");
        assert!(got.contains("200 OK"), "第一个请求就没回来：{got:?}");
        assert!(got.contains("Content-Length: 8"));
        // 这两行是照 Node 实测的答复钉的：desktop/serve.mjs 续用连接时发 `Connection: keep-alive` +
        // `Keep-Alive: timeout=5`，两个壳必须一个样（test/tauri-parity.test.js 会真的起 JS 那份服务对读）。
        assert!(got.contains("Connection: keep-alive"), "续用时该说 keep-alive：{got:?}");
        assert!(got.contains("Keep-Alive: timeout=5"), "空闲秒数要与 Node 一致：{got:?}");

        ask(&mut s, "GET /b.html HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        let second = read_until(&mut s, "BBBBBBBB");
        assert!(second.contains("200 OK"), "第二个请求没回来（连接被当成一次性了？）：{second:?}");
        assert!(!second.contains("Connection: close"), "keep-alive 的回答里不该出现 close：{second:?}");

        ask(&mut s, "GET /a.html HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        // 找 "Connection: close" 而不是 "200 OK"：前两个 keep-alive 回答的正文可能还有几个字节没读走，
        // 用状态行当针会先撞上它们。这个头只会出现在要求关闭的这一条回答里。
        let closed = read_until(&mut s, "Connection: close");
        assert!(closed.contains("200 OK"), "{closed:?}");
        assert!(closed.contains("Connection: close"), "对方要求 close 就必须照办：{closed:?}");
        // after closing, the client sees EOF: no further answer arrives on this socket
        assert!(!drain_to_eof(&mut s).contains("HTTP/1.1"), "连接该已经断了，却还收到了新的回答");
        assert_eq!(stats.requests.load(Ordering::Relaxed), 3, "三个请求");
        assert_eq!(stats.connections.load(Ordering::Relaxed), 1, "但它们必须走同一条连接");
        let _ = fs::remove_dir_all(&root);
    }

    /// HTTP/1.0 has no default keep-alive, and a method we cannot frame a body for must end the connection —
    /// otherwise the next response on that socket would be read as the tail of this one.
    #[test]
    fn http10_and_post_end_the_connection() {
        let root = sandbox("close-cases");
        fs::write(root.join("index.html"), "AAAAAAAA").unwrap();
        let stats = Arc::new(ServeStats::default());
        let (port, _h) = spawn_server(root.clone(), Arc::clone(&stats)).unwrap();

        let mut a = TcpStream::connect(("127.0.0.1", port)).unwrap();
        a.set_read_timeout(Some(Duration::from_secs(5))).ok();
        ask(&mut a, "GET /index.html HTTP/1.0\r\n\r\n");
        let got = read_until(&mut a, "200 OK");
        assert!(got.contains("Connection: close"), "1.0 默认不续用：{got:?}");
        assert!(!drain_to_eof(&mut a).contains("HTTP/1.1"), "1.0 之后连接应该断了");

        let mut b = TcpStream::connect(("127.0.0.1", port)).unwrap();
        b.set_read_timeout(Some(Duration::from_secs(5))).ok();
        // Content-Length: 0 —— 带正文的 POST 会留下没读走的字节，那时关闭连接可能吃掉了客户端这一侧的断言，
        // 而这里要证明的是"405 之后不再复用这条连接"。
        ask(&mut b, "POST /index.html HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n");
        let got = read_until(&mut b, "405");
        assert!(got.contains("405 Method Not Allowed"), "{got:?}");
        assert!(got.contains("Connection: close"), "读过的请求体之后的回答必须结束连接：{got:?}");
        assert!(!drain_to_eof(&mut b).contains("HTTP/1.1"));
        let _ = fs::remove_dir_all(&root);
    }

    /// A 416 must not carry a body: on a reused socket the client would read the file bytes as the next response.
    #[test]
    fn unsatisfiable_range_answers_without_a_body() {
        let root = sandbox("range416");
        fs::write(root.join("a.html"), "AAAAAAAA").unwrap();
        let stats = Arc::new(ServeStats::default());
        let (port, _h) = spawn_server(root.clone(), Arc::clone(&stats)).unwrap();
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).ok();
        ask(&mut s, "GET /a.html HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=99999-\r\n\r\n");
        let got = read_until(&mut s, "416");
        assert!(got.contains("416 Range Not Satisfiable"), "{got:?}");
        assert!(got.contains("Content-Range: bytes */8"), "{got:?}");
        assert!(got.contains("Content-Length: 0"), "416 不许带正文：{got:?}");
        assert!(!got.contains("AAAAAAAA"), "正文漏出去了：{got:?}");
        // and the same socket is still usable for the next request
        ask(&mut s, "GET /a.html HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        let again = read_until(&mut s, "AAAAAAAA");
        assert!(again.contains("200 OK"), "416 之后连接上的下一个请求读不到自己的正文：{again:?}");
        let _ = fs::remove_dir_all(&root);
    }
}
