import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

/* ── Types ─────────────────────────────────────────────────────────────── */
type Accent = "blue" | "cyan" | "violet" | "emerald" | "amber" | "rose";
type Engine = "google" | "bing" | "duckduckgo";
type Panel = "bookmarks" | "history" | "reading" | "notes" | "shield" | "settings";

interface QuickLink { name: string; url: string; icon: string; }
interface Bookmark { title: string; url: string; }
interface HistoryEntry { title: string; url: string; at: number; }
interface Settings { accent: Accent; engine: Engine; shields: boolean; saveHistory: boolean; verticalTabs?: boolean; uiScale?: number; }

interface RapidStore<T> { load(): Promise<T>; save(v: T): Promise<void>; }

/* ── Constants / defaults ──────────────────────────────────────────────── */
const DEFAULT_SETTINGS: Settings = { accent: "blue", engine: "google", shields: true, saveHistory: true, uiScale: 1 };
const DEFAULT_LINKS: QuickLink[] = [
  { name: "YouTube", url: "https://youtube.com", icon: "▶" },
  { name: "Gmail", url: "https://mail.google.com", icon: "✉" },
  { name: "GitHub", url: "https://github.com", icon: "★" },
  { name: "Reddit", url: "https://reddit.com", icon: "◎" },
  { name: "Wikipedia", url: "https://wikipedia.org", icon: "✎" },
  { name: "X", url: "https://x.com", icon: "𝕏" },
];
const ENGINE_URLS: Record<Engine, string> = {
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  duckduckgo: "https://duckduckgo.com/?q=",
};

let settings: Settings = { ...DEFAULT_SETTINGS };

/* ── Small helpers ─────────────────────────────────────────────────────── */
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends Element>(sel: string) => Array.from(document.querySelectorAll<T>(sel));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/* ── Backed stores (Tauri invoke -> Rust serde_json file) ──────────────── */
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
  links: store<QuickLink[]>("quicklinks", DEFAULT_LINKS),
  bookmarks: store<Bookmark[]>("bookmarks", []),
  history: store<HistoryEntry[]>("history", []),
  notes: store<string>("notes", ""),
  reading: store<string[]>("reading", []),
};

/* ── Toast ─────────────────────────────────────────────────────────────── */
let toastTimer: number | undefined;
function toast(msg: string) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 2200);
}

/* ── UI scale (persistent zoom, 75%–140%) ─────────────────────────────── */
const SCALE_MIN = 0.75, SCALE_MAX = 1.4, SCALE_STEP = 0.05;
function clampScale(v: number) { return Math.min(SCALE_MAX, Math.max(SCALE_MIN, v)); }
function applyUiScale() {
  const s = clampScale(settings.uiScale ?? 1);
  ($("#app") as HTMLElement).style.zoom = String(s);
  $("#sb-zoom").textContent = Math.round(s * 100) + "%";
}
function zoomDelta(d: number) {
  settings.uiScale = Math.round(clampScale((settings.uiScale ?? 1) + d * SCALE_STEP) * 20) / 20;
  stores.settings.save(settings);
  applyUiScale();
  toast("UI scale " + $("#sb-zoom").textContent);
}

/* ── Window controls ───────────────────────────────────────────────────── */
const win = getCurrentWindow();
$("#w-min").addEventListener("click", () => win.minimize());
$("#w-max").addEventListener("click", () => win.toggleMaximize());
$("#w-close").addEventListener("click", () => win.close());
if ($("#w-fullscreen")) $("#w-fullscreen").addEventListener("click", fullscreenToggle);
async function syncMaxIcon() { $("#w-max").style.color = (await win.isMaximized()) ? "var(--acc)" : ""; }
win.onResized(syncMaxIcon);

/* ── Tabs ──────────────────────────────────────────────────────────────── */
interface Tab { id: number; title: string; url: string; }
let tabSeq = 1;
const tabs: Tab[] = [{ id: 0, title: "New Tab", url: "" }];
let activeTabId = 0;
const closedTabs: Tab[] = [];

function addTab(url = "") {
  const t: Tab = { id: tabSeq++, title: url ? hostOf(url) : "New Tab", url };
  tabs.push(t);
  activeTabId = t.id;
  paintTabs();
  if (url) navigate(url);
}
function closeTab(id: number) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i === -1) return;
  const [removed] = tabs.splice(i, 1);
  closedTabs.push(removed);
  invoke("close_tab", { tabId: id }).catch(() => {});
  if (activeTabId === id) activeTabId = tabs.length ? tabs[Math.max(0, i - 1)]?.id ?? -1 : -1;
  if (!tabs.length) addTab();
  else { paintTabs(); focusView(); }
}
function reopenTab() {
  const t = closedTabs.pop();
  if (!t) return toast("Nothing to reopen");
  addTab(t.url);
}
function activeTab() { return tabs.find((t) => t.id === activeTabId); }

/* ── Child-webview layout ─────────────────────────────────────────────── */
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

/** Compute where a child webview should sit (window-logical px), inside the
 *  #content area, clear of an open side panel. Divides by the UI zoom so the
 *  native (unzoomed) webview tracks the scaled chrome. */
function viewRect() {
  const z = clampScale(settings.uiScale ?? 1);
  const content = $("#content").getBoundingClientRect();
  const panel = $("#sidepanel");
  let x = content.left;
  if (panel.classList.contains("open")) {
    const pr = panel.getBoundingClientRect();
    x = Math.max(x, pr.right);
  }
  return { x: x / z, y: content.top / z, w: (content.right - x) / z, h: (content.bottom - content.top) / z };
}
/** Push the active tab's page rect to the child webview. */
function layoutView() {
  const t = activeTab();
  if (!t || !t.url) return;
  const r = viewRect();
  invoke("set_tab_bounds", { tabId: t.id, x: r.x, y: r.y, w: r.w, h: r.h }).catch(() => {});
}
/** Focus one tab on screen: show its view, hide the rest. */
function focusView() {
  const t = activeTab();
  if (t) invoke("activate_tab", { tabId: t.id }).catch(() => {});
}

function paintTabs() {
  const strip = $("#tabstrip");
  $$("#tabstrip .tab").forEach((el) => el.remove());
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.id === activeTabId ? " active" : "");
    el.dataset.id = String(t.id);
    const focus = t.url ? "globe" : "orbit";
    el.innerHTML = `
      <span class="tab-favicon"><svg><use href="#i-${focus}"/></svg></span>
      <span class="tab-title"></span>
      <button class="tab-close" title="Close tab"><svg><use href="#i-x"/></svg></button>`;
    (el.querySelector(".tab-title") as HTMLElement).textContent = t.title || "New Tab";
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".tab-close")) return;
      activeTabId = t.id;
      paintTabs();
      focusView();
    });
    el.querySelector(".tab-close")!.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t.id); });
    strip.querySelector("#newtab-btn")!.before(el);
  }
  syncURL();
}

/* ── Navigation ────────────────────────────────────────────────────────── */
function normalize(raw: string): string {
  const s = raw.trim();
  if (!s) return "https://www.google.com";
  if (s === "about:blank") return s;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/i.test(s)) return "https://" + s;
  return ENGINE_URLS[settings.engine] + encodeURIComponent(s);
}
function hostOf(url: string): string {
  try { if (url === "about:blank") return "New Tab"; return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
function navigate(url: string) {
  const target = normalize(url);
  const t = activeTab();
  if (target !== "about:blank" && t) {
    const r = viewRect();
    surgeStart();
    invoke("open_url", { tabId: t.id, url: target, x: r.x, y: r.y, w: r.w, h: r.h }).catch((e) => toast("Couldn't open: " + e));
    t.url = target;
    t.title = hostOf(target);
    paintTabs();
    if (settings.saveHistory) {
      stores.history.load().then((h) => {
        h.unshift({ title: hostOf(target), url: target, at: Date.now() });
        if (h.length > 200) h.length = 200;
        stores.history.save(h);
      });
    }
  }
  toast("Opening " + hostOf(target));
}

/* ── Loading surge animation ───────────────────────────────────────────── */
let _surgeOff = 0;
function surgeStart() {
  const bar = $("#loading-bar");
  bar.classList.remove("off");
  bar.classList.add("on");
  clearTimeout(_surgeOff);
  _surgeOff = window.setTimeout(surgeEnd, 12000);
}
function surgeEnd() {
  const bar = $("#loading-bar");
  if (!bar.classList.contains("on")) return;
  clearTimeout(_surgeOff);
  bar.classList.remove("on");
  bar.classList.add("off");
  window.setTimeout(() => bar.classList.remove("off"), 620);
}

/* ── Omnibox + suggestions ─────────────────────────────────────────────── */
const urlInput = $("#url-input") as HTMLInputElement;
const sugEl = $("#suggest");
let sugTimer: number | undefined;
let cur = -1;

function syncURL() {
  const t = activeTab();
  const u = t?.url && t.url !== "about:blank" ? t.url : "";
  urlInput.value = u;
  $("#url-security use").setAttribute("href", !u || u.startsWith("https") || u.startsWith("about:") ? "#i-lock" : "#i-globe");
  syncBookmarkStar();
}
function onSugInput(q: string) {
  clearTimeout(sugTimer);
  if (!q.trim()) return closeSuggest();
  sugTimer = window.setTimeout(() => buildSuggest(q.trim()), 180);
}
async function buildSuggest(q: string) {
  let items: string[] = [q];
  try {
    // Suggestions come from the Rust backend: Google's endpoint is CORS-blocked
    // for a browser `fetch` from the tauri.localhost origin, so we fetch in Rust.
    items = await invoke<string[]>("suggest", { query: q });
    if (!items.length) items = [q];
  } catch { /* offline / no results: show query only */ }
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
  const prev = urlInput.value;
  const target = normalize(q);
  const t = activeTab();
  if (t) { t.title = hostOf(target); t.url = target; paintTabs(); }
  navigate(target);
  void prev;
}

/* ── Sidebar panels ────────────────────────────────────────────────────── */
const sidepanel = $("#sidepanel");
const sbContent = $("#sb-content");
const sbActions = $("#sb-actions");
let activePanel: Panel | null = null;

function openPanel(p: Panel) {
  if (activePanel === p && sidepanel.classList.contains("open")) { sidepanel.classList.remove("open"); layoutView(); return; }
  activePanel = p;
  $$<HTMLElement>(".rail-btn").forEach((b) => b.classList.toggle("active", b.dataset.panel === p));
  const titles: Record<Panel, string> = { bookmarks: "Bookmarks", history: "History", reading: "Reading list", notes: "Notes", shield: "Privacy", settings: "Settings" };
  $("#sb-title").textContent = titles[p];
  sbActions.innerHTML = "";
  sidepanel.classList.add("open");
  layoutView();
  renderers[p]();
}
function empty(s: string) { sbContent.innerHTML = `<div class="empty">${s}</div>`; }

const renderers: Record<Panel, () => Promise<void> | void> = {
  bookmarks: renderBookmarks,
  history: renderHistory,
  reading: renderReading,
  notes: renderNotes,
  shield: renderShield,
  settings: renderSettings,
};

async function renderBookmarks() {
  const list = await stores.bookmarks.load();
  if (!list.length) return empty("No bookmarks yet. Use the ★ in the address bar.");
  sbContent.innerHTML = list.map((b, i) => `
    <div class="card" data-i="${i}">
      <div class="card-ico">${esc(b.title[0]?.toUpperCase() ?? "★")}</div>
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
    });
  });
}
async function renderHistory() {
  const all = await stores.history.load();
  if (!all.length) return empty("Browsing history is empty.");
  const seen = new Set<string>();
  const list = all.filter((h) => (seen.has(h.url) ? false : (seen.add(h.url), true))).slice(0, 60);
  sbActions.innerHTML = `<button class="sb-btn" id="h-clear">Clear history</button>`;
  sbContent.innerHTML = list.map((h) => `
    <div class="card">
      <div class="card-ico"><svg><use href="#i-history"/></svg></div>
      <div class="card-meta"><div class="card-title">${esc(h.title)}</div><div class="card-url">${esc(h.url)}</div></div>
    </div>`).join("");
  $$<HTMLElement>("#sb-content .card").forEach((c) => c.addEventListener("click", () => navigate(c.querySelector(".card-url")!.textContent!)));
  $("#h-clear").addEventListener("click", async () => { await stores.history.save([]); renderHistory(); toast("History cleared"); });
}
async function renderReading() {
  const list = (await stores.reading.load()) as string[];
  if (!list.length) return empty("Nothing saved for later yet.");
  sbContent.innerHTML = list.map((u, i) => `
    <div class="card" data-i="${i}">
      <div class="card-meta"><div class="card-title">${esc(u)}</div></div>
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
async function renderNotes() {
  const text = (await stores.notes.load()) as string;
  sbContent.innerHTML = `<div class="field" style="flex:1"><textarea class="notes-input" id="notes-area" placeholder="Write a note…"></textarea></div>`;
  const ta = $("#notes-area") as HTMLTextAreaElement;
  ta.value = text;
  ta.addEventListener("input", () => stores.notes.save(ta.value));
  sbActions.innerHTML = `<button class="sb-btn" id="n-clear">Clear</button>`;
  $("#n-clear").addEventListener("click", () => { ta.value = ""; stores.notes.save(""); toast("Notes cleared"); });
}

async function renderShield() {
  sbContent.innerHTML = `
    <div class="card" style="cursor:default"><div class="card-meta"><div class="card-title">Shields (ad & tracker blocking)</div><div class="card-url">Network-level filtering</div></div>
    <label class="switch"><input type="checkbox" id="sh-tog" ${settings.shields ? "checked" : ""}><span class="slider"></span></label></div>
    <div class="card" style="cursor:default"><div class="card-meta"><div class="card-title">Save browsing history</div><div class="card-url">Keep a local history</div></div>
    <label class="switch"><input type="checkbox" id="sh-hist" ${settings.saveHistory ? "checked" : ""}><span class="slider"></span></label></div>`;
  $("#sh-tog").addEventListener("change", () => {
    settings.shields = ($("#sh-tog") as HTMLInputElement).checked;
    stores.settings.save(settings);
    toast("Shields " + (settings.shields ? "on" : "off"));
  });
  $("#sh-hist").addEventListener("change", () => {
    settings.saveHistory = ($("#sh-hist") as HTMLInputElement).checked;
    stores.settings.save(settings);
  });
}
async function renderSettings() {
  sbContent.innerHTML = `
    <div class="field"><label>Accent theme</label>
      <div class="accents">${(["blue", "cyan", "violet", "emerald", "amber", "rose"] as Accent[]).map((a) => `<span class="acc ${settings.accent === a ? "on" : ""}" data-a="${a}" style="background:var(--a-${a})"></span>`).join("")}</div>
    </div>
    <div class="field"><label>Default search engine</label>
      <select id="s-engine">${(["google", "bing", "duckduckgo"] as Engine[]).map((e) => `<option ${settings.engine === e ? "selected" : ""}>${e}</option>`).join("")}</select>
    </div>
    <div class="field"><label>UI scale — <span class="mono" id="f-scale-label">${Math.round(clampScale(settings.uiScale ?? 1) * 100)}%</span></label>
      <div class="scale-row">
        <button class="sb-btn" data-s="-1">A−</button>
        <input type="range" id="s-scale" min="${Math.round(SCALE_MIN * 100)}" max="${Math.round(SCALE_MAX * 100)}" value="${Math.round(clampScale(settings.uiScale ?? 1) * 100)}" />
        <button class="sb-btn" data-s="1">A+</button>
        <button class="sb-btn" id="s-scale-reset">Reset</button>
      </div>
    </div>`;
  $$<HTMLElement>(".acc").forEach((a) => a.addEventListener("click", () => {
    settings.accent = a.dataset.a as Accent;
    document.documentElement.dataset.accent = settings.accent;
    stores.settings.save(settings);
    a.parentElement!.querySelectorAll(".acc").forEach((x) => x.classList.toggle("on", x === a));
  }));
  $("#s-engine").addEventListener("change", (e) => {
    settings.engine = (e.target as HTMLSelectElement).value as Engine;
    stores.settings.save(settings);
  });
  const setScale = (v: number) => { settings.uiScale = clampScale(v); stores.settings.save(settings); applyUiScale(); $("#f-scale-label").textContent = $("#sb-zoom").textContent; };
  $("#s-scale").addEventListener("input", (e) => setScale(+((e.target as HTMLInputElement).value) / 100));
  $$<HTMLElement>("[data-s]").forEach((b) => b.addEventListener("click", () => {
    setScale((settings.uiScale ?? 1) + (+b.dataset.s!) * SCALE_STEP);
    ($("#s-scale") as HTMLInputElement).value = String(Math.round(clampScale(settings.uiScale!) * 100));
  }));
  $("#s-scale-reset").addEventListener("click", () => {
    settings.uiScale = 1; stores.settings.save(settings);
    ($("#s-scale") as HTMLInputElement).value = "100";
    applyUiScale(); $("#f-scale-label").textContent = "100%";
  });
}

/* ── Home (New Tab) ────────────────────────────────────────────────────── */
function startClock() {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const tick = () => {
    const now = new Date();
    const h = now.getHours();
    $("#nt-title").textContent = ((h % 12) || 12) + ":" + String(now.getMinutes()).padStart(2, "0");
    $("#nt-ampm").textContent = h < 12 ? "AM" : "PM";
    $("#nt-date").textContent = days[now.getDay()] + ", " + months[now.getMonth()] + " " + now.getDate();
    $("#nt-greet").textContent = h < 5 ? "Late night browsing." : h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
  };
  tick();
  const int = window.setInterval(tick, 15000);
  window.addEventListener("unload", () => clearInterval(int));
}
async function startStats() {
  const [b, h, r] = await Promise.all([stores.bookmarks.load(), stores.history.load(), stores.reading.load()]);
  const el = $("#nt-stats");
  el.innerHTML = `
    <span class="nt-stat"><span class="nt-chip"><svg><use href="#i-bookmark"/></svg></span><b>${b.length}</b>&nbsp;bookmarks</span>
    <i class="nt-sep"></i>
    <span class="nt-stat"><span class="nt-chip"><svg><use href="#i-history"/></svg></span><b>${Math.min(h.length, 999)}</b>&nbsp;visited</span>
    <i class="nt-sep"></i>
    <span class="nt-stat"><span class="nt-chip"><svg><use href="#i-reader"/></svg></span><b>${r.length}</b>&nbsp;saved</span>`;
}
function startQuickLinks() {
  stores.links.load().then((links) => {
    const wrap = $("#nt-links");
    wrap.innerHTML = "";
    links.slice(0, 12).forEach((L) => {
      const a = document.createElement("a");
      a.className = "nt-link";
      a.innerHTML = `<span class="ic">${esc(L.icon)}</span><span class="nm">${esc(L.name)}</span>`;
      a.addEventListener("click", (e) => { e.preventDefault(); navigate(L.url); });
      wrap.appendChild(a);
    });
  });
}
async function startContinue() {
  const wrap = $("#nt-continue");
  const all = await stores.history.load();
  const seen = new Set<string>();
  const recents = all.filter((h) => (seen.has(h.url) ? false : (seen.add(h.url), true))).slice(0, 3);
  if (!recents.length) return (wrap.style.display = "none");
  wrap.style.display = "block";
  wrap.innerHTML = `<div class="nt-cont-label">Continue browsing</div>` + recents.map((h) => `
    <a class="nt-cont-row" href="#" data-u="${esc(h.url)}">
      <span class="nt-cont-ic">${esc(hostOf(h.url).replace(/^www\./, "")[0]?.toUpperCase() ?? "★")}</span>
      <span class="nt-cont-meta"><span class="nt-cont-t">${esc(h.title || hostOf(h.url))}</span><span class="nt-cont-d">${esc(hostOf(h.url))}</span></span>
      <span class="nt-cont-go"><svg><use href="#i-fwd"/></svg></span>
    </a>`).join("");
  $$<HTMLElement>(".nt-cont-row").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); navigate(a.dataset.u!); }));
}

/* ── Bootstrap ─────────────────────────────────────────────────────────── */
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
      $("#star-btn").title = on ? "Remove bookmark (Ctrl+D)" : "Bookmark this page (Ctrl+D)";
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
    toast("Removed bookmark");
    syncBookmarkStar();
    return;
  }
  list.push({ title: hostOf(url), url });
  await stores.bookmarks.save(list);
  toast("Bookmarked " + hostOf(url));
  syncBookmarkStar();
}
async function clearAllData() {
  await stores.history.save([]);
  await stores.reading.save([]);
  await stores.bookmarks.save([]);
  toast("Browsing data cleared");
}

function bindGlobal(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  const ok = (f: () => void) => { e.preventDefault(); f(); };
  const k = e.key.toLowerCase();
  if (mod && k === "t" && !e.shiftKey) ok(() => addTab());
  else if (mod && e.shiftKey && k === "t") ok(reopenTab);
  else if (mod && k === "n") ok(() => addTab());
  else if (mod && k === "l") ok(() => { urlInput.focus(); urlInput.select(); });
  else if (mod && k === "d") ok(saveBookmark);
  else if (mod && k === "f") ok(openFind);
  else if (mod && k === "h") ok(() => openPanel("history"));
  else if (mod && e.shiftKey && k === "o") ok(() => openPanel("bookmarks"));
  else if (mod && (k === "=" || k === "+")) ok(() => zoomDelta(1));
  else if (mod && k === "-") ok(() => zoomDelta(-1));
  else if (mod && k === "0") ok(() => { settings.uiScale = 1; stores.settings.save(settings); applyUiScale(); toast("UI scale reset"); });
  else if (e.key === "F11") ok(() => win.setFullscreen(!e.ctrlKey));
  else if (e.key === "Escape") { closeSuggest(); $("#menu").classList.remove("open"); closeFind(); if (sidepanel.classList.contains("open")) { sidepanel.classList.remove("open"); layoutView(); } }
}
async function fullscreenToggle() { win.setFullscreen(!(await win.isFullscreen())); }

/* ── Find bar ──────────────────────────────────────────────────────────── */
const findbar = $("#findbar");
const findInput = $("#find-input") as HTMLInputElement;
const findCount = $("#find-count");
let findHits: HTMLElement[] = [];
let findIdx = -1;

function closeFind() { findbar.classList.remove("open"); clearFind(); }
function clearFind() {
  $$<HTMLElement>("#content mark.find-hit").forEach((m) => {
    const p = m.parentNode!;
    p.replaceChild(document.createTextNode(m.textContent ?? ""), m);
    p.normalize();
  });
  findHits = [];
  findIdx = -1;
  findInput.value = "";
  findCount.textContent = "";
}
function openFind() {
  findbar.classList.add("open");
  findInput.focus();
  if (findInput.value) runFind(findInput.value);
}
function runFind(q: string) {
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
  updateFindCount();
  gotoFind(false);
}
function clearFindHitsOnly() { $$<HTMLElement>("#content mark.find-hit").forEach((m) => { m.replaceWith(document.createTextNode(m.textContent ?? "")); }); findHits = []; }
function updateFindCount() { findCount.textContent = findHits.length ? `${findIdx + 1}/${findHits.length}` : (findInput.value.trim() && findbar.classList.contains("open") ? "0/0" : ""); }
function gotoFind(forward: boolean) {
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

/* ── Menus ─────────────────────────────────────────────────────────────── */
$("#nav-menu").addEventListener("click", (e) => { e.stopPropagation(); $("#menu").classList.toggle("open"); });
document.addEventListener("click", () => $("#menu").classList.remove("open"));
$$<HTMLElement>("#menu .mi").forEach((mi) => mi.addEventListener("click", () => {
  $("#menu").classList.remove("open");
  const m = mi.dataset.m;
  if (m === "newtab") addTab();
  else if (m === "reopen") reopenTab();
  else if (m === "find") openFind();
  else if (m === "fullscreen") fullscreenToggle();
  else if (m === "vertical") toggleVerticalTabs();
  else if (m === "clear") clearAllData();
  else if (m === "settings") openPanel("settings");
  else if (["bookmarks", "history", "reading", "notes"].includes(m!)) openPanel(m as Panel);
}));

/* ── Rail ──────────────────────────────────────────────────────────────── */
$$<HTMLElement>(".rail-btn").forEach((b) => b.addEventListener("click", () => {
  const p = b.dataset.panel as Panel | "newtab";
  if (p === "newtab") { sidepanel.classList.remove("open"); layoutView(); return; }
  openPanel(p);
}));

/* ── Omnibox events ────────────────────────────────────────────────────── */
urlInput.addEventListener("input", (e) => onSugInput((e.target as HTMLInputElement).value));
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") commit(urlInput.value);
  else if (e.key === "ArrowDown") { e.preventDefault(); navSug(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); navSug(-1); }
  else if (e.key === "Tab") { urlInput.value = normalize(urlInput.value); }
});
urlInput.addEventListener("blur", () => window.setTimeout(closeSuggest, 140));
$("#newtab-btn").addEventListener("click", () => { closeSuggest(); addTab(); });
$("#star-btn").addEventListener("click", saveBookmark);
$("#nav-home").addEventListener("click", () => addTab());
$("#nav-reload").addEventListener("click", () => { const t = activeTab(); if (t?.url) navigate(t.url); });
$("#nav-back").addEventListener("click", () => toast("No back stack in this window"));
$("#nav-fwd").addEventListener("click", () => toast("No forward stack in this window"));
$("#nav-shield").addEventListener("click", () => openPanel("shield"));

/* New Tab search form */
const ntForm = $("#nt-search") as HTMLFormElement;
ntForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = ($("#nt-input") as HTMLInputElement).value.trim();
  if (q) navigate(q);
});

/* ── Init ──────────────────────────────────────────────────────────────── */
(async function init() {
  settings = { ...DEFAULT_SETTINGS, ...(await stores.settings.load()) };
  document.documentElement.dataset.accent = settings.accent;
  applyUiScale();
  document.addEventListener("keydown", bindGlobal);
  listen<[number, string, string]>("page-info", (e) => {
    const [tabId, url, title] = e.payload;
    const t = tabs.find((x) => x.id === tabId);
    if (!t) return;
    surgeEnd();
    t.url = url;
    if (title && title.trim()) t.title = title;
    else if (url) t.title = hostOf(url);
    if (activeTabId === tabId) syncURL();
    paintTabs();
  });
  win.onResized(() => { syncMaxIcon(); layoutView(); });
  paintTabs();
  applyVerticalTabs();
  startClock();
  startQuickLinks();
  startStats();
  startContinue();
  syncURL();
  syncMaxIcon();
  syncBookmarkStar();
  urlInput.focus();
})();

export {};
