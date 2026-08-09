use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

/// Start the stdio MCP server thread. It listens for JSON-RPC lines on stdin and
/// drives the real browser through the Tauri app handle:
///   - `browser_navigate`  -> emits `mcp-navigate` (active tab navigates)
///   - `browser_new_tab`   -> emits `new-tab-request` (frontend opens a tab)
///   - `browser_get_tabs`  -> reads the persisted "session" store
pub fn start_mcp_server(app: AppHandle) {
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut stdout = io::stdout();
        let handle = stdin.lock();

        for line in handle.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }

            if let Ok(req) = serde_json::from_str::<JsonRpcRequest>(&line) {
                let response = handle_mcp_request(&app, &req);
                if let Some(resp) = response {
                    if let Ok(json_str) = serde_json::to_string(&resp) {
                        let _ = writeln!(stdout, "{json_str}");
                        let _ = stdout.flush();
                    }
                }
            }
        }
    });
}

fn handle_mcp_request(app: &AppHandle, req: &JsonRpcRequest) -> Option<JsonRpcResponse> {
    let id = req.id.clone();
    match req.method.as_str() {
        "initialize" => Some(JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "blue-browser-mcp", "version": "0.1.0" }
            })),
            error: None,
        }),
        "notifications/initialized" => None,
        "ping" => Some(JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(json!({})),
            error: None,
        }),
        "tools/list" => Some(JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(json!({
                "tools": [
                    {
                        "name": "browser_navigate",
                        "description": "Navigate Blue Browser's active tab to a URL",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "url": { "type": "string", "description": "The URL to open" }
                            },
                            "required": ["url"]
                        }
                    },
                    {
                        "name": "browser_new_tab",
                        "description": "Open a new tab in Blue Browser",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "url": { "type": "string", "description": "Optional initial URL" }
                            }
                        }
                    },
                    {
                        "name": "browser_get_tabs",
                        "description": "Get a list of currently open tabs in Blue Browser",
                        "inputSchema": { "type": "object", "properties": {} }
                    }
                ]
            })),
            error: None,
        }),
        "tools/call" => {
            let name = req
                .params
                .as_ref()
                .and_then(|p| p.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("");
            let args = req
                .params
                .as_ref()
                .and_then(|p| p.get("arguments"))
                .cloned()
                .unwrap_or(json!({}));
            let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string();

            let (ok, text) = call_tool(app, name, url);
            Some(JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id,
                result: Some(json!({
                    "content": [{ "type": "text", "text": text }]
                })),
                error: if ok { None } else { Some(json!({ "code": -32000, "message": text })) },
            })
        }
        _ => Some(JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(json!({
                "code": -32601,
                "message": "Method not found"
            })),
        }),
    }
}

fn call_tool(app: &AppHandle, name: &str, url: String) -> (bool, String) {
    match name {
        "browser_navigate" => {
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return (false, "url must start with http:// or https://".to_string());
            }
            let _ = app.emit_to("main", "mcp-navigate", &url);
            (true, format!("Navigated active tab to {url}"))
        }
        "browser_new_tab" => {
            let _ = app.emit_to("main", "new-tab-request", &url);
            (true, if url.is_empty() { "Created new browser tab.".into() } else { format!("Opened new tab: {url}") })
        }
        "browser_get_tabs" => {
            let session = crate::Store::new(app).read("session");
            let tabs = session
                .get("tabs")
                .and_then(|t| t.as_array())
                .map(|a| {
                    a.iter()
                        .map(|t| json!({
                            "url": t.get("url").and_then(|u| u.as_str()).unwrap_or(""),
                            "pinned": t.get("pinned").and_then(|p| p.as_bool()).unwrap_or(false),
                        }))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            (true, serde_json::to_string(&json!({ "tabs": tabs })).unwrap_or_else(|_| "[]".into()))
        }
        _ => (false, format!("Unknown tool: {name}")),
    }
}