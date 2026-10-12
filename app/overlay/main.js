/**
 * Teleprompter Electron shell — transparent, always-on-top overlay.
 * The UI itself is served by app/server.js; this process only guarantees
 * the server is running and hosts the frameless window.
 *
 * Two independent axes:
 *   mode   — "floating" (پنجره‌ی شناور کنار صفحه) | "dropdown" (پنل زیر آیکن نوار سیستم)
 *   layout — "panel"   (پنجره‌ی کامل) | "subtitle" (نوار زیرنویسِ پایینِ صفحه، بدون قاب)
 *
 * Plus a system-tray / menu-bar status item:
 *   - macOS: mic glyph + live text `✍ 62% · 45wpm` in the menu bar
 *   - Windows/Linux: tray icon (progress in the tooltip)
 *   - left click  -> compact panel anchored under the icon (dropdown mode)
 *   - right click -> menu (show/recentre, subtitle toggle, reset, browser, quit)
 */
"use strict";

const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  screen,
  shell,
} = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.TELEPROMPTER_PORT || 4783);
const URL = `http://127.0.0.1:${PORT}/`;

/* توکنِ محلی (کار واقعی): اگر TELEPROMPTER_TOKEN ست باشد، رندرر هم همان را در ‎?token=‎ می‌برد */
function pageUrl() {
  const tok = process.env.TELEPROMPTER_TOKEN;
  return URL + (tok ? `?token=${encodeURIComponent(tok)}` : "");
}
const SERVER = path.join(__dirname, "..", "server.js");

let win = null;
let tray = null;
let mode = "floating";   /* کجا باشد: کنار صفحه یا زیر آیکن نوار سیستم */
let layout = "panel";    /* چه باشد: پنجره‌ی کامل یا نوار زیرنویس (از رندرر/ترِی می‌آید) */
let subPos = "top";      /* جای نوار زیرنویس: بالا یا پایینِ صفحه (پیش‌فرض بالا، از رندرر می‌آید) */
let pinned = false;      /* 📌 → پنلِ زیر آیکن با از دست رفتن فوکوس پنهان نمی‌شود */
let lastPos = "";        /* آخرین جای‌گذاریِ اعمال‌شده (تا بی‌جهت جابه‌جا نشویم) */
let panelSaved = null;   /* اندازه/جای پنلِ کامل قبل از رفتن به حالت زیرنویس */

function serverAlive() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureServer() {
  if (await serverAlive()) return;
  spawn(process.execPath.includes("electron") ? "node" : process.execPath, [SERVER], {
    detached: true,
    stdio: "ignore",
  }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await serverAlive()) return;
  }
}

/* ---------------------------------------------------------- http helpers */

function fetchJson(pathname) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}${pathname}`, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(900, () => {
      req.destroy();
      resolve(null);
    });
  });
}

/* توکنِ محلی (کار واقعی): اگر TELEPROMPTER_TOKEN ست باشد، فراخوانی‌ها احراز هویت می‌شوند */
const TOKEN = String(process.env.TELEPROMPTER_TOKEN || "");
function withToken(p) {
  if (!TOKEN) return p;
  return p + (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
}

function postJson(pathname, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) };
    if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: withToken(pathname),
        method: "POST",
        headers,
      },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
    req.end(data);
  });
}

function progressInfo(state) {
  if (!state || !state.drill) return null;
  const total = (state.progress && state.progress.total) || 0;
  const file = (state.progress && state.progress.file && state.progress.file.matched) || 0;
  const prac = (state.progress && state.progress.practice && state.progress.practice.matched) || 0;
  const wpm =
    (state.progress && state.progress.practice && state.progress.practice.wpm) ||
    (state.progress && state.progress.editor && state.progress.editor.wpm) ||
    0;
  return {
    pct: total ? Math.round((Math.max(file, prac) / total) * 100) : 0,
    wpm,
    title: state.drill.title,
  };
}

/* ------------------------------------------------------------- geometry */

function floatingBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(760, Math.round(wa.width * 0.42));
  const height = Math.min(620, Math.round(wa.height * 0.62));
  return { x: wa.x + wa.width - width - 18, y: wa.y + 18, width, height };
}

/* پنلی که از زیر آیکن نوار منو/ترِی باز می‌شود */
function dropdownBounds() {
  const b = tray ? tray.getBounds() : null;
  const rect = b && b.width > 0 ? b : { x: 60, y: 24, width: 20, height: 22 };
  const wa = screen.getDisplayNearestPoint({ x: rect.x, y: rect.y }).workArea;
  const width = 470;
  const height = Math.min(560, Math.round(wa.height * 0.6));
  let x = Math.round(rect.x + rect.width / 2 - width / 2);
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - width - 8));
  const y = Math.min(rect.y + rect.height + 6, wa.y + wa.height - height - 8);
  return { x, y, width, height };
}

/* نوار زیرنویس: پیش‌فرض بالا (زیر منوبار)؛ اندازه‌ی دلخواهِ کاربر هم می‌پذیرد */
function subtitleBounds(width, height) {
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.min(Math.max(320, Math.round(width || 1240)), wa.width);
  const h = Math.min(Math.max(120, Math.round(height || 224)), wa.height);
  return {
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: subPos === "top" ? wa.y + 12 : wa.y + wa.height - h - 16,
    width: w,
    height: h,
  };
}

/* رندرر جای نوار (بالا/پایین) و اندازه‌ی دلخواه را تعیین می‌کند */
ipcMain.handle("tp:setSubPos", (_e, p) => {
  const next = p === "bottom" ? "bottom" : "top";
  subPos = next;
  if (layout === "subtitle") {
    lastPos = "";
    positionWindow();
  }
  return subPos;
});

ipcMain.handle("tp:setSubSize", (_e, s) => {
  const b = subtitleBounds(s && s.w, s && s.h);
  if (win) {
    lastPos = "";
    try {
      win.setBounds(b);
    } catch (_) {}
    lastPos = "subtitle";
  }
  return b;
});

/* حالت پس‌ترو: رندرر وقتی نشانگر روی دکمه‌ها/دستگیره است فعال می‌کند، وگرنه کلیک‌ها رد می‌شوند */
ipcMain.handle("tp:setMouseInteractive", (_e, on) => {
  if (!win) return false;
  try {
    if (on) win.setIgnoreMouseEvents(false);
    else if (layout === "subtitle") win.setIgnoreMouseEvents(true, { forward: true });
    return true;
  } catch (_) {
    return false;
  }
});

function levelFor() {
  if (layout === "subtitle") return "screen-saver";
  return mode === "dropdown" ? "screen-saver" : "floating";
}

/* جای‌گذاریِ پنجره بر اساس چیدمان و حالت؛ فقط وقتی چیزی واقعاً عوض شده */
function positionWindow() {
  if (!win) return;
  /* خروج از حالت پس‌ترو: پنل پنجره‌ی کاری است و باید کلیک بخورد */
  try { win.setIgnoreMouseEvents(false); } catch (_) {}
  if (layout === "subtitle") {
    if (lastPos === "subtitle") return;
    lastPos = "subtitle";
    if (mode === "floating") panelSaved = win.getBounds();
    win.setMinimumSize(320, 120);
    win.setResizable(false);
    /* زیرنویس هرگز فوکوسِ ویرایشگر را نمی‌گیرد → تایپ قطع نمی‌شود */
    try { win.setFocusable(false); } catch (_) {}
    win.setBounds(subtitleBounds());
    /* فقط-نمایشی: کلیک‌ها از نوار رد می‌شوند؛ دکمه‌ها با hover دوباره فعال می‌شوند */
    try { win.setIgnoreMouseEvents(true, { forward: true }); } catch (_) {}
    win.setAlwaysOnTop(true, "screen-saver");
    console.log("[teleprompter] layout subtitle", JSON.stringify(win.getBounds()));
    return;
  }
  try { win.setFocusable(true); } catch (_) {}
  win.setMinimumSize(420, 320);
  win.setResizable(true);
  if (mode === "dropdown") {
    lastPos = "panel:dropdown";
    win.setBounds(dropdownBounds()); /* آیکن ممکن جابه‌جا شده باشد → همیشه تازه */
    win.setAlwaysOnTop(true, "screen-saver");
    return;
  }
  if (lastPos === "panel:floating") return; /* اندازه/جایِ دستیِ کاربر حفظ می‌شود */
  lastPos = "panel:floating";
  const saved = panelSaved && panelSaved.width >= 420 && panelSaved.height >= 320 ? panelSaved : floatingBounds();
  win.setBounds(saved);
  win.setAlwaysOnTop(true, "floating");
}

/* --------------------------------------------------------------- window */

function createWindow() {
  const b = floatingBounds();

  win = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minWidth: 420,
    minHeight: 320,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, "floating");
  /* توکنِ محلی (کار واقعی): اگر TELEPROMPTER_TOKEN ست باشد، رندرر هم همان را در ‎?token=‎ می‌برد */
  win.loadURL(pageUrl());
  /* لاگ‌/خطای رندرر (کنسول مرورگر) باید در این لاگ دیده شود — برای دیباگ زنده */
  win.webContents.on("console-message", (...args) => {
    try {
      const parts = args.slice(1).map((a) => (typeof a === "object" && a !== null ? JSON.stringify(a) : String(a)));
      console.log("[tp:renderer]", parts.join(" "));
    } catch (_) {}
  });
  win.once("ready-to-show", () => {
    if (win) win.show();
  });
  win.on("closed", () => {
    win = null;
    lastPos = "";
  });
  /* رفتار menubar app: پنلِ زیر منو با از دست رفتن فوکوس پنهان می‌شود
   * (مگر اینکه 📌 زده شده باشد؛ نوار زیرنویس هرگز خودش را پنهان نمی‌کند) */
  win.on("blur", () => {
    if (mode === "dropdown" && layout === "panel" && !pinned && win && win.isVisible()) win.hide();
  });
}

function focusWindow() {
  if (!win) return;
  try { win.focus(); } catch (_) {}
}

function notifyLayout() {
  if (win) {
    try { win.webContents.send("tp:layout", layout); } catch (_) {}
  }
}

function forcePanel() {
  if (layout === "subtitle") {
    layout = "panel";
    notifyLayout();
  }
}

function toggleLayout() {
  layout = layout === "subtitle" ? "panel" : "subtitle";
  positionWindow();
  notifyLayout();
  console.log("[teleprompter] layout", layout);
}

ipcMain.handle("tp:setAlwaysOnTop", () => {
  if (!win) return false;
  const next = !win.isAlwaysOnTop();
  try { win.setAlwaysOnTop(next, levelFor()); } catch (_) {}
  pinned = next;
  return next;
});

ipcMain.handle("tp:hide", () => {
  if (win) win.hide();
  return true;
});

ipcMain.handle("tp:show", () => {
  if (win) {
    win.show();
    focusWindow();
  }
  return true;
});

/* رندرر چیدمان را تعیین می‌کند (خودکار با حالت تمرین، یا با دکمه‌ی 🎞/⌨) */
ipcMain.handle("tp:setLayout", (_e, l) => {
  console.log("[teleprompter] ipc setLayout", JSON.stringify(l));
  const next = l === "subtitle" ? "subtitle" : "panel";
  if (next === layout && lastPos) return layout;
  layout = next;
  positionWindow();
  return layout;
});

/* نمایش پنجره؛ asDropdown آن را زیر آیکن نوار سیستم می‌نشاند */
function showWindow(asDropdown) {
  if (!win) createWindow();
  if (asDropdown) mode = "dropdown";
  else if (mode === "dropdown") mode = "floating";
  positionWindow();
  try { win.setAlwaysOnTop(true, levelFor()); } catch (_) {}
  win.show();
  focusWindow();
  console.log("[teleprompter] show", mode, layout, JSON.stringify(win.getBounds()));
}

const toggle = () => {
  if (!win) return createWindow();
  if (win.isVisible()) win.hide();
  else showWindow(mode === "dropdown");
};

/* ------------------------------------------------------- tray / menubar */

/* زبانِ منوی ترِی — از رندرر می‌آید (tp:setLang)؛ تا آن‌وقت پیش‌فرض انگلیسی */
let uiLang = "en";
const TRAY_TEXT = {
  en: {
    name: "Drill",
    show: "Show panel",
    hide: "Hide panel",
    float: "Floating window (large)",
    band: "Subtitle band (bottom of screen)",
    reset: "Reset drill",
    browser: "Open in browser",
    admin: "Admin panel",
    quit: "Quit",
    noDrill: "Drill — no drill",
  },
  fa: {
    name: "دریل",
    show: "نمایش پنل",
    hide: "پنهان کردن پنل",
    float: "پنجره‌ی شناور (بزرگ)",
    band: "نوار زیرنویس (پایین صفحه)",
    reset: "پاک کردن تمرین",
    browser: "باز کردن در مرورگر",
    admin: "پنل مدیریت",
    quit: "خروج",
    noDrill: "دریل — بدون تمرین",
  },
};
const tr = () => TRAY_TEXT[uiLang] || TRAY_TEXT.en;

/* رندرر زبان را اعلام می‌کند → منوی ترِی همان را نشان می‌دهد */
ipcMain.on("tp:setLang", (_e, l) => {
  const next = l === "fa" ? "fa" : "en";
  if (next === uiLang) return;
  uiLang = next;
  /* در مک منو هر بار هنگام راست‌کلیک ساخته می‌شود؛ جاهای دیگر بازسازی شود */
  if (tray && process.platform !== "darwin") {
    try { tray.setContextMenu(trayMenu()); } catch (_) {}
  }
  console.log("[teleprompter] ipc setLang", uiLang);
});

function trayMenu() {
  const visible = !!(win && win.isVisible());
  return Menu.buildFromTemplate([
    { label: visible ? tr().hide : tr().show, click: () => toggle() },
    { label: tr().float, click: () => { forcePanel(); showWindow(false); } },
    {
      type: "checkbox",
      label: tr().band,
      checked: layout === "subtitle",
      click: () => toggleLayout(),
    },
    { type: "separator" },
    { label: tr().reset, click: () => void postJson("/api/reset", {}) },
    { label: tr().browser, click: () => shell.openExternal(URL) },
    {
      label: tr().admin,
      click: () => {
        const tok = process.env.TELEPROMPTER_TOKEN;
        shell.openExternal(URL + "admin" + (tok ? "?token=" + encodeURIComponent(tok) : ""));
      },
    },
    { type: "separator" },
    { label: tr().quit, click: () => app.quit() },
  ]);
}

function createTray() {
  try {
    const file = process.platform === "darwin" ? "trayTemplate.png" : "tray.png";
    const image = nativeImage.createFromPath(path.join(__dirname, file));
    if (image.isEmpty()) return;
    if (process.platform === "darwin") image.setTemplateImage(true);
    tray = new Tray(image);
    tray.setToolTip(tr().name);
    /* کلیک چپ → پنل زیر آیکن (اگر زیرنویس باز است، اول به پنل برمی‌گردد) */
    tray.on("click", () => {
      const wasSubtitle = layout === "subtitle";
      forcePanel();
      if (win && win.isVisible() && mode === "dropdown" && !wasSubtitle) win.hide();
      else showWindow(true);
    });
    if (process.platform === "darwin") {
      /* در مک منوی always-on نداریم تا کلیک چپ بتواند پنل را باز کند */
      tray.on("right-click", () => {
        try {
          tray.popUpContextMenu(trayMenu());
        } catch (_) {}
      });
    } else {
      try {
        tray.setContextMenu(trayMenu());
      } catch (_) {}
    }
    console.log("[teleprompter] tray ready", process.platform);
  } catch (err) {
    console.error("[teleprompter] tray failed", err);
    tray = null; /* مثلاً لینوکس بدون appindicator */
  }
}

/* پیشرفت زنده کنار آیکن (مک) و در tooltip (ویندوز/لینوکس) */
async function refreshTray() {
  if (!tray) return;
  const p = progressInfo(await fetchJson("/api/state"));
  if (process.platform === "darwin") {
    try {
      tray.setTitle(p ? `✍ ${p.pct}% · ${p.wpm}wpm` : "");
    } catch (_) {}
  }
  try {
    tray.setToolTip(p ? `${tr().name} — ${p.title} — ${p.pct}%` : tr().noDrill);
  } catch (_) {}
}

/* ----------------------------------------------------------------- boot */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  /* A second launch means someone asked for the overlay (/api/open): show it.
   * Toggling stays on the global shortcut below. */
  app.on("second-instance", () => showWindow(mode === "dropdown"));

  app.whenReady().then(async () => {
    await ensureServer();
    createWindow();
    createTray();
    void refreshTray();
    setInterval(() => void refreshTray(), 2000);
    try {
      globalShortcut.register("CommandOrControl+Shift+P", toggle);
    } catch (_) {}
  });

  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("window-all-closed", () => app.quit());
}
