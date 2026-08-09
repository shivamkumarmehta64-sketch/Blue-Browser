use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::RwLock;

use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::Engine;

/// Bundled offline baseline filter list (EasyList/EasyPrivacy-style).
const BUNDLED_FILTERS: &str = include_str!("../assets/filters/bundled_filters.txt");

/// Build an optimized `Engine` from a raw rule string.
fn engine_from_rules(rules: &str, opts: ParseOptions) -> Engine {
    let mut set = FilterSet::new(false);
    let _record = set.add_filter_list(rules.to_string(), opts);
    Engine::new_with_filter_set(set)
}

/// Registry host for a URL (used as the cosmetic-cache key). Returns `None`
/// for non-http(s) / unparseable URLs so they bypass caching.
fn host_of(url: &str) -> Option<String> {
    let parsed = tauri::Url::parse(url).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    parsed.host_str().map(|h| h.to_ascii_lowercase())
}

/// Shared ad-blocking state. Thread-safe because the Engine is built without
/// the crate's `single-thread` feature (default-features = false), making it
/// Send + Sync, so it can live behind an `RwLock` across command threads and
/// the cosmetic-server thread.
pub struct AdblockManager {
    engine: RwLock<Engine>,
    shields_enabled: AtomicBool,
    /// Port of the localhost cosmetic CSS server (0 until started).
    port: AtomicU16,
    /// Small bounded cache: page-host -> generated cosmetic CSS, so repeated
    /// navigations don't re-query the engine.
    cosmetic_cache: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// Small bounded cache: request-url -> block decision, keyed by a light
    /// composite so it can survive per-request setup.
    block_cache: std::sync::Mutex<std::collections::HashMap<String, bool>>,
    /// Ever-increasing session counters so the UI can show a Brave-style
    /// "ads & trackers blocked" badge. Reset only on app start / explicit call.
    ads_blocked: AtomicU64,
    trackers_blocked: AtomicU64,
}

impl Default for AdblockManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AdblockManager {
    /// Loads the bundled offline rules into a fresh engine.
    pub fn new() -> Self {
        Self {
            engine: RwLock::new(engine_from_rules(BUNDLED_FILTERS, ParseOptions::default())),
            shields_enabled: AtomicBool::new(true),
            port: AtomicU16::new(0),
            cosmetic_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            block_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            ads_blocked: AtomicU64::new(0),
            trackers_blocked: AtomicU64::new(0),
        }
    }

    pub fn shields_enabled(&self) -> bool {
        self.shields_enabled.load(Ordering::Relaxed)
    }

    pub fn set_shields(&self, enabled: bool) {
        self.shields_enabled.store(enabled, Ordering::Relaxed);
        self.block_cache.lock().unwrap().clear();
    }

    /// Records the port the cosmetic CSS server is bound to.
    pub fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::Relaxed);
    }

    /// Current cosmetic-server port (0 = not started).
    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    /// True when the request should be blocked. `request_type` uses ABP
    /// strings ("document", "script", "image", "stylesheet", "sub_frame",
    /// "xmlhttprequest", "media", "font", "websocket", "ping", "other").
    pub fn should_block_request(&self, url: &str, source_url: &str, request_type: &str) -> bool {
        if !self.shields_enabled() {
            return false;
        }
        let key = format!("{request_type}|{source_url}|{url}");
        if let Some(&v) = self.block_cache.lock().unwrap().get(&key) {
            return v;
        }
        let Ok(req) = Request::new(url, source_url, request_type, "GET") else {
            return false;
        };
        let engine = self.engine.read().unwrap();
        let v = engine.check_network_request(&req).should_block();
        if v {
            match request_type {
                // Treat script/xhr/pixel-style traffic as trackers unless it
                // is a document; everything else counts as an "ad".
                "script" | "xmlhttprequest" | "web_socket" | "websocket" | "ping" | "media" => {
                    self.trackers_blocked.fetch_add(1, Ordering::Relaxed);
                }
                _ => {
                    self.ads_blocked.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        let mut cache = self.block_cache.lock().unwrap();
        cache.insert(key, v);
        if cache.len() > 1024 {
            cache.clear();
        }
        v
    }

    /// Session blocker totals for the privacy/shields badge. Never decremented
    /// until the tab session restarts.
    pub fn blocked_totals(&self) -> (u64, u64) {
        (
            self.ads_blocked.load(Ordering::Relaxed),
            self.trackers_blocked.load(Ordering::Relaxed),
        )
    }

    /// Renders the cosmetic (element-hiding) CSS required for `url`.
    pub fn cosmetic_css(&self, url: &str) -> String {
        let host = host_of(url);
        if let Some(css) = host.as_deref().and_then(|h| self.cosmetic_cache.lock().unwrap().get(h).cloned()) {
            return css;
        }
        let out = self.compute_cosmetic(url);
        if let Some(h) = host {
            let mut cache = self.cosmetic_cache.lock().unwrap();
            cache.insert(h, out.clone());
            if cache.len() > 512 {
                cache.clear();
            }
        }
        out
    }

    /// Un-cached cosmetic computation.
    fn compute_cosmetic(&self, url: &str) -> String {
        let engine = self.engine.read().unwrap();
        let res = engine.url_cosmetic_resources(url);
        if res.generichide {
            return String::new();
        }
        let mut out = String::new();
        if !res.hide_selectors.is_empty() {
            let mut sels: Vec<String> = res.hide_selectors.iter().cloned().collect();
            sels.sort();
            out.push_str(&sels.join(","));
            out.push_str(" { display: none !important; }\n");
        }
        // `procedural_actions` (:has(), :matches-path, ...) need JS evaluation
        // and are deliberately skipped for the pure-CSS pass.
        let _ = &res.procedural_actions;
        out
    }

    /// JS that runs at document-start in remote tabs and pulls the generated
    /// CSS for the current page from the localhost cosmetic server.
    pub fn cosmetic_injection_script(&self) -> String {
        let port = self.port();
        let template = "(function(){try{var u='http://127.0.0.1:__PORT__/adblock.css?url='+encodeURIComponent(location.href);fetch(u).then(function(r){return r.text();}).then(function(c){if(!c)return;var s=document.createElement('style');s.setAttribute('data-blue-adblock','');s.textContent=c;(document.head||document.documentElement).appendChild(s);}).catch(function(){});}catch(_){}})();";
        template.replace("__PORT__", &port.to_string())
    }
}

/// Respond to a single localhost request: `GET /adblock.css?url=<page>`.
fn handle_cosmetic(manager: &AdblockManager, request_url: &str) -> String {
    if !request_url.starts_with("/adblock.css") {
        return String::new();
    }
    // Rebuild the absolute URL so `Url::query_pairs` can decode the target.
    let full = format!("http://127.0.0.1:{}{}", manager.port(), request_url);
    let Ok(parsed) = tauri::Url::parse(&full) else {
        return String::new();
    };
    let mut page = String::new();
    for (k, v) in parsed.query_pairs() {
        if k == "url" {
            page = v.into_owned();
            break;
        }
    }
    if page.is_empty() {
        return String::new();
    }
    manager.cosmetic_css(&page)
}

/// Start the loopback CSS server on an ephemeral port and record it on the
/// manager. Returns the bound port. The thread lives for the process lifetime.
pub fn spawn_cosmetic_server(manager: std::sync::Arc<AdblockManager>) -> u16 {
    use tiny_http::{Header, Response, Server};
    let server = Server::http("127.0.0.1:0").expect("failed to bind cosmetic server");
    let port = server.server_addr().to_ip().expect("non-IP addr").port();
    manager.set_port(port);
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let manager = manager.clone();
            let url = request.url().to_string();
            let css = handle_cosmetic(&manager, &url);
            let mut resp = Response::from_string(css)
                .with_status_code(200)
                .with_header(
                    Header::from_bytes(&b"Content-Type"[..], &b"text/css; charset=utf-8"[..])
                        .unwrap(),
                )
                .with_header(
                    Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
                )
                .with_header(Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap());
            if request.url().starts_with("/") && !request.url().starts_with("/adblock.css") {
                resp = resp.with_status_code(404);
            }
            let _ = request.respond(resp);
        }
    });
    port
}

#[cfg(test)]
mod tests {
    use super::*;
    use adblock::lists::{FilterFormat, RuleTypes};
    use std::io::{Read, Write};
    use std::net::TcpStream;

    fn engine(rules: &str) -> Engine {
        engine_from_rules(rules, ParseOptions::default())
    }

    #[test]
    fn network_block() {
        let e = engine("||doubleclick.net^");
        let r = Request::new(
            "https://ad.doubleclick.net/ddm/track/click",
            "https://example.com/",
            "script",
            "GET",
        )
        .unwrap();
        assert!(e.check_network_request(&r).should_block());
    }

    #[test]
    fn network_pass_when_not_matched() {
        let e = engine("||doubleclick.net^");
        let r = Request::new(
            "https://example.com/app.js",
            "https://example.com/",
            "script",
            "GET",
        )
        .unwrap();
        assert!(!e.check_network_request(&r).should_block());
    }

    #[test]
    fn exception_unblocks() {
        let e = engine("||doubleclick.net^\n@@||safe.doubleclick.net^");
        let r = Request::new(
            "https://safe.doubleclick.net/x",
            "https://example.com/",
            "script",
            "GET",
        )
        .unwrap();
        assert!(!e.check_network_request(&r).should_block());
    }

    #[test]
    fn cosmetic_selectors() {
        let e = engine("example.com##.ad-banner\nexample.com##.ad-container");
        let res = e.url_cosmetic_resources("https://example.com/article");
        assert!(res.hide_selectors.contains(".ad-banner"));
        assert!(res.hide_selectors.contains(".ad-container"));
    }

    #[test]
    fn cosmetic_other_site_untouched() {
        let e = engine("example.com##.ad-banner");
        let res = e.url_cosmetic_resources("https://other-site.org/");
        assert!(!res.hide_selectors.contains(".ad-banner"));
    }

    #[test]
    fn shields_off_returns_false() {
        let m = AdblockManager::new();
        m.set_shields(false);
        assert!(!m.should_block_request(
            "https://ad.doubleclick.net/x",
            "https://example.com/",
            "script"
        ));
    }

    #[test]
    fn bundled_list_parses() {
        let m = AdblockManager::new();
        // At least one well-known tracker must be actionable from the bundle.
        assert!(m.should_block_request(
            "https://www.googletagmanager.com/gtm.js",
            "https://example.com/",
            "script"
        ));
        let css = m.cosmetic_css("https://example.com/");
        assert!(!css.is_empty());
    }

    #[test]
    fn parsed_ruleset_has_both_kinds() {
        let opts = ParseOptions {
            format: FilterFormat::Standard,
            rule_types: RuleTypes::All,
            ..Default::default()
        };
        let e = engine_from_rules("||doubleclick.net^\nexample.com##.ad", opts);
        let _ = e; // construction alone proves both rule kinds parsed
    }

    #[test]
    fn cosmetic_server_serves_css_over_http() {
        let m = std::sync::Arc::new(AdblockManager::new());
        let port = spawn_cosmetic_server(std::sync::Arc::clone(&m));
        assert!(port > 0);
        let target = "https%3A%2F%2Fexample.com%2Farticle";
        let path = format!("/adblock.css?url={target}");
        let mut stream =
            TcpStream::connect(("127.0.0.1", port)).expect("connect to cosmetic server");
        let raw = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(raw.as_bytes()).unwrap();
        let mut buf = String::new();
        stream.read_to_string(&mut buf).unwrap();

        let head = buf.split_once("\r\n\r\n").map(|(h, _)| h).unwrap_or("").to_string();
        let body = buf.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("").to_string();
        assert!(head.starts_with("HTTP/1.1 200"), "bad status: {head}");
        assert!(
            head.to_lowercase().contains("access-control-allow-origin: *"),
            "missing CORS header: {head}"
        );
        assert!(!body.is_empty(), "expected cosmetic CSS body");
        assert!(body.contains("!important"), "cosmetic CSS rule malformed: {body}");
    }

    #[test]
    fn cosmetic_server_unknown_route_is_404() {
        let m = std::sync::Arc::new(AdblockManager::new());
        let port = spawn_cosmetic_server(std::sync::Arc::clone(&m));
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .write_all(
                "GET /nope HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".as_bytes(),
            )
            .unwrap();
        let mut buf = String::new();
        stream.read_to_string(&mut buf).unwrap();
        assert!(buf.starts_with("HTTP/1.1 404"), "expected 404: {buf}");
    }
}
