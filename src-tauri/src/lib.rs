mod adblock;
mod mcp;

use adblock::AdblockManager;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::Arc;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Webview, WebviewBuilder,
    WebviewUrl,
};

/// Persistent JSON blob store — one file per key in the app-data dir.
/// Covers settings, quick links, bookmarks, history and notes from the UI.
struct Store {
    dir: PathBuf,
}

impl Store {
    fn new(app: &AppHandle) -> Self {
        Store {
            dir: app.path().app_data_dir().expect("no app data dir"),
        }
    }

    fn path(&self, key: &str) -> PathBuf {
        let key = key.replace(['/', '\\', '.', ' ', '\0'], "_");
        self.dir.join(format!("{key}.json"))
    }

    fn read(&self, key: &str) -> Value {
        let _ = fs::create_dir_all(&self.dir);
        match fs::read_to_string(self.path(key)) {
            Ok(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        }
    }

    fn write(&self, key: &str, value: Value) -> bool {
        let _ = fs::create_dir_all(&self.dir);
        match serde_json::to_string(&value) {
            Ok(s) => fs::write(self.path(key), s).is_ok(),
            Err(_) => false,
        }
    }
}

/// Load the JSON blob stored under `key` (or `null` if absent).
#[tauri::command]
fn load_store(app: AppHandle, key: String) -> Value {
    Store::new(&app).read(&key)
}

/// Persist a JSON blob under `key`.
#[tauri::command]
fn save_store(app: AppHandle, key: String, value: Value) -> bool {
    Store::new(&app).write(&key, value)
}

/// Aggregated payload for the New Tab page in a single round-trip:
/// quick links, bookmarks, reading list, plus recent history items
/// and counts used by the home stats strip.
#[tauri::command]
fn home_data(app: AppHandle) -> Value {
    let store = Store::new(&app);
    let links = store.read("quicklinks");
    let bookmarks = store.read("bookmarks");
    let reading = store.read("reading");
    let history = store.read("history");
    let recents: Vec<Value> = match &history {
        Value::Array(items) => items.iter().take(4).cloned().collect(),
        _ => Vec::new(),
    };
    let bookmark_count = match &bookmarks {
        Value::Array(a) => a.len(),
        _ => 0,
    };
    let history_count = match &history {
        Value::Array(a) => a.len(),
        _ => 0,
    };
    let reading_count = match &reading {
        Value::Array(a) => a.len(),
        _ => 0,
    };
    serde_json::json!({
        "links": links,
        "bookmarks": bookmarks,
        "reading": reading,
        "recent": recents,
        "stats": {
            "bookmarks": bookmark_count,
            "history": history_count,
            "reading": reading_count,
        },
    })
}

/// Background-window style was dropped (June '26): tabs now render as child
/// webviews attached to the `main` window, positioned over the content area,
/// each wired with ad blocking + cosmetic-CSS injection + page-info reporting.

/// Tracks the live child webviews (one per tab id).
#[derive(Default)]
struct TabHost {
    views: Mutex<HashMap<u64, Webview>>,
}

/// Pending `eval_in_tab_str` requests awaiting a result from their page's
/// injected script, keyed by request id. The page script calls back into the
/// `eval_resolve` command once it has computed the value.
#[derive(Default)]
struct EvalRegistry {
    pending: Mutex<HashMap<u64, std::sync::mpsc::Sender<String>>>,
    next_id: Mutex<u64>,
}

/// Open (or re-navigate) the page for `tab_id` as a child webview of the main
/// window at the given content bounds (logical px, relative to the window).
#[tauri::command]
async fn open_url(
    app: AppHandle,
    tab_id: u64,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    adblock: tauri::State<'_, Arc<AdblockManager>>,
) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("only http(s) URLs are supported".into());
    }
    let parsed: tauri::Url = tauri::Url::parse(&url).map_err(|e| e.to_string())?;

    let host = app.state::<TabHost>();
    if let Some(view) = host.views.lock().unwrap().get(&tab_id).cloned() {
        view.navigate(parsed).map_err(|e| e.to_string())?;
        let _ = view.set_bounds(Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(w, h).into(),
        });
        let _ = view.show();
        let views = host.views.lock().unwrap();
        for (id, other) in views.iter() {
            if *id != tab_id {
                let _ = other.hide();
            }
        }
        return Ok(());
    }

    // Build a fresh child webview on the main window.
    let main_window = app
        .get_webview_window("main")
        .ok_or("main window not found")?
        .as_ref()
        .window();
    let label = format!("tab-{tab_id}");
    let manager = Arc::clone(adblock.inner());
    let emit_app = app.clone();
    let cosmetic = manager.cosmetic_injection_script();
    // Injected once per page load: reports URL/title back to the chrome, and
    // hooks client-side routing (pushState/replaceState/hash/popstate) so SPA
    // navigations keep the omnibox and back-stack in sync without a reload.
    let script = format!(
        "{cosmetic}(function(){{function r(){{try{{window.__TAURI_INTERNALS__.invoke('set_page_info',{{tabId:{tab_id},url:location.href,title:document.title}});}}catch(e){{}}}}r();document.addEventListener('DOMContentLoaded',r);try{{history.pushState=new Proxy(history.pushState,{{apply:function(t,th,a){{var v=Reflect.apply(t,th,a);r();return v;}}}});history.replaceState=new Proxy(history.replaceState,{{apply:function(t,th,a){{var v=Reflect.apply(t,th,a);r();return v;}}}});}}catch(e){{}}window.addEventListener('popstate',r);window.addEventListener('hashchange',r);}})();"
    );
    let view = main_window
        .add_child(
            WebviewBuilder::new(label, WebviewUrl::External(parsed))
                .on_navigation(move |target| {
                    let target = target.to_string();
                    !manager.should_block_request(&target, "", "document")
                })
                .on_new_window(move |url, _features| {
                    // target=_blank / window.open: don't spawn a raw OS window —
                    // hand the URL to the chrome so it becomes a real app tab.
                    let _ = emit_app.emit_to("main", "new-tab-request", url.to_string());
                    tauri::webview::NewWindowResponse::Deny
                })
                .initialization_script(script),
            LogicalPosition::new(x, y),
            LogicalSize::new(w, h),
        )
        .map_err(|e| e.to_string())?;
    let _ = view.show();
    let mut views = host.views.lock().unwrap();
    for (id, other) in views.iter() {
        if *id != tab_id {
            let _ = other.hide();
        }
    }
    views.insert(tab_id, view);
    Ok(())
}

/// Reposition/resize the child webview for `tab_id` (logical px).
#[tauri::command]
fn set_tab_bounds(app: AppHandle, tab_id: u64, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let host = app.state::<TabHost>();
    let Some(view) = host.views.lock().unwrap().get(&tab_id).cloned() else {
        return Ok(());
    };
    view.set_bounds(Rect {
        position: LogicalPosition::new(x, y).into(),
        size: LogicalSize::new(w, h).into(),
    })
    .map_err(|e| e.to_string())
}

/// Show the given tab's webview and hide all others (frontend drives this).
#[tauri::command]
fn activate_tab(app: AppHandle, tab_id: u64) {
    let host = app.state::<TabHost>();
    let views = host.views.lock().unwrap();
    for (id, view) in views.iter() {
        let _ = if *id == tab_id { view.show() } else { view.hide() };
    }
}

/// Destroy the child webview for `tab_id`.
#[tauri::command]
fn close_tab(app: AppHandle, tab_id: u64) {
    let host = app.state::<TabHost>();
    let removed = host.views.lock().unwrap().remove(&tab_id);
    if let Some(view) = removed {
        let _ = view.hide();
        let _ = view.close();
    }
}

/// Called by a tab's injected script whenever its page loads/loads, so the
/// chrome UI can keep the tab's title and URL bar in sync. Emits the
/// `page-info` event to the `main` window. The `webview` the call came from
/// must match `tab-{tab_id}`, otherwise a remote page could spoof a URL
/// into a different tab (since app commands are callable from any webview).
#[tauri::command]
fn set_page_info(webview: tauri::Webview, tab_id: u64, url: String, title: String) {
    if webview.label() != format!("tab-{tab_id}") {
        return;
    }
    if !url.starts_with("http://") && !url.starts_with("https://") && url != "about:blank" {
        return;
    }
    let _ = webview.emit_to("main", "page-info", (tab_id, url, title));
}

/// Real find-in-page for a child webview. The chrome passes the query and an
/// optional target match index; we inject a script into that webview which
/// wraps matches in `<mark data-fm>`, scrolls to the `index`-th one, and
/// reports the match count back through `find_report` so the chrome can show
/// "3/12" and move between results. `index < 0` counts only.
#[tauri::command]
fn find_in_page(app: AppHandle, tab_id: u64, query: String, index: i64) -> Result<(), String> {
    let host = app.state::<TabHost>();
    let Some(view) = host.views.lock().unwrap().get(&tab_id).cloned() else {
        return Ok(());
    };
    let q = serde_json::to_string(&query).unwrap_or_else(|_| "\"\"".to_string());
    let script = format!(
        r#"(function(){{
  var q = {q};
  var host = {tab_id};
  var wanted = {index};
  var prev = (window.__findMarks || []);
  for (var k = 0; k < prev.length; k++) {{
    var m = prev[k];
    if (m && m.parentNode) {{
      m.parentNode.replaceChild(document.createTextNode(m.textContent || ''), m);
      m.parentNode.normalize();
    }}
  }}
  window.__findMarks = [];
  if (!q) {{
    window.__TAURI_INTERNALS__.invoke('find_report', {{ tabId: host, count: 0, index: -1 }});
    return;
  }}
  var needle = q.toLowerCase();
  var marks = [];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (var i = 0; i < nodes.length; i++) {{
    var node = nodes[i];
    var t = node.textContent || '';
    if (!t) continue;
    var p = node.parentElement;
    if (!p || p.closest('script,style,mark,textarea,iframe') || p.isContentEditable) continue;
    var lower = t.toLowerCase();
    var at = lower.indexOf(needle);
    while (at !== -1) {{
      try {{
        var r = document.createRange();
        r.setStart(node, at);
        r.setEnd(node, at + q.length);
        var m = document.createElement('mark');
        m.setAttribute('data-find', '');
        m.style.cssText = 'background:#ffee58;color:#111;border-radius:2px;';
        r.surroundContents(m);
        marks.push(m);
      }} catch (e) {{ break; }}
      at = lower.indexOf(needle, at + q.length);
    }}
  }}
  window.__findMarks = marks;
  var sel = marks.length ? Math.max(0, Math.min(wanted, marks.length - 1)) : -1;
  if (sel >= 0) {{
    for (var j = 0; j < marks.length; j++) marks[j].classList.toggle('sel', j === sel);
    try {{ marks[sel].scrollIntoView({{ block: 'center', behavior: 'smooth' }}); }} catch (e) {{}}
  }}
  window.__TAURI_INTERNALS__.invoke('find_report', {{ tabId: host, count: marks.length, index: sel }});
}})();"#,
        q = q,
        tab_id = tab_id,
        index = index
    );
    view.eval(&script).map_err(|e| e.to_string())
}

/// Receives the count/index computed inside a page's finder script and
/// forwards it to the chrome as the `find-result` event. Only accepts reports
/// from the matching `tab-{tab_id}` webview.
#[tauri::command]
fn find_report(webview: tauri::Webview, tab_id: u64, count: usize, index: i64) {
    if webview.label() != format!("tab-{tab_id}") {
        return;
    }
    let _ = webview.emit_to("main", "find-result", (tab_id, count, index));
}

/// Evaluate a JavaScript snippet inside a child webview (fire-and-forget).
/// Used for page zoom injection, reader mode extraction, etc.
#[tauri::command]
fn eval_in_tab(app: AppHandle, tab_id: u64, script: String) -> Result<(), String> {
    let host = app.state::<TabHost>();
    let Some(view) = host.views.lock().unwrap().get(&tab_id).cloned() else {
        return Ok(());
    };
    view.eval(&script).map_err(|e| e.to_string())
}

/// Evaluate a JavaScript snippet inside a child webview and return its result
/// as a JSON string. Used for reader mode content extraction.
///
/// The snippet must be a synchronous or Promise-returning expression; the
/// injected wrapper awaits it, `JSON.stringify`s the result, and posts it back
/// through `eval_resolve`. Waits up to 10s for the page to reply.
#[tauri::command]
async fn eval_in_tab_str(
    app: AppHandle,
    tab_id: u64,
    script: String,
) -> Result<String, String> {
    let host = app.state::<TabHost>();
    let Some(view) = host.views.lock().unwrap().get(&tab_id).cloned() else {
        return Err("tab not found".to_string());
    };

    let id = {
        let reg = app.state::<EvalRegistry>();
        let mut next = reg.next_id.lock().unwrap();
        *next += 1;
        *next
    };
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    app.state::<EvalRegistry>()
        .pending
        .lock()
        .unwrap()
        .insert(id, tx);

    let wrapper = r#"(function () {
  var reqId = __EVAL_REQ_ID__;
  Promise.resolve()
    .then(function () { return (async () => { __EVAL_SCRIPT__ })(); })
    .then(function (v) {
      var out = v;
      if (typeof out !== 'string') { try { out = JSON.stringify(out); } catch (e) { out = String(out); } }
      window.__TAURI_INTERNALS__.invoke('eval_resolve', { reqId: reqId, value: out });
    })
    .catch(function (e) {
      window.__TAURI_INTERNALS__.invoke('eval_resolve', { reqId: reqId, value: JSON.stringify({ error: String((e && e.message) || e) }) });
    });
})();"#;
    let wrapped = wrapper
        .replace("__EVAL_REQ_ID__", &id.to_string())
        .replace("__EVAL_SCRIPT__", &script);
    view.eval(&wrapped).map_err(|e| e.to_string())?;

    // Wait up to ~10s total for the page script to reply.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let out = loop {
        match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(v) => break v,
            Err(_) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => break String::new(),
        }
    };
    let _ = app
        .state::<EvalRegistry>()
        .pending
        .lock()
        .unwrap()
        .remove(&id);
    if out.is_empty() {
        return Err("reader extraction timed out".to_string());
    }
    Ok(out)
}

/// Receives the result of an injected `eval_in_tab_str` script and delivers it
/// to the waiting command. Only the request id is needed to resolve it; any
/// webview may reply since the id was minted per-request.
#[tauri::command]
fn eval_resolve(app: AppHandle, req_id: u64, value: String) {
    let tx = app
        .state::<EvalRegistry>()
        .pending
        .lock()
        .unwrap()
        .remove(&req_id);
    if let Some(tx) = tx {
        let _ = tx.send(value);
    }
}

/// Open a URL in the OS default browser.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("only http(s) URLs are supported".into());
    }
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

/// Fetch search suggestions from the backend. Suggestion endpoints are
/// CORS-blocked from the `tauri.localhost` origin, so the HTTP call happens in
/// Rust. `engine` selects the provider ("google" | "bing" | "duckduckgo").
/// Returns up to `limit` suggestion strings.
#[tauri::command]
fn suggest(query: String, engine: String, limit: Option<u8>) -> Vec<String> {
    let q = query.trim();
    let mut out: Vec<String> = Vec::new();
    if q.is_empty() {
        return out;
    }
    let n = limit.unwrap_or(6).max(1).min(12) as usize;
    // Google/Bing return ["query", ["s1","s2",..]]; DDG returns [{"phrase":"s1"},..].
    let (url, kind) = match engine.as_str() {
        "bing" => (
            format!("https://api.bing.com/osjson.aspx?query={}", urlencode(q)),
            "list",
        ),
        "duckduckgo" => (
            format!("https://duckduckgo.com/ac/?q={}&type=list", urlencode(q)),
            "phrase",
        ),
        _ => (
            format!(
                "https://suggestqueries.google.com/complete/search?client=firefox&q={}",
                urlencode(q)
            ),
            "list",
        ),
    };
    let Ok(body) = ureq::get(&url)
        .set("User-Agent", "Mozilla/5.0 (BlueBrowser)")
        .timeout(std::time::Duration::from_secs(6))
        .call()
        .map_err(|e| e.to_string())
        .and_then(|resp| resp.into_string().map_err(|e| e.to_string()))
    else {
        return out;
    };
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
        if kind == "phrase" {
            if let Some(list) = v.as_array() {
                for it in list.iter().take(n) {
                    if let Some(s) = it.get("phrase").and_then(|x| x.as_str()) {
                        out.push(s.to_string());
                    }
                }
            }
        } else if let Some(list) = v.get(1).and_then(|a| a.as_array()) {
            for it in list.iter().take(n) {
                if let Some(s) = it.as_str() {
                    out.push(s.to_string());
                }
            }
        }
    }
    out
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Ad-blocking: report whether a request should be blocked.
#[tauri::command]
fn should_block_url(
    adblock: tauri::State<'_, Arc<AdblockManager>>,
    url: String,
    source_url: String,
    request_type: String,
) -> bool {
    adblock.should_block_request(&url, &source_url, &request_type)
}

/// Ad-blocking: generated cosmetic CSS for a page.
#[tauri::command]
fn get_class_css(
    adblock: tauri::State<'_, Arc<AdblockManager>>,
    page_url: String,
) -> String {
    adblock.cosmetic_css(&page_url)
}

/// Ad-blocking: toggle shields.
#[tauri::command]
fn set_shields(adblock: tauri::State<'_, Arc<AdblockManager>>, enabled: bool) {
    adblock.set_shields(enabled);
}

/// Ad-blocking: current shields state.
#[tauri::command]
fn shields_status(adblock: tauri::State<'_, Arc<AdblockManager>>) -> bool {
    adblock.shields_enabled()
}

/// Ad-blocking: session-long "ads & trackers blocked" totals for the badge
/// in the chrome UI.
#[tauri::command]
fn privacy_stats(adblock: tauri::State<'_, Arc<AdblockManager>>) -> (u64, u64) {
    adblock.blocked_totals()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let adblock = Arc::new(AdblockManager::new());
    let server_port = adblock::spawn_cosmetic_server(Arc::clone(&adblock));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(adblock)
        .manage(TabHost::default())
        .manage(EvalRegistry::default())
        .setup(move |app| {
            let _ = server_port; // port assigned & port recorded on the manager
            mcp::start_mcp_server(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_store,
            save_store,
            home_data,
            open_url,
            open_external,
            suggest,
            should_block_url,
            get_class_css,
            set_shields,
            shields_status,
            privacy_stats,
            set_tab_bounds,
            activate_tab,
            close_tab,
            set_page_info,
            find_in_page,
            find_report,
            eval_in_tab,
            eval_in_tab_str,
            eval_resolve
        ])
        .run(tauri::generate_context!())
        .expect("error while running blue browser");
}
