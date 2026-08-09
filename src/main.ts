import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

/* ── Types ────────────────────────────────────────────────────────────────── */
type Accent = "blue" | "cyan" | "violet" | "emerald" | "amber" | "rose";
type Engine = "google" | "bing" | "duckduckgo";
type Panel = "bookmarks" | "history" | "reading" | "notes" | "shield" | "settings" | "downloads";

interface QuickLink { name: string; url: string; icon: string; }
interface Bookmark { title: string; url: string; }
interface HistoryEntry { title: string; url: string; at: number; }
interface Settings {
  accent: Accent; engine: Engine; shields: boolean; saveHistory: boolean;
  verticalTabs?: boolean; uiScale?: number; home?: string; restoreSession?: boolean;
}
interface SessionData { tabs: { url: string; incognito: boolean; pinned?: boolean }[]; active: number; }
interface DownloadItem { id: string; name: string; url: string; progress: number; done: boolean; path?: string; }

interface RapidStore<T> { load(): Promise<T>; save(v: T): Promise<void>; }

/* ── Defaults ─────────────────────────────────────────────────────────────── */
const DEFAULT_SETTINGS: Settings = {
  accent: "blue", engine: "google", shields: true, saveHistory: true,
  uiScale: 1, home: "", restoreSession: true,
};
const DEFAULT_LINKS: QuickLink[] = [
  { name: "YouTube",   url: "https://youtube.com",        icon: "▶" },
  { name: "Gmail",     url: "https://mail.google.com",    icon: "✉" },
  { name: "GitHub",    url: "https://github.com",         icon: "★" },
  { name: "Reddit",    url: "https://reddit.com",         icon: "◎" },
  { name: "Wikipedia", url: "https://wikipedia.org",      icon: "✎" },
  { name: "X",         url: "https://x.com",              icon: "𝕏" },
  { name: "Maps",      url: "https://maps.google.com",    icon: "📍" },
  { name: "News",      url: "https://news.google.com",    icon: "📰" },
];
const ENGINE_URLS: Record<Engine, string> = {
  google:     "https://www.google.com/search?q=",
  bing:       "https://www.bing.com/search?q=",
  duckduckgo: "https://duckduckgo.com/?q=",
};
const ENGINE_LABELS: Record<Engine, string> = { google: "G", bing: "B", duckduckgo: "D" };

let settings: Settings = { ...DEFAULT_SETTINGS };

/* ── Stores ───────────────────────────────────────────────────────────────── */
function store<T>(key: string, fallback: T): RapidStore<T> {
  return {
    load: async () => {
      try {
        const v = await invoke<unknown>("load_store", { key });
        return (v && typeof v === "object" ? (v as T) : fallback);
      } catch { return fallback; }
    },
    save: async (v: T) => { try { await invoke("save_store", { key, value: v }); } catch { /* noop */ } },
  };
}
const stores = {
  settings: store<Settings>("settings", DEFAULT_SETTINGS),
  links:    store<QuickLink[]>("quicklinks", DEFAULT_LINKS),
  bookmarks: store<Bookmark[]>("bookmarks", []),
  history:  store<HistoryEntry[]>("history", []),
  notes:    store<string>("notes", ""),
  reading:  store<string[]>("reading", []),
  session:  store<SessionData>("session", { tabs: [], active: 0 }),
};

/* ── Helpers ──────────────────────────────────────────────────────────────── */
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends Element>(sel: string) => Array.from(document.querySelectorAll<T>(sel));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/* ── Toast ────────────────────────────────────────────────────────────────── */
let toastTimer: number | undefined;
function toast(msg: string) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 2500);
}

/* ── Window controls ──────────────────────────────────────────────────────── */
// Lazy reference — do NOT call getCurrentWindow() at module top-level.
// It crashes if Tauri's IPC bridge isn't ready yet.
let win: ReturnType<typeof getCurrentWindow> | null = null;
function getWin() {
  if (!win) {
    try { win = getCurrentWindow(); } catch { return null; }
  }
  return win;
}
function bindWindowControls() {
  const w = getWin();
  if (!w) return;
  $("#w-min").addEventListener("click", () => w.minimize());
  $("#w-max").addEventListener("click", () => w.toggleMaximize());
  $("#w-close").addEventListener("click", () => w.close());
  w.onResized(() => { syncMaxIcon(); layoutView(); });
}
async function syncMaxIcon() {
  const w = getWin(); if (!w) return;
  const btn = $("#w-max");
  const maxed = await w.isMaximized();
  btn.title = maxed ? "Restore" : "Maximize";
}
async function fullscreenToggle() {
  const w = getWin(); if (!w) return;
  w.setFullscreen(!(await w.isFullscreen()));
}

/* ── Navigation helpers ───────────────────────────────────────────────────── */
function normalize(raw: string): string {
  const s = raw.trim();
  if (!s) return "https://www.google.com";
  if (s === "about:blank") return s;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (/^(localhost|[\w-]+(\.[\w-]+)+|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(s)) return "https://" + s;
  return ENGINE_URLS[settings.engine] + encodeURIComponent(s);
}
function hostOf(url: string): string {
  try {
    if (!url || url === "about:blank") return "New Tab";
    return new URL(url).hostname.replace(/^www\./, "");
  } catch { return url; }
}
function faviconUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  } catch { return ""; }
}

/* ── Tabs ─────────────────────────────────────────────────────────────────── */
interface Tab { id: number; title: string; url: string; pinned?: boolean; }
let tabSeq = 1;
const tabs: Tab[] = [{ id: 0, title: "New Tab", url: "" }];
let activeTabId = 0;
const closedTabs: { tab: Tab; incognito: boolean }[] = [];
const incognitoTabs = new Set<number>();
const mutedTabs = new Set<number>();

function addTab(url = "", incognito = false, pinned = false) {
  const t: Tab = { id: tabSeq++, title: url ? hostOf(url) : "New Tab", url, pinned };
  tabs.push(t);
  if (incognito) incognitoTabs.add(t.id);
  activeTabId = t.id;
  paintTabs();
  if (url) navigate(url);
  else {
    focusView();
    const inp = $("#nt-input") as HTMLInputElement | null;
    if (inp) window.setTimeout(() => inp.focus(), 80);
  }
  saveSession();
}
function closeTab(id: number) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i === -1) return;
  const [removed] = tabs.splice(i, 1);
  closedTabs.push({ tab: removed, incognito: incognitoTabs.has(id) });
  incognitoTabs.delete(id);
  mutedTabs.delete(id);
  navs.delete(id);
  tabZoom.delete(id);
  invoke("close_tab", { tabId: id }).catch(() => {});
  if (activeTabId === id) activeTabId = tabs.length ? tabs[Math.max(0, i - 1)]?.id ?? -1 : -1;
  if (!tabs.length) addTab();
  else { paintTabs(); focusView(); layoutView(); }
  saveSession();
}
function reopenTab() {
  const rec = closedTabs.pop();
  if (!rec) return toast("Nothing to reopen");
  addTab(rec.tab.url, rec.incognito);
}
function activeTab() { return tabs.find((t) => t.id === activeTabId); }
function switchTab(dir: number) {
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === activeTabId);
  const next = tabs[(i + dir + tabs.length) % tabs.length];
  activeTabId = next.id;
  paintTabs();
  focusView();
  layoutView();
}
function jumpTab(num: number) {
  const t = num === 9 ? tabs[tabs.length - 1] : tabs[num - 1];
  if (!t) return;
  activeTabId = t.id;
  paintTabs();
  focusView();
  layoutView();
}
function pinTab(id: number) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  t.pinned = !t.pinned;
  // Move pinned tabs to front
  tabs.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  paintTabs();
  toast(t.pinned ? "Tab pinned" : "Tab unpinned");
  saveSession();
}
function muteTab(id: number) {
  if (mutedTabs.has(id)) mutedTabs.delete(id);
  else mutedTabs.add(id);
  paintTabs();
  toast(mutedTabs.has(id) ? "Tab muted" : "Tab unmuted");
}

function faviconHTML(t: Tab): string {
  if (!t.url || t.url === "about:blank") {
    return incognitoTabs.has(t.id)
      ? `<svg><use href="#i-incog"/></svg>`
      : `<svg><use href="#i-orbit"/></svg>`;
  }
  const src = faviconUrl(t.url);
  return src ? `<img src="${src}" alt="" draggable="false" loading="lazy" onerror="this.parentElement.innerHTML='<svg><use href=\\'#i-globe\\'></use></svg>'">` : `<svg><use href="#i-globe"/></svg>`;
}

function paintTabs() {
  const strip = $("#tabstrip");
  $$<HTMLElement>("#tabstrip .tab").forEach((el) => el.remove());
  const btn = strip.querySelector("#newtab-btn")!;
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "tab" +
      (t.id === activeTabId ? " active" : "") +
      (incognitoTabs.has(t.id) ? " incognito" : "") +
      (t.pinned ? " pinned" : "") +
      (mutedTabs.has(t.id) ? " muted" : "");
    el.dataset.id = String(t.id);
    el.innerHTML = `
      <span class="tab-favicon">${faviconHTML(t)}</span>
      ${t.pinned ? "" : `<span class="tab-title"></span>`}
      ${t.pinned ? "" : `<button class="tab-close" title="Close tab"><svg><use href="#i-x"/></svg></button>`}`;
    if (!t.pinned) {
      (el.querySelector(".tab-title") as HTMLElement).textContent = t.title || "New Tab";
    }
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".tab-close")) return;
      activeTabId = t.id;
      paintTabs();
      focusView();
      layoutView();
    });
    el.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } });
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); showTabCtxMenu(e, t.id); });
    bindTabDrag(el, t.id);
    if (!t.pinned) {
      (el.querySelector(".tab-title") as HTMLElement).addEventListener("mouseenter", () => {
        const sb = $("#sb-url");
        if (sb && t.url) sb.textContent = t.url;
      });
      (el.querySelector(".tab-title") as HTMLElement).addEventListener("mouseleave", () => {
        const sb = $("#sb-url");
        if (sb) sb.textContent = "";
      });
      el.querySelector(".tab-close")!.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t.id); });
    }
    btn.before(el);
  }
  syncURL();
}

/* ── Tab Context Menu ─────────────────────────────────────────────────────── */
let ctxTabId = -1;
function showTabCtxMenu(e: MouseEvent, tabId: number) {
  ctxTabId = tabId;
  const menu = $("#ctx-menu");
  const t = tabs.find((x) => x.id === tabId);
  const pinItem = menu.querySelector("[data-c='pin-tab']") as HTMLElement;
  const muteItem = menu.querySelector("[data-c='mute-tab']") as HTMLElement;
  if (pinItem) pinItem.querySelector("span") && (pinItem.lastChild!.textContent = t?.pinned ? "Unpin tab" : "Pin tab");
  if (muteItem) muteItem.querySelector("span") && (muteItem.lastChild!.textContent = mutedTabs.has(tabId) ? "Unmute tab" : "Mute tab");
  // position
  menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 200) + "px";
  menu.classList.add("open");
}
$$<HTMLElement>(".ctx-item").forEach((item) => {
  item.addEventListener("click", () => {
    const c = item.dataset.c;
    if (c === "pin-tab") pinTab(ctxTabId);
    else if (c === "mute-tab") muteTab(ctxTabId);
    else if (c === "close-tab") closeTab(ctxTabId);
    else if (c === "new-tab") { const t = tabs.find((x) => x.id === ctxTabId); if (t?.url) addTab(t.url); }
    else if (c === "new-private") { const t = tabs.find((x) => x.id === ctxTabId); if (t?.url) addTab(t.url, true); }
    else if (c === "bookmark") saveBookmark();
    else if (c === "save-reading") saveToReading();
    $("#ctx-menu").classList.remove("open");
  });
});
document.addEventListener("click", () => $("#ctx-menu").classList.remove("open"));

/* ── Tab drag-to-reorder ──────────────────────────────────────────────────── */
let dragId: number | null = null;
function bindTabDrag(el: HTMLElement, id: number) {
  let moved = false, start = 0;
  const isVert = () => document.body.classList.contains("vertical-tabs");
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".tab-close")) return;
    dragId = id; moved = false;
    start = isVert() ? e.clientY : e.clientX;
    el.classList.add("dragging");
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (dragId !== id) return;
    if (Math.abs((isVert() ? e.clientY : e.clientX) - start) > 5) moved = true;
  });
  const finish = () => {
    el.classList.remove("dragging");
    if (dragId !== id) return;
    dragId = null;
    if (!moved) return;
    const from = tabs.findIndex((t) => t.id === id);
    if (from === -1) return;
    const els = $$<HTMLElement>("#tabstrip .tab");
    const rect = el.getBoundingClientRect();
    const line = isVert() ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
    let to = els.length - 1;
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if ((isVert() ? r.bottom : r.right) > line) { to = i; break; }
    }
    if (to === from) return;
    const [t] = tabs.splice(from, 1);
    tabs.splice(to, 0, t);
    paintTabs();
    saveSession();
  };
  el.addEventListener("pointerup", finish);
  el.addEventListener("pointercancel", finish);
}

/* Tab strip scroll-wheel */
(() => {
  const strip = $("#tabstrip");
  strip.addEventListener("wheel", (e) => {
    if (document.body.classList.contains("vertical-tabs")) return;
    strip.scrollLeft += e.deltaY;
    e.preventDefault();
  });
})();

/* ── Session ──────────────────────────────────────────────────────────────── */
let sessionTimer: number | undefined;
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(() => {
    const urlTabs = tabs.filter((t) => !incognitoTabs.has(t.id));
    stores.session.save({
      tabs: urlTabs.map((t) => ({ url: t.url, incognito: incognitoTabs.has(t.id), pinned: t.pinned })),
      active: Math.max(0, urlTabs.findIndex((t) => t.id === activeTabId)),
    });
  }, 300);
}
async function restoreSession() {
  if (settings.restoreSession === false) return;
  const s = await stores.session.load();
  if (!s || !Array.isArray(s.tabs) || !s.tabs.length) return;
  tabs.splice(0, tabs.length, ...s.tabs.map((x) => ({
    id: tabSeq++, title: x.url ? hostOf(x.url) : "New Tab", url: x.url, pinned: x.pinned,
  })));
  s.tabs.forEach((x, i) => { if (x.incognito) incognitoTabs.add(tabs[i].id); });
  const idx = Math.min(Math.max(0, s.active), tabs.length - 1);
  activeTabId = tabs[idx]?.id ?? tabs[0].id;
  const r = viewRect();
  for (const t of tabs) {
    if (!t.url || t.url === "about:blank") continue;
    try { await invoke("open_url", { tabId: t.id, url: t.url, x: r.x, y: r.y, w: r.w, h: r.h }); }
    catch { /* tab still listed */ }
  }
  paintTabs();
  focusView();
  layoutView();
}

/* ── Per-tab navigation history ───────────────────────────────────────────── */
interface TabNav { stack: string[]; idx: number; }
const navs = new Map<number, TabNav>();
function navFor(t: Tab): TabNav {
  let n = navs.get(t.id);
  if (!n) { n = { stack: [], idx: -1 }; navs.set(t.id, n); }
  return n;
}
function pushNav(t: Tab, url: string) {
  const n = navFor(t);
  n.stack.length = n.idx + 1;
  n.stack.push(url);
  n.idx = n.stack.length - 1;
}
function recordNav(t: Tab, url: string) {
  const n = navFor(t);
  if (n.idx >= 0 && n.stack[n.idx] === url) return;
  pushNav(t, url);
}
function syncNavButtons() {
  const t = activeTab();
  const n = t ? navFor(t) : null;
  ($("#nav-back") as HTMLButtonElement).disabled = !n || n.idx <= 0;
  ($("#nav-fwd") as HTMLButtonElement).disabled = !n || n.idx >= n.stack.length - 1;
}
function goBack() {
  const t = activeTab(); const n = t ? navFor(t) : null;
  if (!t || !n || n.idx <= 0) return;
  n.idx--;
  navigate(n.stack[n.idx], { record: false });
}
function goForward() {
  const t = activeTab(); const n = t ? navFor(t) : null;
  if (!t || !n || n.idx >= n.stack.length - 1 || n.idx === -1) return;
  n.idx++;
  navigate(n.stack[n.idx], { record: false });
}

/* ── Per-tab page zoom ────────────────────────────────────────────────────── */
const tabZoom = new Map<number, number>(); // zoom level 0.5 – 3.0
function getZoom(): number {
  const t = activeTab();
  return t ? (tabZoom.get(t.id) ?? 1.0) : 1.0;
}
function setZoom(level: number) {
  const t = activeTab();
  if (!t || !t.url) return;
  const z = Math.round(Math.max(0.25, Math.min(5.0, level)) * 100) / 100;
  tabZoom.set(t.id, z);
  // Inject CSS zoom into the child webview
  const css = z === 1 ? "" : `body{zoom:${z}!important;}`;
  const script = `(function(){var s=document.getElementById('__blue_zoom');if(!s){s=document.createElement('style');s.id='__blue_zoom';(document.head||document.documentElement).appendChild(s);}s.textContent=${JSON.stringify(css)};})();`;
  invoke("eval_in_tab", { tabId: t.id, script }).catch(() => {});
  updateZoomChip();
}
function zoomIn()    { setZoom(getZoom() + 0.1); }
function zoomOut()   { setZoom(getZoom() - 0.1); }
function zoomReset() { const t = activeTab(); if (t) { tabZoom.delete(t.id); updateZoomChip(); setZoom(1.0); } }
function updateZoomChip() {
  const chip = $("#zoom-chip");
  const z = getZoom();
  chip.textContent = Math.round(z * 100) + "%";
  chip.classList.toggle("visible", z !== 1.0);
  $("#sb-zoom").textContent = Math.round(z * 100) + "%";
}

/* ── Child-webview layout ─────────────────────────────────────────────────── */
function applyVerticalTabs() {
  document.body.classList.toggle("vertical-tabs", !!settings.verticalTabs);
  const kbd = $("#vt-kbd");
  if (kbd) kbd.textContent = settings.verticalTabs ? "On" : "Off";
  layoutView();
}
function toggleVerticalTabs() {
  settings.verticalTabs = !settings.verticalTabs;
  applyVerticalTabs();
  stores.settings.save(settings);
  toast(settings.verticalTabs ? "Vertical tabs on" : "Horizontal tabs on");
}

function viewRect() {
  const content = $("#content").getBoundingClientRect();
  const panel = $("#sidepanel");
  let x = content.left;
  if (panel.classList.contains("open")) {
    const pr = panel.getBoundingClientRect();
    x = Math.max(x, pr.right);
  }
  return {
    x: Math.max(0, x),
    y: Math.max(0, content.top),
    w: Math.max(10, content.right - x),
    h: Math.max(10, content.bottom - content.top),
  };
}
function layoutView() {
  const t = activeTab();
  if (!t || !t.url) return;
  const r = viewRect();
  invoke("set_tab_bounds", { tabId: t.id, x: r.x, y: r.y, w: r.w, h: r.h }).catch(() => {});
}
function focusView() {
  const t = activeTab();
  if (t) invoke("activate_tab", { tabId: t.id }).catch(() => {});
  if (findbar.classList.contains("open")) {
    findWeb = findUsesWebview();
    if (findWeb) {
      const term = findInput.value.trim();
      if (term && t?.url) invoke("find_in_page", { tabId: t.id, query: term, index: -1 }).catch(() => {});
      updateFindCount();
    }
  }
}

/* ── Navigation ──────────────────────────────────────────────────────────── */
function navigate(url: string, opts?: { record?: boolean }) {
  const target = normalize(url);
  const t = activeTab();
  if (target !== "about:blank" && t) {
    const r = viewRect();
    surgeStart();
    invoke("open_url", { tabId: t.id, url: target, x: r.x, y: r.y, w: r.w, h: r.h })
      .catch((e) => toast("Couldn't open: " + e));
    t.url = target;
    t.title = hostOf(target);
    if (opts?.record !== false) pushNav(t, target);
    else recordNav(t, target);
    tabZoom.delete(t.id);
    updateZoomChip();
    readerMode.active = false;
    $("#reader-overlay").classList.remove("open");
    $("#reader-btn").classList.remove("on");
    paintTabs();
    saveSession();
    if (settings.saveHistory && !incognitoTabs.has(t.id)) {
      stores.history.load().then((h) => {
        h.unshift({ title: hostOf(target), url: target, at: Date.now() });
        if (h.length > 500) h.length = 500;
        stores.history.save(h);
      });
    }
  }
}

/* ── Loading surge ────────────────────────────────────────────────────────── */
let _surgeOff = 0;
function surgeStart() {
  const bar = $("#loading-bar");
  bar.classList.remove("off");
  bar.classList.add("on");
  clearTimeout(_surgeOff);
  _surgeOff = window.setTimeout(surgeEnd, 15000);
}
function surgeEnd() {
  const bar = $("#loading-bar");
  if (!bar.classList.contains("on")) return;
  clearTimeout(_surgeOff);
  bar.classList.remove("on");
  bar.classList.add("off");
  window.setTimeout(() => bar.classList.remove("off"), 600);
}

/* ── Omnibox + suggestions ────────────────────────────────────────────────── */
const urlInput = $("#url-input") as HTMLInputElement;
const sugEl = $("#suggest");
let sugTimer: number | undefined;
let cur = -1;

function syncURL() {
  const t = activeTab();
  const incognito = incognitoTabs.has(t?.id ?? -1);
  const u = t?.url && t.url !== "about:blank" ? t.url : "";
  urlInput.value = u;
  urlInput.classList.toggle("incog", incognito);
  $("#omnibox").classList.toggle("incog", incognito);
  const isSecure = !u || u.startsWith("https") || u.startsWith("about:");
  const secSvg = $("#url-security use");
  if (secSvg) secSvg.setAttribute("href", isSecure ? "#i-lock" : "#i-globe");
  // Show reader button when on a real page
  const readerBtn = $("#reader-btn");
  if (readerBtn) readerBtn.classList.toggle("visible", !!u);
  syncBookmarkStar();
  syncNavButtons();
  updateZoomChip();
}
function onSugInput(q: string) {
  clearTimeout(sugTimer);
  if (!q.trim()) return closeSuggest();
  sugTimer = window.setTimeout(() => buildSuggest(q.trim()), 200);
}
async function buildSuggest(q: string) {
  let items: string[] = [q];
  try {
    items = await invoke<string[]>("suggest", { query: q, engine: settings.engine });
    if (!items.length) items = [q];
  } catch { /* offline */ }
  sugEl.innerHTML = `<div class="sugg-group">Suggestions</div>`;
  items.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "sugg-item";
    d.innerHTML = `<span class="sugg-ic"><svg><use href="#i-search"/></svg></span><span class="sugg-txt"></span><span class="sugg-hint">↵</span>`;
    (d.querySelector(".sugg-txt") as HTMLElement).textContent = it;
    d.dataset.i = String(i);
    d.addEventListener("click", () => commit(it));
    sugEl.appendChild(d);
  });
  cur = -1;
  sugEl.classList.add("open");
}
function navSug(dir: number) {
  const items = $$<HTMLElement>(".sugg-item");
  cur = Math.min(items.length - 1, Math.max(0, cur + dir));
  items.forEach((it, i) => it.classList.toggle("cur", i === cur));
  if (items[cur]) (urlInput as HTMLInputElement).value = items[cur].querySelector(".sugg-txt")!.textContent!;
}
function closeSuggest() { sugEl.classList.remove("open"); cur = -1; }
function commit(q: string) {
  closeSuggest();
  const target = normalize(q);
  const t = activeTab();
  if (t) { t.title = hostOf(target); t.url = target; paintTabs(); }
  navigate(target);
}

/* ── URL input events ─────────────────────────────────────────────────────── */
urlInput.addEventListener("focus", () => { urlInput.select(); });
urlInput.addEventListener("input", (e) => onSugInput((e.target as HTMLInputElement).value));
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") commit(urlInput.value);
  else if (e.key === "ArrowDown") { e.preventDefault(); navSug(1); }
  else if (e.key === "ArrowUp")   { e.preventDefault(); navSug(-1); }
  else if (e.key === "Tab") { e.preventDefault(); urlInput.value = normalize(urlInput.value); }
  else if (e.key === "Escape") { urlInput.blur(); closeSuggest(); }
});
urlInput.addEventListener("blur", () => window.setTimeout(closeSuggest, 150));

/* ── Sidebar panels ────────────────────────────────────────────────────────── */
const sidepanel = $("#sidepanel");
const sbContent = $("#sb-content");
const sbActions = $("#sb-actions");
let activePanel: Panel | null = null;

function closePanel() {
  sidepanel.classList.remove("open");
  activePanel = null;
  $$<HTMLElement>(".rail-btn").forEach((b) => b.classList.remove("active"));
  layoutView();
}
function openPanel(p: Panel) {
  if (activePanel === p && sidepanel.classList.contains("open")) { closePanel(); return; }
  activePanel = p;
  $$<HTMLElement>(".rail-btn").forEach((b) => b.classList.toggle("active", b.dataset.panel === p));
  const titles: Record<Panel, string> = {
    bookmarks: "Bookmarks", history: "History", reading: "Reading List",
    notes: "Notes", shield: "Privacy", settings: "Settings", downloads: "Downloads",
  };
  $("#sb-title").textContent = titles[p];
  sbActions.innerHTML = "";
  sidepanel.classList.add("open");
  layoutView();
  renderers[p]();
}
function empty(s: string) { sbContent.innerHTML = `<div class="empty">${esc(s)}</div>`; }

const renderers: Record<Panel, () => Promise<void> | void> = {
  bookmarks: renderBookmarks,
  history:   renderHistory,
  reading:   renderReading,
  notes:     renderNotes,
  shield:    renderShield,
  settings:  renderSettings,
  downloads: renderDownloads,
};

/* Bookmarks */
async function renderBookmarks() {
  const list = await stores.bookmarks.load();
  if (!list.length) return empty("No bookmarks yet.\nUse the ★ in the address bar to add one.");
  sbContent.innerHTML = list.map((b, i) => `
    <div class="card" data-i="${i}">
      <div class="card-ico"><img src="${faviconUrl(b.url)}" onerror="this.parentElement.textContent='${esc(b.title[0]?.toUpperCase() ?? "★")}'" alt=""></div>
      <div class="card-meta"><div class="card-title">${esc(b.title)}</div><div class="card-url">${esc(b.url)}</div></div>
      <button class="card-x" title="Remove"><svg><use href="#i-x"/></svg></button>
    </div>`).join("");
  $$<HTMLElement>("#sb-content .card").forEach((c) => {
    c.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".card-x")) return;
      navigate(list[+c.dataset.i!].url);
    });
    c.querySelector(".card-x")!.addEventListener("click", async () => {
      list.splice(+c.dataset.i!, 1);
      await stores.bookmarks.save(list);
      renderBookmarks();
      toast("Bookmark removed");
    });
  });
}

/* History */
async function renderHistory() {
  const all = await stores.history.load();
  if (!all.length) return empty("No browsing history yet.");
  const seen = new Set<string>();
  const list = all.filter((h) => (seen.has(h.url) ? false : (seen.add(h.url), true))).slice(0, 100);
  sbActions.innerHTML = `<button class="sb-btn" id="h-clear">Clear history</button>`;
  sbContent.innerHTML = list.map((h) => `
    <div class="card">
      <div class="card-ico"><img src="${faviconUrl(h.url)}" onerror="this.parentElement.innerHTML='<svg><use href=\\'#i-history\\'></use></svg>'" alt=""></div>
      <div class="card-meta"><div class="card-title">${esc(h.title || hostOf(h.url))}</div><div class="card-url">${esc(h.url)}</div></div>
    </div>`).join("");
  $$<HTMLElement>("#sb-content .card").forEach((c, i) => c.addEventListener("click", () => navigate(list[i].url)));
  $("#h-clear").addEventListener("click", async () => { await stores.history.save([]); renderHistory(); toast("History cleared"); });
}

/* Reading List */
async function renderReading() {
  const list = (await stores.reading.load()) as string[];
  if (!list.length) return empty("Nothing saved for later yet.\nUse Menu → Save to Reading List.");
  sbContent.innerHTML = list.map((u, i) => `
    <div class="card" data-i="${i}">
      <div class="card-ico"><img src="${faviconUrl(u)}" onerror="this.parentElement.innerHTML='<svg><use href=\\'#i-reader\\'></use></svg>'" alt=""></div>
      <div class="card-meta"><div class="card-title">${esc(hostOf(u))}</div><div class="card-url">${esc(u)}</div></div>
      <button class="card-x" title="Remove"><svg><use href="#i-x"/></svg></button>
    </div>`).join("");
  $$<HTMLElement>("#sb-content .card").forEach((c) => {
    c.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".card-x")) return;
      navigate(list[+c.dataset.i!]);
    });
    c.querySelector(".card-x")!.addEventListener("click", async () => {
      list.splice(+c.dataset.i!, 1);
      await stores.reading.save(list);
      renderReading();
    });
  });
}

/* Notes */
async function renderNotes() {
  const text = (await stores.notes.load()) as string;
  sbContent.innerHTML = `<div class="field" style="flex:1"><textarea class="notes-input" id="notes-area" placeholder="Write a note…"></textarea></div>`;
  const ta = $("#notes-area") as HTMLTextAreaElement;
  ta.value = text;
  ta.addEventListener("input", () => stores.notes.save(ta.value));
  sbActions.innerHTML = `<button class="sb-btn" id="n-clear">Clear</button>`;
  $("#n-clear").addEventListener("click", () => { ta.value = ""; stores.notes.save(""); toast("Notes cleared"); });
}

/* Privacy / Shield panel */
async function renderShield() {
  sbContent.innerHTML = `
    <div class="ds-section">
      <div class="ds-row">
        <span class="ds-ico"><svg><use href="#i-shield"/></svg></span>
        <div class="ds-meta"><div class="ds-title">Ad & Tracker Shields</div><div class="ds-sub">Network-level ad and tracker blocking</div></div>
        <label class="switch"><input type="checkbox" id="sh-tog" ${settings.shields ? "checked" : ""}><span class="slider"></span></label>
      </div>
      <div class="ds-div"></div>
      <div class="ds-row">
        <span class="ds-ico"><svg><use href="#i-history"/></svg></span>
        <div class="ds-meta"><div class="ds-title">Browsing History</div><div class="ds-sub">Save a local history of visited pages</div></div>
        <label class="switch"><input type="checkbox" id="sh-hist" ${settings.saveHistory ? "checked" : ""}><span class="slider"></span></label>
      </div>
    </div>
    <div class="ds-section">
      <div class="ds-row">
        <span class="ds-ico"><svg><use href="#i-trash"/></svg></span>
        <div class="ds-meta"><div class="ds-title">Clear Browsing Data</div><div class="ds-sub">Bookmarks, history and reading list</div></div>
        <button class="sb-btn" id="sh-clear" style="flex:none;width:auto;padding:6px 14px">Clear</button>
      </div>
    </div>`;
  ($("#sh-tog") as HTMLInputElement).addEventListener("change", (e) => {
    settings.shields = (e.target as HTMLInputElement).checked;
    stores.settings.save(settings);
    invoke("set_shields", { enabled: settings.shields }).catch(() => {});
    toast("Shields " + (settings.shields ? "on" : "off"));
  });
  ($("#sh-hist") as HTMLInputElement).addEventListener("change", (e) => {
    settings.saveHistory = (e.target as HTMLInputElement).checked;
    stores.settings.save(settings);
  });
  ($("#sh-clear") as HTMLButtonElement).addEventListener("click", async () => { await clearAllData(); toast("Browsing data cleared"); });
}

/* Downloads panel */
function renderDownloads() {
  if (!downloads.length) return empty("No downloads yet.");
  sbContent.innerHTML = downloads.map((d, i) => `
    <div class="card" data-i="${i}">
      <div class="card-ico"><svg><use href="#i-${d.done ? 'file' : 'download'}"/></svg></div>
      <div class="card-meta">
        <div class="card-title">${esc(d.name)}</div>
        ${d.done ? `<div class="card-url">Completed</div>` : `
        <div class="dl-progress"><div class="dl-progress-fill" style="width:${d.progress}%"></div></div>
        <div class="card-url">${d.progress}%</div>`}
      </div>
      <button class="card-x" title="${d.done ? 'Remove' : 'Cancel'}"><svg><use href="#i-x"/></svg></button>
    </div>`).join("");
  $$<HTMLElement>("#sb-content .card").forEach((c, i) => {
    c.querySelector(".card-x")!.addEventListener("click", () => {
      downloads.splice(i, 1);
      renderDownloads();
      updateDownloadBar();
    });
  });
}

/* Settings */
async function renderSettings() {
  sbContent.innerHTML = `
    <div class="ds-section">
      <div class="ds-row">
        <span class="ds-ico"><svg><use href="#i-home"/></svg></span>
        <div class="ds-meta"><div class="ds-title">Home page</div><div class="ds-sub">URL for Home button & Alt+Home</div></div>
      </div>
      <div class="ds-div"></div>
      <div class="field" style="padding:8px 12px 12px"><input id="s-home" type="text" spellcheck="false" placeholder="https://example.com (blank = New Tab)" value="${esc(settings.home ?? "")}" /></div>
      <div class="ds-row">
        <span class="ds-ico"><svg><use href="#i-reload"/></svg></span>
        <div class="ds-meta"><div class="ds-title">Restore session on startup</div><div class="ds-sub">Reopen your tabs from last session</div></div>
        <label class="switch"><input type="checkbox" id="s-restore" ${settings.restoreSession === false ? "" : "checked"}><span class="slider"></span></label>
      </div>
    </div>
    <div class="ds-section">
      <div class="ds-row">
        <span class="ds-ico"><svg><use href="#i-star"/></svg></span>
        <div class="ds-meta"><div class="ds-title">Accent color</div><div class="ds-sub">Theme accent color</div></div>
      </div>
      <div class="ds-div"></div>
      <div class="accents" style="padding:10px 14px 14px">${(["blue","cyan","violet","emerald","amber","rose"] as Accent[]).map((a) => `<span class="acc ${settings.accent === a ? "on" : ""}" data-a="${a}" style="background:var(--a-${a})"></span>`).join("")}</div>
    </div>
    <div class="ds-section">
      <div class="ds-row">
        <span class="ds-ico"><svg><use href="#i-search"/></svg></span>
        <div class="ds-meta"><div class="ds-title">Default search engine</div><div class="ds-sub">Used when searching in the omnibox</div></div>
      </div>
      <div class="ds-div"></div>
      <div class="field" style="padding:8px 12px 12px"><select id="s-engine">${(["google","bing","duckduckgo"] as Engine[]).map((e) => `<option ${settings.engine === e ? "selected" : ""}>${e}</option>`).join("")}</select></div>
    </div>
    <div class="ds-section">
      <div class="ds-row">
        <span class="ds-ico"><svg><use href="#i-layout"/></svg></span>
        <div class="ds-meta"><div class="ds-title">UI scale — <span class="mono" id="f-scale-label">${Math.round((settings.uiScale ?? 1) * 100)}%</span></div><div class="ds-sub">Zoom the whole interface</div></div>
      </div>
      <div class="ds-div"></div>
      <div class="scale-row" style="padding:6px 14px 12px">
        <button class="sb-btn" data-s="-1" style="flex:none">A−</button>
        <input type="range" id="s-scale" min="75" max="140" value="${Math.round((settings.uiScale ?? 1) * 100)}" />
        <button class="sb-btn" data-s="1" style="flex:none">A+</button>
        <button class="sb-btn" id="s-scale-reset" style="flex:none">Reset</button>
      </div>
    </div>`;
  // Accent
  $$<HTMLElement>(".acc").forEach((a) => a.addEventListener("click", () => {
    settings.accent = a.dataset.a as Accent;
    document.documentElement.dataset.accent = settings.accent;
    stores.settings.save(settings);
    a.parentElement!.querySelectorAll(".acc").forEach((x) => x.classList.toggle("on", x === a));
  }));
  // Engine
  ($("#s-engine") as HTMLSelectElement).addEventListener("change", (e) => {
    settings.engine = (e.target as HTMLSelectElement).value as Engine;
    stores.settings.save(settings);
    paintEngine();
  });
  // Scale
  const SCALE_STEP = 0.05;
  const setScale = (v: number) => {
    settings.uiScale = Math.max(0.75, Math.min(1.4, v));
    stores.settings.save(settings);
    applyUiScale();
    const label = $("#f-scale-label");
    if (label) label.textContent = Math.round(settings.uiScale * 100) + "%";
  };
  ($("#s-scale") as HTMLInputElement).addEventListener("input", (e) => setScale(+(e.target as HTMLInputElement).value / 100));
  $$<HTMLElement>("[data-s]").forEach((b) => b.addEventListener("click", () => {
    setScale((settings.uiScale ?? 1) + +b.dataset.s! * SCALE_STEP);
    ($("#s-scale") as HTMLInputElement).value = String(Math.round((settings.uiScale ?? 1) * 100));
  }));
  ($("#s-scale-reset") as HTMLButtonElement).addEventListener("click", () => {
    setScale(1); ($("#s-scale") as HTMLInputElement).value = "100";
  });
  // Home
  ($("#s-home") as HTMLInputElement).addEventListener("change", () => {
    settings.home = ($("#s-home") as HTMLInputElement).value.trim();
    stores.settings.save(settings);
    toast(settings.home ? "Home set to " + hostOf(settings.home) : "Home cleared");
  });
  // Restore
  ($("#s-restore") as HTMLInputElement).addEventListener("change", (e) => {
    settings.restoreSession = (e.target as HTMLInputElement).checked;
    stores.settings.save(settings);
  });
}

/* ── UI Scale ─────────────────────────────────────────────────────────────── */
function applyUiScale() {
  const s = Math.max(0.75, Math.min(1.4, settings.uiScale ?? 1));
  ($("#app") as HTMLElement).style.zoom = String(s);
  layoutView();
}

/* ── New Tab page ─────────────────────────────────────────────────────────── */
function startGreeting() {
  const h = new Date().getHours();
  const greet = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const subs = ["Where to, captain?", "Ready to explore.", "Let's go somewhere.", "Where would you like to go?"];
  $("#nt-greet").textContent = greet + ".";
  $("#nt-greet-sub").textContent = subs[Math.floor(Math.random() * subs.length)];
}
function paintEngine() {
  const b = $("#nt-engine");
  b.textContent = ENGINE_LABELS[settings.engine];
  b.title = "Search engine: " + settings.engine + " (click to switch)";
}
function cycleEngine() {
  const order: Engine[] = ["google", "bing", "duckduckgo"];
  settings.engine = order[(order.indexOf(settings.engine) + 1) % order.length];
  stores.settings.save(settings);
  paintEngine();
  toast("Engine: " + settings.engine);
}
function ntFaviconHTML(url: string): string {
  const src = faviconUrl(url);
  return src ? `<img src="${src}" alt="" draggable="false" loading="lazy">` : "";
}
function startHome() {
  paintEngine();
  startGreeting();
  invoke<{ links?: QuickLink[]; recent?: HistoryEntry[]; stats?: { bookmarks: number; history: number; reading: number } }>("home_data")
    .then((d) => {
      const links = Array.isArray(d?.links) ? d.links : [];
      const recents = Array.isArray(d?.recent) ? d.recent : [];
      const s = d?.stats;
      if (s) {
        const el = $("#nt-stats");
        el.hidden = false;
        el.innerHTML = `
          <span class="nt-stat"><span class="nt-chip"><svg><use href="#i-bookmark"/></svg></span><b>${s.bookmarks}</b>&nbsp;bookmarks</span>
          <span class="nt-sep"></span>
          <span class="nt-stat"><span class="nt-chip"><svg><use href="#i-history"/></svg></span><b>${Math.min(s.history, 999)}</b>&nbsp;visited</span>
          <span class="nt-sep"></span>
          <span class="nt-stat"><span class="nt-chip"><svg><use href="#i-reader"/></svg></span><b>${s.reading}</b>&nbsp;saved</span>`;
      }
      paintLinks(links);
      paintContinue(recents);
    })
    .catch(() => {
      stores.links.load().then(paintLinks);
      stores.history.load().then((h) => paintContinue(h));
    });
}
function paintLinks(links: QuickLink[]) {
  const wrap = $("#nt-links");
  wrap.innerHTML = "";
  wrap.appendChild(addTile());
  links.slice(0, 12).forEach((L) => {
    const a = document.createElement("button");
    a.className = "nt-link";
    a.innerHTML = `<span class="ic">${ntFaviconHTML(L.url) || esc(L.icon)}</span><span class="nm">${esc(L.name)}</span>`;
    a.title = L.name + " — " + L.url;
    a.addEventListener("click", () => navigate(L.url));
    wrap.appendChild(a);
  });
}
function addTile(): HTMLElement {
  const a = document.createElement("button");
  a.className = "nt-link add-tile";
  a.title = "Add shortcut";
  a.innerHTML = `<span class="ic"><svg><use href="#i-plus"/></svg></span><span class="nm">Add</span>`;
  a.addEventListener("click", () => openAddForm());
  return a;
}
function openAddForm() {
  const wrap = $("#nt-links").parentElement!;
  if (wrap.querySelector(".nt-addform")) return;
  const form = document.createElement("div");
  form.className = "nt-addform";
  form.innerHTML = `
    <div class="row">
      <input id="af-name" type="text" placeholder="Name (e.g. Wikipedia)" autocomplete="off" spellcheck="false" />
      <input id="af-url" type="text" placeholder="https://wikipedia.org" autocomplete="off" spellcheck="false" />
    </div>
    <div class="row">
      <button class="sb-btn" id="af-save" style="flex:none">Add shortcut</button>
      <button class="sb-btn" id="af-cancel" style="flex:none">Cancel</button>
    </div>`;
  wrap.querySelector(".nt-links-label")!.after(form);
  const name = $("#af-name") as HTMLInputElement;
  const url = $("#af-url") as HTMLInputElement;
  name.focus();
  const close = () => form.remove();
  $("#af-cancel").addEventListener("click", close);
  $("#af-save").addEventListener("click", async () => {
    const n = name.value.trim(), u = url.value.trim();
    if (!n || !u) return toast("Name and URL required");
    const norm = /^https?:\/\//i.test(u) ? u : "https://" + u;
    const links = await stores.links.load();
    if (links.some((l) => l.url === norm)) return toast("Already in shortcuts");
    links.push({ name: n, url: norm, icon: "★" });
    await stores.links.save(links);
    close();
    startHome();
    toast("Shortcut added");
  });
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter") ($("#af-save") as HTMLButtonElement).click();
    if (e.key === "Escape") close();
  });
}
function paintContinue(recents: HistoryEntry[]) {
  const wrap = $("#nt-continue");
  const seen = new Set<string>();
  const uniq = recents.filter((h) => (seen.has(h.url) ? false : (seen.add(h.url), true))).slice(0, 4);
  if (!uniq.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  wrap.innerHTML = `<div class="nt-cont-label">Continue browsing</div>` +
    uniq.map((h: HistoryEntry) => `
      <a class="nt-cont-row" href="#" data-u="${esc(h.url)}">
        <span class="nt-cont-ic">${ntFaviconHTML(h.url) || esc(hostOf(h.url)[0]?.toUpperCase() ?? "★")}</span>
        <span class="nt-cont-meta"><span class="nt-cont-t">${esc(h.title || hostOf(h.url))}</span><span class="nt-cont-d">${esc(hostOf(h.url))}</span></span>
        <span class="nt-cont-go"><svg><use href="#i-fwd"/></svg></span>
      </a>`).join("");
  $$<HTMLElement>(".nt-cont-row").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); navigate(a.dataset.u!); }));
}

/* ── Home navigation ──────────────────────────────────────────────────────── */
function goHome() {
  const home = settings.home?.trim();
  const t = activeTab();
  if (home) { if (t) navigate(home); else addTab(home); return; }
  const blank = tabs.find((x) => !x.url);
  if (blank && t?.url !== blank.url) { activeTabId = blank.id; paintTabs(); focusView(); }
  else if (blank) { focusView(); }
  else addTab();
}

/* ── Bookmarks ────────────────────────────────────────────────────────────── */
async function currentNavUrl(): Promise<string> {
  const raw = urlInput.value.trim();
  const t = activeTab();
  return normalize(raw || t?.url || "https://www.google.com");
}
function syncBookmarkStar() {
  currentNavUrl().then((url) => {
    stores.bookmarks.load().then((list) => {
      const on = list.some((b) => b.url === url);
      $("#star-btn").classList.toggle("on", on);
    });
  });
}
async function saveBookmark() {
  const url = await currentNavUrl();
  const list = await stores.bookmarks.load();
  const i = list.findIndex((b) => b.url === url);
  if (i >= 0) {
    list.splice(i, 1);
    await stores.bookmarks.save(list);
    toast("Bookmark removed");
    syncBookmarkStar();
    return;
  }
  const t = activeTab();
  list.push({ title: t?.title || hostOf(url), url });
  await stores.bookmarks.save(list);
  toast("Bookmarked " + hostOf(url));
  syncBookmarkStar();
}
async function saveToReading() {
  const url = await currentNavUrl();
  if (!url || url === "https://www.google.com") return toast("No page to save");
  const list = (await stores.reading.load()) as string[];
  if (list.includes(url)) return toast("Already in reading list");
  list.unshift(url);
  await stores.reading.save(list);
  toast("Saved to reading list");
}
async function clearAllData() {
  await stores.history.save([]);
  await stores.reading.save([]);
  await stores.bookmarks.save([]);
}

/* ── Downloads ────────────────────────────────────────────────────────────── */
const downloads: DownloadItem[] = [];
function updateDownloadBar() {
  const bar = $("#download-bar");
  const container = $("#dl-items");
  if (!downloads.length) { bar.classList.remove("open"); return; }
  bar.classList.add("open");
  container.innerHTML = downloads.map((d, i) => `
    <div class="dl-item" data-i="${i}">
      <div class="dl-icon"><svg><use href="#i-${d.done ? 'file' : 'download'}"/></svg></div>
      <div class="dl-info">
        <div class="dl-name">${esc(d.name)}</div>
        <div class="dl-progress"><div class="dl-progress-fill" style="width:${d.progress}%"></div></div>
        <div class="dl-status">${d.done ? "Complete" : d.progress + "%"}</div>
      </div>
      <button class="dl-close" data-i="${i}"><svg><use href="#i-x"/></svg></button>
    </div>`).join("");
  $$<HTMLElement>(".dl-close").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      downloads.splice(+btn.dataset.i!, 1);
      updateDownloadBar();
    });
  });
}
// addDownload is the public API for adding download items from future download interception
function _addDownload(name: string, url: string): DownloadItem {
  const item: DownloadItem = { id: crypto.randomUUID(), name, url, progress: 0, done: false };
  downloads.unshift(item);
  updateDownloadBar();
  return item;
}
void _addDownload;


/* ── Reader Mode ──────────────────────────────────────────────────────────── */
const readerMode = { active: false };
async function toggleReaderMode() {
  const t = activeTab();
  if (!t?.url) return;
  if (readerMode.active) {
    readerMode.active = false;
    $("#reader-overlay").classList.remove("open");
    $("#reader-btn").classList.remove("on");
    return;
  }
  // Extract content from the child webview
  const script = `(function(){
    var a=document.querySelector('article')||document.querySelector('main')||document.body;
    var title=document.title;
    var clone=a.cloneNode(true);
    var scripts=clone.querySelectorAll('script,style,nav,header,footer,aside,.ad,.ads,.advertisement');
    scripts.forEach(function(el){el.remove();});
    return JSON.stringify({title:title,html:clone.innerHTML});
  })();`;
  try {
    const result = await invoke<string>("eval_in_tab_str", { tabId: t.id, script });
    const data = JSON.parse(result) as { title: string; html: string };
    const overlay = $("#reader-overlay");
    $("#reader-title").textContent = data.title;
    $("#reader-content").innerHTML = data.html;
    // Remove scripts from injected HTML
    $$<HTMLElement>("#reader-content script").forEach((s) => s.remove());
    overlay.classList.add("open");
    readerMode.active = true;
    $("#reader-btn").classList.add("on");
  } catch {
    toast("Reader mode not available for this page");
  }
}

/* ── Find Bar ─────────────────────────────────────────────────────────────── */
const findbar = $("#findbar");
const findInput = $("#find-input") as HTMLInputElement;
const findCount = $("#find-count");
let findHits: HTMLElement[] = [];
let findIdx = -1;
let findWeb = false;
let findTotal = 0;

function findUsesWebview(): boolean {
  const t = activeTab();
  return !!t && !!t.url && t.url !== "about:blank";
}
function closeFind() { findbar.classList.remove("open"); clearFind(); }
function clearFind() {
  if (findWeb) {
    const t = activeTab();
    if (t?.url) invoke("find_in_page", { tabId: t.id, query: "", index: -1 }).catch(() => {});
  }
  $$<HTMLElement>("#content mark.find-hit").forEach((m) => {
    const p = m.parentNode!;
    p.replaceChild(document.createTextNode(m.textContent ?? ""), m);
    p.normalize();
  });
  findWeb = false; findTotal = 0; findHits = []; findIdx = -1;
  findInput.value = ""; findCount.textContent = "";
}
function openFind() {
  findbar.classList.add("open");
  findInput.focus(); findInput.select();
  findWeb = findUsesWebview();
  if (findInput.value) runFind(findInput.value);
}
function runFind(q: string) {
  if (findWeb) {
    findIdx = -1; findTotal = 0;
    const term = q.trim();
    const t = activeTab();
    if (term && t?.url) invoke("find_in_page", { tabId: t.id, query: term, index: -1 }).catch(() => {});
    else if (t?.url) invoke("find_in_page", { tabId: t.id, query: "", index: -1 }).catch(() => {});
    updateFindCount(); return;
  }
  clearFindHitsOnly();
  const term = q.trim();
  if (!term || !findbar.classList.contains("open")) { findCount.textContent = ""; return; }
  findIdx = -1;
  const w = document.createTreeWalker($("#content"), NodeFilter.SHOW_TEXT);
  while (w.nextNode()) {
    const node = w.currentNode as Text;
    if (!node.textContent || !node.textContent.toLowerCase().includes(term.toLowerCase())) continue;
    if ((node.parentElement as HTMLElement)?.closest?.("mark")) continue;
    const span = document.createElement("mark");
    span.className = "find-hit";
    span.textContent = node.textContent;
    node.replaceWith(span);
    findHits.push(span);
  }
  updateFindCount(); gotoFind(false);
}
function clearFindHitsOnly() {
  $$<HTMLElement>("#content mark.find-hit").forEach((m) => { m.replaceWith(document.createTextNode(m.textContent ?? "")); });
  findHits = [];
}
function updateFindCount() {
  if (findWeb) {
    findCount.textContent = findTotal ? `${Math.min(findIdx + 1, findTotal)}/${findTotal}` : (findInput.value.trim() ? "0/0" : "");
    return;
  }
  findCount.textContent = findHits.length ? `${findIdx + 1}/${findHits.length}` : (findInput.value.trim() ? "0/0" : "");
}
function gotoFind(forward: boolean) {
  if (findWeb) {
    const t = activeTab();
    if (!t?.url || !findTotal) { updateFindCount(); return; }
    const step = forward ? 1 : -1;
    findIdx = findIdx === -1 ? (forward ? 0 : findTotal - 1) : (findIdx + findTotal + step) % findTotal;
    invoke("find_in_page", { tabId: t.id, query: findInput.value.trim(), index: findIdx }).catch(() => {});
    updateFindCount(); return;
  }
  if (!findHits.length) { updateFindCount(); return; }
  const step = forward ? 1 : -1;
  let next = (findIdx + findHits.length + step) % findHits.length;
  if (findIdx === -1) next = forward ? 0 : findHits.length - 1;
  if (findIdx >= 0) findHits[findIdx].classList.remove("cur");
  findIdx = next;
  findHits[findIdx].classList.add("cur");
  findHits[findIdx].scrollIntoView({ block: "center", behavior: "smooth" });
  updateFindCount();
}
findInput.addEventListener("input", () => runFind(findInput.value));
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); gotoFind(!e.shiftKey); }
  else if (e.key === "Escape") closeFind();
});
$("#find-next").addEventListener("click", () => gotoFind(true));
$("#find-prev").addEventListener("click", () => gotoFind(false));
$("#find-close").addEventListener("click", closeFind);
$("#findbar").addEventListener("keydown", (e) => { if (e.key === "Escape") closeFind(); });

/* ── Menu ─────────────────────────────────────────────────────────────────── */
$("#nav-menu").addEventListener("click", (e) => { e.stopPropagation(); $("#menu").classList.toggle("open"); });
document.addEventListener("click", () => $("#menu").classList.remove("open"));
$$<HTMLElement>("#menu .mi").forEach((mi) => mi.addEventListener("click", () => {
  $("#menu").classList.remove("open");
  const m = mi.dataset.m;
  if (m === "newtab")        addTab();
  else if (m === "private")  addTab("", true);
  else if (m === "reopen")   reopenTab();
  else if (m === "find")     openFind();
  else if (m === "fullscreen") fullscreenToggle();
  else if (m === "vertical") toggleVerticalTabs();
  else if (m === "clear")    clearAllData().then(() => toast("Browsing data cleared"));
  else if (m === "settings") openPanel("settings");
  else if (m === "zoom-in")   zoomIn();
  else if (m === "zoom-out")  zoomOut();
  else if (m === "zoom-reset") zoomReset();
  else if (m === "save-reading") saveToReading();
  else if (["bookmarks","history","reading","notes","shield","downloads"].includes(m!)) openPanel(m as Panel);
}));

/* ── Rail ─────────────────────────────────────────────────────────────────── */
$$<HTMLElement>(".rail-btn").forEach((b) => b.addEventListener("click", () => {
  const p = b.dataset.panel as Panel | "newtab";
  if (p === "newtab") { closePanel(); addTab(); return; }
  openPanel(p);
}));
$("#sb-close").addEventListener("click", closePanel);

/* ── Toolbar buttons ──────────────────────────────────────────────────────── */
$("#nav-back").addEventListener("click", goBack);
$("#nav-fwd").addEventListener("click", goForward);
$("#nav-reload").addEventListener("click", () => { const t = activeTab(); if (t?.url) navigate(t.url); });
$("#nav-home").addEventListener("click", goHome);
$("#nav-shield").addEventListener("click", () => openPanel("shield"));
$("#nav-download").addEventListener("click", () => openPanel("downloads"));
$("#newtab-btn").addEventListener("click", () => { closeSuggest(); addTab(); });
$("#star-btn").addEventListener("click", saveBookmark);
$("#reader-btn").addEventListener("click", toggleReaderMode);
$("#reader-close").addEventListener("click", () => {
  readerMode.active = false;
  $("#reader-overlay").classList.remove("open");
  $("#reader-btn").classList.remove("on");
});
($("#reader-font-size") as HTMLSelectElement).addEventListener("change", (e) => {
  const size = (e.target as HTMLSelectElement).value;
  ($("#reader-content") as HTMLElement).style.fontSize = size + "px";
});
$("#zoom-chip").addEventListener("click", zoomReset);
$("#dl-clear").addEventListener("click", () => { downloads.length = 0; updateDownloadBar(); });

/* ── NTP search ───────────────────────────────────────────────────────────── */
const ntForm = $("#nt-search") as HTMLFormElement;
ntForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = ($("#nt-input") as HTMLInputElement).value.trim();
  if (!q) { ($("#nt-input") as HTMLInputElement).focus(); return; }
  navigate(q);
});
const ntInput = $("#nt-input") as HTMLInputElement;
ntInput.addEventListener("blur", () => window.setTimeout(closeSuggest, 150));
ntInput.addEventListener("input", (e) => onSugInput((e.target as HTMLInputElement).value));
ntInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") ntForm.requestSubmit();
  else if (e.key === "Escape") ntInput.blur();
});
$("#nt-engine").addEventListener("click", cycleEngine);
($("#nt-add") as HTMLButtonElement)?.addEventListener("click", openAddForm);

/* ── Global keyboard shortcuts ───────────────────────────────────────────── */
function bindGlobal(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  const ok = (f: () => void) => { e.preventDefault(); f(); };
  const k = e.key.toLowerCase();
  if (mod && k === "t" && !e.shiftKey)           ok(() => addTab());
  else if (mod && e.shiftKey && k === "t")       ok(reopenTab);
  else if (mod && e.shiftKey && k === "n")       ok(() => addTab("", true));
  else if (mod && k === "n")                     ok(() => addTab());
  else if (mod && k === "l")                     ok(() => { urlInput.focus(); urlInput.select(); });
  else if (mod && k === "d")                     ok(saveBookmark);
  else if (mod && k === "f")                     ok(openFind);
  else if (mod && k === "h")                     ok(() => openPanel("history"));
  else if (mod && k === "j")                     ok(() => openPanel("downloads"));
  else if (mod && e.shiftKey && k === "o")       ok(() => openPanel("bookmarks"));
  else if (mod && k === "w")                     ok(() => { const t = activeTab(); if (t) closeTab(t.id); });
  else if (mod && k === "tab" && !e.shiftKey)    ok(() => switchTab(1));
  else if (mod && e.shiftKey && k === "tab")     ok(() => switchTab(-1));
  else if ((mod && k === "r") || k === "f5")     ok(() => { const t = activeTab(); if (t?.url) navigate(t.url); });
  else if (mod && k >= "1" && k <= "9")          ok(() => jumpTab(+k));
  else if (mod && e.altKey && k === "enter")     ok(() => addTab(urlInput.value.trim()));
  else if (mod && (k === "=" || k === "+"))      ok(zoomIn);
  else if (mod && k === "-")                     ok(zoomOut);
  else if (mod && k === "0")                     ok(zoomReset);
  else if (e.key === "F11")                      ok(() => getWin()?.setFullscreen(!e.ctrlKey));
  else if (e.altKey && e.key === "ArrowLeft")    ok(goBack);
  else if (e.altKey && e.key === "ArrowRight")   ok(goForward);
  else if (e.altKey && e.key === "Home")         ok(goHome);
  else if (e.key === "Escape") {
    closeSuggest();
    $("#menu").classList.remove("open");
    closeFind();
    if (sidepanel.classList.contains("open")) closePanel();
  }
}

/* ── Init ─────────────────────────────────────────────────────────────────── */
(async function init() {
  settings = { ...DEFAULT_SETTINGS, ...(await stores.settings.load()) };
  document.documentElement.dataset.accent = settings.accent;
  // Bind window controls AFTER Tauri IPC is ready
  bindWindowControls();
  invoke("set_shields", { enabled: settings.shields }).catch(() => {});
  applyUiScale();
  document.addEventListener("keydown", bindGlobal);

  // Listen for page-info from child webviews
  listen<[number, string, string]>("page-info", (e) => {
    const [tabId, url, title] = e.payload;
    const t = tabs.find((x) => x.id === tabId);
    if (!t) return;
    surgeEnd();
    const prev = t.url;
    t.url = url;
    if (title && title.trim()) t.title = title;
    else if (url) t.title = hostOf(url);
    if (url !== prev) recordNav(t, url);
    if (activeTabId === tabId) syncURL();
    paintTabs();
  });

  // Find results from child webviews
  listen<[number, number, number]>("find-result", (e) => {
    const [tabId, count, index] = e.payload;
    const t = activeTab();
    if (!t || tabId !== t.id) return;
    findTotal = count; findIdx = index;
    updateFindCount();
  });

  // New tab requests from _blank links
  listen<string>("new-tab-request", (e) => {
    const url = e.payload;
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) return;
    addTab(url);
  });

  // Navigation requests from the MCP server
  listen<string>("mcp-navigate", (e) => {
    const url = e.payload;
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) return;
    navigate(url);
  });

  await restoreSession();
  paintTabs();
  applyVerticalTabs();
  startHome();
  syncURL();
  syncMaxIcon();
  syncBookmarkStar();
  urlInput.focus();
})();

export {};
