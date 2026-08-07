mod adblock;

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

/// Background-window style was dropped (June '26): tabs now render as child
/// webviews attached to the `main` window, positioned over the content area,
/// each wired with ad blocking + cosmetic-CSS injection + page-info reporting.

/// Tracks the live child webviews (one per tab id).
#[derive(Default)]
struct TabHost {
    views: Mutex<HashMap<u64, Webview>>,
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
    let cosmetic = manager.cosmetic_injection_script();
    let script = format!(
        "{cosmetic}(function(){{function r(){{try{{window.__TAURI_INTERNALS__.invoke('set_page_info',{{tabId:{tab_id},url:location.href,title:document.title}});}}catch(_){{}}}}r();document.addEventListener('DOMContentLoaded',r);}})();"
    );
    let view = main_window
        .add_child(
            WebviewBuilder::new(label, WebviewUrl::External(parsed))
                .on_navigation(move |target| {
                    let target = target.to_string();
                    !manager.should_block_request(&target, "", "document")
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
/// `page-info` event to the `main` window.
#[tauri::command]
fn set_page_info(app: AppHandle, tab_id: u64, url: String, title: String) {
    if !url.starts_with("http://") && !url.starts_with("https://") && url != "about:blank" {
        return;
    }
    let _ = app.emit_to("main", "page-info", (tab_id, url, title));
}

/// Open a URL in the OS default browser.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("only http(s) URLs are supported".into());
    }
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

/// Fetch Google's search suggestions from the backend. The engine's Google
/// endpoint does not send `Access-Control-Allow-Origin`, so a browser `fetch`
/// from the `tauri.localhost` origin is CORS-blocked; doing it in Rust avoids
/// that entirely. Returns up to `limit` suggestion strings.
#[tauri::command]
fn suggest(query: String, limit: Option<u8>) -> Vec<String> {
    let q = query.trim();
    let mut out: Vec<String> = Vec::new();
    if q.is_empty() {
        return out;
    }
    let n = limit.unwrap_or(6).max(1).min(12) as usize;
    let url = format!(
        "https://suggestqueries.google.com/complete/search?client=firefox&q={}",
        urlencode(q)
    );
    let Ok(body) = ureq::get(&url)
        .set("User-Agent", "Mozilla/5.0 (BlueBrowser)")
        .timeout(std::time::Duration::from_secs(6))
        .call()
        .map_err(|e| e.to_string())
        .and_then(|resp| resp.into_string().map_err(|e| e.to_string()))
    else {
        return out;
    };
    // Google returns a JSON array like ["query", ["sug1","sug2",...]].
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
        if let Some(list) = v.get(1).and_then(|a| a.as_array()) {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let adblock = Arc::new(AdblockManager::new());
    let server_port = adblock::spawn_cosmetic_server(Arc::clone(&adblock));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(adblock)
        .manage(TabHost::default())
        .setup(move |_app| {
            let _ = server_port; // port assigned & port recorded on the manager
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_store,
            save_store,
            open_url,
            open_external,
            suggest,
            should_block_url,
            get_class_css,
            set_shields,
            shields_status,
            set_tab_bounds,
            activate_tab,
            close_tab,
            set_page_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running blue browser");
}
