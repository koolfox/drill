/* Teleprompter overlay renderer (served by app/server.js) */
"use strict";

const $ = (id) => document.getElementById(id);
const isElectron = !!window.tp;

/* توکنِ محلی (کار واقعی): Electron آن را در ‎?token=‎ می‌گذارد؛ همه‌ی فراخوانی‌های ‎/api‎ همان را می‌برند */
const TP_TOKEN = (() => {
  try {
    return new URLSearchParams(location.search).get("token") || "";
  } catch (_) {
    return "";
  }
})();
if (TP_TOKEN) {
  const _fetch = window.fetch.bind(window);
  window.fetch = (url, opts) =>
    _fetch(
      typeof url === "string" && url.startsWith("/api/")
        ? url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TP_TOKEN)
        : url,
      opts,
    );
}

/* ------------------------------------------------------------------ i18n */

const LANGS = window.TP_LANGS || { en: { name: "English", dir: "ltr", s: {} } };
let lang = "en";
try {
  const saved = localStorage.getItem("tpLang");
  if (saved && LANGS[saved]) lang = saved; /* پیش‌فرض: انگلیسی */
} catch (_) {}

function t(key, params) {
  const str = (LANGS[lang] && LANGS[lang].s[key]) || LANGS.en.s[key] || key;
  return params
    ? str.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m))
    : str;
}

/* ارقام فارسی برای شمارنده‌های رابط — فقط جاهایی که عددِ شمارشی است، نه کد و نه مسیر */
const FA_DIGITS = { 0: "۰", 1: "۱", 2: "۲", 3: "۳", 4: "۴", 5: "۵", 6: "۶", 7: "۷", 8: "۸", 9: "۹" };
function faNum(s) {
  if (lang !== "fa") return String(s);
  return String(s).replace(/[0-9]/g, (c) => FA_DIGITS[c]).replace(/%/g, "٪");
}

/** همه‌ی متن‌های ایستا را ترجمه می‌کند و جهتِ صفحه را می‌چرخاند. */
function applyLang(persist) {
  const L = LANGS[lang] || LANGS.en;
  document.documentElement.lang = lang;
  document.documentElement.dir = L.dir;
  /* منوی ترِی (فرآیند اصلی Electron) هم همان زبان را نشان می‌دهد */
  if (isElectron && typeof window.tp.setLang === "function") {
    try { window.tp.setLang(lang); } catch (_) {}
  }
  document.title = t("doc.title");
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.getAttribute("data-i18n"));
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.getAttribute("data-i18n-title"));
  for (const el of document.querySelectorAll("[data-i18n-ph]")) el.placeholder = t(el.getAttribute("data-i18n-ph"));
  const bl = $("btnLang");
  if (bl) bl.textContent = lang.toUpperCase();
  if (persist) {
    try { localStorage.setItem("tpLang", lang); } catch (_) {}
  }
  render();
}

function setLang(next) {
  if (!LANGS[next] || next === lang) return;
  lang = next;
  applyLang(true);
}

/* افزودن زبان جدید = یک بلوک دیگر در lang.js (name/dir/s) — هیچ فایل دیگری لازم نیست. */

/* ----------------------------------------------------------------- state */

let S = { drill: null, progress: null, history: [], integrations: {} };
/* "panel" = پنجره‌ی کامل · "subtitle" = نوار زیرنویسِ بدون قاب پایین صفحه */
let layout = "panel";
let lastIdx = -1;
let shownComplete = null;

/* local practice state (the overlay is the source of truth for typing) */
const P = {
  expected: [],
  done: [],
  typed: "",
  keys: 0,
  correct: 0,
  chars: 0,
  start: 0,
  finished: false,
  lastPost: 0,
  lastKey: 0,
};

/* ---------------------------------------------------------------- helpers */

/** مسیرِ کوتاهِ مقصد: «dir/file.py» تا «file.py:12» همیشه کامل دیده شود */
function shortPath(p) {
  const parts = String(p).split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : String(p);
}

function startLineOf(d) {
  const n = Number(d && d.startLine);
  return n > 1 ? Math.trunc(n) : 1;
}

function destText(d) {
  return d && d.targetFile ? `${shortPath(d.targetFile)}:${startLineOf(d)}` : "";
}

function destFull(d) {
  return d && d.targetFile ? `${d.targetFile}:${startLineOf(d)}` : "";
}

function currentFontSize() {
  return Number(getComputedStyle(document.documentElement).getPropertyValue("--code-size").replace("px", "")) || 15;
}

function currentLayoutDefault() {
  try {
    const v = localStorage.getItem("tpLayoutDefault");
    if (v === "panel" || v === "subtitle") return v;
  } catch (_) {}
  return "auto";
}

function resetPractice(drill, progress) {
  P.expected = String(drill.code).replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  P.done = P.expected.map(() => false);
  P.typed = "";
  P.keys = 0;
  P.correct = 0;
  P.chars = 0;
  P.start = 0;
  P.finished = false;
  P.lastPost = 0;
  P.lastKey = 0;
  shownComplete = null;
  /* حالتِ ذخیره‌شده در سرور: بعد از ری‌لود پنجره یا ری‌استارت سرور،
   * تمرینِ انجام‌شده برمی‌گردد تا آمارِ پنل و نوار سیستم ناهماهنگ نشود. */
  const pr = progress && progress.practice;
  if (pr) {
    const n = Math.min(Number(pr.matched) || 0, P.expected.length);
    for (let i = 0; i < n; i++) P.done[i] = true;
    P.keys = Number(pr.keys) || 0;
    P.correct = Number(pr.correct) || 0;
    P.finished = n >= P.expected.length && P.expected.length > 0;
  }
  const typer = $("typer");
  if (typer) typer.value = "";
}

function practiceIdx() {
  const i = P.done.indexOf(false);
  return i === -1 ? P.expected.length : i;
}

/**
 * خطِ جاریِ خواندن — همان چیزی که نوار زیرنویس را با تایپِ شما جلو می‌برد.
 * هر جریانی «آخرین فعالیت» را داشته باشد همان را دنبال می‌کنیم:
 *   cursor   = مکان‌نما در ویرایشگر (افزونه می‌فرستد؛ خطِ خام فایل)
 *   file     = تغییرِ ذخیره‌شده‌ی فایل هدف (سرور گزارش می‌دهد)
 *   practice = تایپ داخل پنجره‌ی تمرین
 */
function currentIndex() {
  const d = S.drill;
  if (!d) return 0;
  const p = S.progress || {};
  const total = P.expected.length;
  const off = startLineOf(d) - 1; /* خطِ مقصد، صفر-محور */
  const events = [];
  if (d.mode !== "practice" && d.targetFile && p.file && Array.isArray(p.file.states) && p.file.states.length) {
    events.push([p.file.updatedAt || 0, "file"]);
  }
  if (d.mode !== "practice" && Number.isInteger(p.cursor)) {
    events.push([p.cursorAt || 0, "cursor"]);
  }
  if (d.mode !== "work") events.push([P.lastKey || 0, "practice"]);
  if (!events.length) return practiceIdx();

  events.sort((a, b) => b[0] - a[0]);
  const stream = events[0][1];
  if (stream === "cursor") {
    /* خطِ خامِ فایل → شماره‌ی خطِ تمرین (مقصد نهایی همین تبدیل است) */
    return Math.max(0, Math.min(p.cursor - off, Math.max(0, total - 1)));
  }
  if (stream === "file") {
    const i = p.file.states.findIndex((s) => !s);
    return i === -1 ? p.file.states.length : i;
  }
  return practiceIdx();
}

function wpm() {
  if (!P.start) {
    const p = S.progress;
    /* کار واقعی: اگر در اوورلی تایپ نشده، سرعتِ ویرایشگر نشان داده می‌شود */
    return (p && p.practice && p.practice.wpm) || (p && p.editor && p.editor.wpm) || 0;
  }
  const min = (Date.now() - P.start) / 60000;
  if (min <= 0.0005) return 0;
  return Math.max(0, Math.round(P.chars / 5 / min));
}

function accuracy() {
  return P.keys ? Math.round((P.correct / P.keys) * 100) : 100;
}

function postProgress(force) {
  const now = Date.now();
  if (!force && now - P.lastPost < 600) return;
  P.lastPost = now;
  fetch("/api/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      practice: { matched: P.done.filter(Boolean).length, keys: P.keys, correct: P.correct, wpm: wpm(), done: P.finished },
    }),
  }).catch(() => {});
}

/* ----------------------------------------------------------------- layout */

function chooseLayout(drill) {
  let saved = null;
  try {
    saved = localStorage.getItem("tpLayout:" + drill.id);
  } catch (_) {}
  if (saved === "subtitle" || saved === "panel") return saved;
  /* انتخاب پیش‌فرضِ تنظیمات، بعد قانونِ حالت (تمرین=پنل، کار/هر دو=زیرنویس) */
  const def = currentLayoutDefault();
  if (def === "panel" || def === "subtitle") return def;
  return drill.mode === "practice" ? "panel" : "subtitle";
}

/* جای نوار زیرنویس (بالا/پایین) و اندازه‌ی دلخواه — برای همین مرورگر/سیستم می‌ماند */
let subPos = "top";
let subSize = null;
try {
  const sp = localStorage.getItem("tpSubPos");
  if (sp === "bottom" || sp === "top") subPos = sp;
  const ss = JSON.parse(localStorage.getItem("tpSubSize") || "null");
  if (ss && Number.isFinite(+ss.w) && Number.isFinite(+ss.h)) subSize = { w: ss.w, h: ss.h };
} catch (_) {}

function applySubChrome() {
  document.body.classList.toggle("sub-top", subPos === "top");
  if (isElectron && window.tp) {
    if (typeof window.tp.setSubPos === "function") {
      try { window.tp.setSubPos(subPos); } catch (_) {}
    }
    if (subSize && typeof window.tp.setSubSize === "function") {
      try { window.tp.setSubSize(subSize); } catch (_) {}
    }
  }
}

function setSubPos(p) {
  subPos = p === "bottom" ? "bottom" : "top";
  try { localStorage.setItem("tpSubPos", subPos); } catch (_) {}
  applySubChrome();
}

function applyLayout(l, persist) {
  console.log("[tp] applyLayout", l, "electron=" + isElectron, "tp=" + typeof window.tp);
  layout = l === "subtitle" ? "subtitle" : "panel";
  document.documentElement.classList.toggle("layout-subtitle", layout === "subtitle");
  if (persist && S.drill) {
    try {
      localStorage.setItem("tpLayout:" + S.drill.id, layout);
    } catch (_) {}
  }
  if (isElectron && typeof window.tp.setLayout === "function") window.tp.setLayout(layout);
  /* main اندازه‌ی پیش‌فرض را می‌گذارد؛ جای و اندازه‌ی دلخواه را دوباره اعلام می‌کنیم */
  if (layout === "subtitle") applySubChrome();
  lastIdx = -1;
  render();
}

/* ----------------------------------------------------------------- notify */

/** خبرِ سرور: ترجمه با key+params، وگرنه همان message خام. */
function notifyText(n) {
  if (!n) return "";
  if (n.key && LANGS[lang] && LANGS[lang].s[n.key] !== undefined) {
    let msg = t(n.key, n.params || {});
    if (n.key === "notify.practiceDone" && n.params && n.params.file) {
      msg += " " + t("notify.practiceFileHint", n.params);
    }
    return msg;
  }
  return String(n.message || "");
}

function completionText(p) {
  const d = S.drill;
  const total = P.expected.length || p.total || 0;
  if (p.completedBy === "file") {
    return t("notify.fileDone", { file: destFull(d) || (d && d.targetFile) || "", lines: total });
  }
  const pr = p.practice || {};
  let msg = t("notify.practiceDone", { wpm: pr.wpm || 0, acc: pr.keys ? Math.round((pr.correct / pr.keys) * 100) : 100 });
  if (d && d.targetFile) msg += " " + t("notify.practiceFileHint", { file: destFull(d) });
  return msg;
}

/* ------------------------------------------------------------------ render */

function render() {
  const d = S.drill;
  const showSub = !!d && layout === "subtitle";
  $("empty").classList.toggle("hidden", !!d);
  $("app").classList.toggle("hidden", !d || showSub);
  $("sub").classList.toggle("hidden", !d || !showSub);
  if (!d) {
    renderHub();
    return;
  }

  $("dTitle").textContent = d.title || "Teleprompter";
  $("dLang").textContent = d.language || "text";
  $("dMode").textContent = t("mode." + d.mode) || d.mode;
  /* نشانِ مقصد: «file.py:12» — مسیر کامل در tooltip */
  $("dFile").textContent = destText(d) || t("file.none");
  $("dFile").title = destFull(d);
  $("dFile").style.display = d.targetFile ? "" : "none";
  $("dGoal").textContent = d.goal || "";
  $("dGoal").style.display = d.goal ? "" : "none";

  const p = S.progress || { file: { states: [] }, practice: {}, total: P.expected.length };
  const total = P.expected.length || p.total || 0;
  const fileStates = (p.file && p.file.states) || [];
  const idx = currentIndex();
  renderGuide(idx, total);

  const list = $("lines");
  const box = $("prompter");
  const keepScroll = box.scrollTop;
  list.innerHTML = "";
  for (let i = 0; i < P.expected.length; i++) {
    const li = document.createElement("li");
    const fileDone = !!fileStates[i];
    const pracDone = !!P.done[i];
    if (fileDone) li.classList.add("done-file");
    if (pracDone) li.classList.add("done-practice");
    if (i === idx) li.classList.add("current");

    const no = document.createElement("span");
    no.className = "no";
    no.textContent = String(i + 1);
    const txt = document.createElement("span");
    txt.className = "txt";
    txt.textContent = P.expected[i] === "" ? " " : P.expected[i];
    li.append(no, txt);
    list.appendChild(li);
  }

  if (showSub) {
    renderSub(idx, total);
  } else if (idx !== lastIdx) {
    /* اسکرولِ دنبال‌کننده: خطِ جاری همیشه وسطِ دید می‌ماند */
    lastIdx = idx;
    scrollCurrentIntoView();
  } else {
    box.scrollTop = keepScroll;
  }

  /* practice box */
  $("lineNo").textContent = faNum(
    P.finished ? t("practice.done") : t("practice.line", { n: Math.min(practiceIdx() + 1, total), t: total }),
  );
  $("modeNote").textContent = t("note." + d.mode);
  $("typer").disabled = P.finished;
  renderDiff();
  renderStats();

  /* completion toast — فقط یک بار برای هر نوع اتمام */
  if (p.completedBy && shownComplete !== p.completedBy) {
    shownComplete = p.completedBy;
    showToast(completionText(p));
  }
}

/* محتوای نوار زیرنویس: عنوان، دلیل (راهنما)، خطِ جاری، خطِ بعد، مقصد، نتیجه، متریک */
function renderSub(idx, total) {
  const d = S.drill;
  const p = S.progress || {};
  const g = idx >= total ? null : activeGuide(d, idx);
  $("subTitle").textContent = (d && d.title) || "";
  /* «چرا» — راهنمای گامِ جاری، وگرنه هدفِ کلِ تمرین */
  $("subGoal").textContent = (g && g.why) || (d && d.goal) || "";
  $("subDest").textContent = destText(d);
  $("subDest").title = destFull(d) || "";
  if (idx >= total) {
    $("subCur").textContent = t("practice.done");
    $("subNext").textContent = "";
  } else {
    $("subCur").textContent = P.expected[idx] ? P.expected[idx] : " ";
    $("subNext").textContent = idx + 1 < total ? P.expected[idx + 1] || " " : "";
  }
  /* «نتیجه» — نتیجه‌ی گامِ جاری، وگرنه نتیجه‌ی نهاییِ تمرین */
  $("subRes").textContent = (g && g.result) || (idx >= total && d && d.result) || "";
  const best = Math.max((p.file && p.file.matched) || 0, P.done.filter(Boolean).length);
  const pct = total ? Math.round((best / total) * 100) : 0;
  $("subMeta").textContent = faNum(`${Math.min(idx + 1, total)}/${total} · ${pct}% · ${wpm()}wpm`);
}

/* ---------------- هدایتِ تایپ: کواوردینیتور (مدل)، کاربر را خط‌به‌خط می‌برد ---------------- */

/** گامِ راهنمای مربوط به خطِ جاری (from..to، ۱-محور، داخل کدِ تمرین) */
function activeGuide(d, idx) {
  if (!d || !Array.isArray(d.guide) || !d.guide.length) return null;
  const line = idx + 1;
  for (const g of d.guide) {
    if (g && line >= (g.from || 1) && line <= (g.to || g.from || 1)) return g;
  }
  return null;
}

/** جعبه‌ی «چرا / نتیجه» در پنل — با تایپ جلو می‌رود؛ آخر کار = نتیجه‌ی نهایی */
function renderGuide(idx, total) {
  const box = $("guideBox");
  if (!box) return;
  const d = S.drill;
  /* فازِ فایل: practice تمام شده ولی فایل هنوز تایپ نشده → راهنمایِ گامِ جاری زنده بماند */
  const finished = !d || idx >= total;
  const g = finished ? null : activeGuide(d, idx);
  const why = (g && g.why) || "";
  const res = finished ? (d && d.result) || "" : (g && g.result) || "";
  if (!why && !res) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  $("guideWhyRow").classList.toggle("hidden", !why);
  $("guideResRow").classList.toggle("hidden", !res);
  $("guideWhy").textContent = why;
  $("guideRes").textContent = res;
  $("guideRange").textContent = faNum(g ? t("guide.range", { from: g.from || 1, to: g.to || g.from || 1 }) : "");
}

function renderStats() {
  const p = (S.progress || { file: {}, practice: {} });
  const d = S.drill;
  const total = P.expected.length || p.total || 0;
  const fileMatched = (p.file && p.file.matched) || 0;
  const pracMatched = P.done.filter(Boolean).length;
  const best = Math.max(fileMatched, pracMatched);
  const pct = total ? Math.round((best / total) * 100) : 0;
  $("sPct").textContent = faNum(pct + "%");
  $("sWpm").textContent = faNum(String(wpm()));
  $("sAcc").textContent = faNum(accuracy() + "%");
  $("sBar").style.width = pct + "%";
  $("sFile").textContent = d && d.targetFile
    ? p.file && p.file.exists
      ? `${fileMatched}/${total}`
      : t("file.missing")
    : "—";
}

function renderDiff() {
  const i = practiceIdx();
  const box = $("expected");
  if (P.finished || i >= P.expected.length) {
    box.innerHTML = `<span class="ok">${t("practice.done")}</span>`;
    return;
  }
  const exp = P.expected[i];
  const typed = P.typed;
  let html = "";
  for (let c = 0; c < Math.max(exp.length, typed.length); c++) {
    const ch = (exp[c] ?? "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    const shown = (typed[c] ?? "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    if (c < typed.length) {
      html += typed[c] === exp[c] ? `<span class="ok">${shown || " "}</span>` : `<span class="bad">${shown || " "}</span>`;
    } else {
      html += c === typed.length ? `<span class="caret">&nbsp;</span><span>${ch || " "}</span>` : `<span>${ch || " "}</span>`;
    }
  }
  box.innerHTML = html || '<span class="caret">&nbsp;</span>';
}

function showToast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._h);
  el._h = setTimeout(() => el.classList.add("hidden"), 6000);
}

function scrollCurrentIntoView() {
  if (!S.drill || $("app").classList.contains("hidden")) return;
  const el = $("lines").querySelector(".current");
  if (el) el.scrollIntoView({ block: "center" });
}

/* --------------------------------------------------------- hub (شروع/تنظیمات) */

function renderHub() {
  /* وضعیت سرور */
  const pill = $("hubServer");
  if (pill) {
    pill.className = "pill ok";
    pill.innerHTML = `<i class="dot"></i>${t("hub.server")} · <span dir="ltr">${location.host}</span>`;
  }

  /* اتصال‌ها — از heartbeat ثبت‌شده در سرور */
  const integ = (S && S.integrations) || {};
  const now = Date.now();
  for (const li of document.querySelectorAll("#connList li")) {
    const ts = integ[li.getAttribute("data-conn")];
    const alive = ts && now - ts < 45000;
    const st = li.querySelector(".st");
    if (!st) continue;
    const det = (S && S.integrationDetails && S.integrationDetails[li.getAttribute("data-conn")]) || {};
    const seen = det.drillSeen ? " · " + t("conn.detailSees") : "";
    const open = det.targetOpen ? " · " + t("conn.detailOpen") : "";
    st.textContent = alive ? t("conn.connected") + seen + open
      ? t("conn.connected") + seen + open
      
  }

  /* وضعیت دکمه‌های تنظیمات */
  for (const b of document.querySelectorAll("#segLang [data-setlang]")) {
    b.classList.toggle("on", b.getAttribute("data-setlang") === lang);
  }
  const def = currentLayoutDefault();
  for (const b of document.querySelectorAll("#segLayout [data-setlayout]")) {
    b.classList.toggle("on", b.getAttribute("data-setlayout") === def);
  }
  const fs = $("setFont");
  if (fs) fs.textContent = currentFontSize() + "px";
  const status = $("emptyStatus");
  if (status && !status.dataset.err) status.textContent = t("hub.statusOk", { host: location.host });
}

function bindHub() {
  if (!isElectron) {
    for (const el of document.querySelectorAll(".electron-only")) el.classList.add("hidden");
  }

  /* کپیِ دستورها با یک کلیک */
  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest("[data-copy]") : null;
    if (!btn) return;
    const text = btn.getAttribute("data-copy");
    const backup = btn.textContent;
    const done = () => {
      btn.textContent = t("set.copied");
      setTimeout(() => (btn.textContent = backup), 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      done();
    }
  });

  /* زبان */
  for (const b of document.querySelectorAll("#segLang [data-setlang]")) {
    b.addEventListener("click", () => setLang(b.getAttribute("data-setlang")));
  }

  /* چیدمان پیش‌فرض */
  for (const b of document.querySelectorAll("#segLayout [data-setlayout]")) {
    b.addEventListener("click", () => {
      try { localStorage.setItem("tpLayoutDefault", b.getAttribute("data-setlayout")); } catch (_) {}
      renderHub();
    });
  }

  /* اندازه‌ی متن */
  const sm = $("btnSmaller2");
  if (sm) sm.addEventListener("click", () => changeFont(-1));
  const bg = $("btnBigger2");
  if (bg) bg.addEventListener("click", () => changeFont(1));

  /* همیشه روی بالا (فقط Electron) */
  const pin2 = $("btnPin2");
  if (pin2 && isElectron) {
    pin2.addEventListener("click", async () => {
      const on = await window.tp.setAlwaysOnTop();
      pin2.classList.toggle("off", !on);
      const pin = $("btnPin");
      if (pin) pin.classList.toggle("off", !on);
    });
  }

  /* باز کردن در مرورگر */
  const browser = $("btnOpenBrowser");
  if (browser) browser.addEventListener("click", () => fetch("/api/open", { method: "POST" }).catch(() => {}));
  /* پنل مدیریت وب (تنظیمات سرور، نصب و راه‌اندازی) */
  const adminBtn = $("btnOpenAdmin");
  if (adminBtn) adminBtn.addEventListener("click", () => fetch("/api/admin/open", { method: "POST" }).catch(() => {}));

  /* تمرین نمونه — بلافاصله کل مسیر را نشان می‌دهد */
  const sample = $("btnSample");
  if (sample) {
    sample.addEventListener("click", () => {
      fetch("/api/drill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "sample-" + Date.now(),
          title: t("sample.title"),
          goal: t("sample.goal"),
          language: "javascript",
          mode: "both",
          targetFile: "/tmp/teleprompter-sample.js",
          startLine: 1,
          result: t("sample.result"),
          guide: [
            { from: 1, to: 2, why: t("sample.g1why"), result: t("sample.g1res") },
            { from: 3, to: 4, why: t("sample.g2why"), result: t("sample.g2res") },
          ],
          source: "hub",
          code:
            ['export function greet(name) {', '  if (!name) return "hi, world";', "  return `hello, ${name}!`;", "}"].join("\n") +
            "\n",
        }),
      }).catch(() => {});
    });
  }
}

/* ---------------------------------------------------------------- practice */

function advance() {
  const i = practiceIdx();
  if (i >= P.expected.length) return;
  const exp = P.expected[i];
  if (P.typed.replace(/\s+$/, "") !== exp.replace(/\s+$/, "")) return; /* not a match yet */

  P.done[i] = true;
  P.typed = "";
  $("typer").value = "";
  $("typer").classList.remove("shake");

  if (P.done.every(Boolean)) {
    P.finished = true;
    postProgress(true);
    fetch("/api/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ by: "practice", wpm: wpm() }),
    }).catch(() => {});
    render();
    scrollCurrentIntoView();
    return;
  }
  postProgress(true);
  render();
  scrollCurrentIntoView();
}

function onKey(e) {
  if (P.finished) return;
  const i = practiceIdx();
  if (i >= P.expected.length) return;
  const exp = P.expected[i];

  if (e.key === "Enter") {
    e.preventDefault();
    advance();
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    /* jump to the expected indentation of this line */
    const lead = (exp.match(/^[ ]*/) || [""])[0];
    if (lead.length && exp.startsWith(P.typed)) {
      for (const ch of lead.slice(P.typed.length)) countKey(ch, true);
      P.typed = lead;
      $("typer").value = lead;
      renderDiff();
      renderStats();
      postProgress();
    }
    return;
  }
  if (e.key === "Escape") {
    if (isElectron) window.tp.hide();
    else e.target.blur();
    return;
  }
  if (e.key.length !== 1) return; /* printable only */

  if (!P.start) P.start = Date.now();
  const pos = P.typed.length;
  countKey(e.key, e.key === exp[pos]);
}

function countKey(ch, ok) {
  P.keys++;
  P.lastKey = Date.now(); /* آخرین فعالیتِ تمرین → نوار زیرنویس همین‌جا می‌ایستد */
  if (ok) {
    P.correct++;
    P.chars++;
  }
}

function onInput() {
  const i = practiceIdx();
  if (i >= P.expected.length) return;
  const exp = P.expected[i];
  const val = $("typer").value;

  /* count newly typed characters against the expected line */
  if (val.length > P.typed.length) {
    for (let c = P.typed.length; c < val.length; c++) countKey(val[c], val[c] === exp[c]);
    if (!P.start) P.start = Date.now();
  }
  P.typed = val;
  renderDiff();
  renderStats();
  postProgress();
  if (val.replace(/\s+$/, "") === exp.replace(/\s+$/, "")) advance();
}

/* ---------------------------------------------------------------- controls */

function bindControls() {
  const typer = $("typer");
  typer.addEventListener("keydown", onKey);
  typer.addEventListener("input", onInput);

  $("btnBigger").addEventListener("click", () => changeFont(1));
  $("btnSmaller").addEventListener("click", () => changeFont(-1));

  /* سوییچ پنل ⇄ نوار زیرنویس (انتخاب برای همین تمرین ذخیره می‌شود) */
  $("btnLayout").addEventListener("click", () => applyLayout(layout === "subtitle" ? "panel" : "subtitle", true));
  $("btnPanel").addEventListener("click", () => {
    applyLayout("panel", true);
    setTimeout(() => $("typer").focus(), 90);
  });
  $("btnSubHide").addEventListener("click", () => {
    if (isElectron) window.tp.hide();
  });
  /* جابه‌جایی نوار بالا/پایین */
  $("btnSubPos").addEventListener("click", () => setSubPos(subPos === "top" ? "bottom" : "top"));
  /* دستگیره‌ی ریسایز: درگ → اندازه‌ی زنده (throttle با rAF) */
  const grip = $("btnSubSize");
  if (grip) {
    grip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const x0 = e.clientX, y0 = e.clientY;
      const w0 = window.innerWidth, h0 = window.innerHeight;
      let raf = 0;
      const move = (ev) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          subSize = { w: Math.round(w0 + (ev.clientX - x0)), h: Math.round(h0 + (ev.clientY - y0)) };
          try { localStorage.setItem("tpSubSize", JSON.stringify(subSize)); } catch (_) {}
          if (isElectron && window.tp && typeof window.tp.setSubSize === "function") {
            try { window.tp.setSubSize(subSize); } catch (_) {}
          }
        });
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }
  /* زبان: یک کلیک، فوری — en ⇄ fa */
  $("btnLang").addEventListener("click", () => setLang(lang === "en" ? "fa" : "en"));
  /* پنل مدیریت وب — از هدر تمرین هم در دسترس است */
  $("btnAdmin").addEventListener("click", () => fetch("/api/admin/open", { method: "POST" }).catch(() => {}));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isElectron) window.tp.hide();
  });

  if (isElectron) {
    $("btnPin").addEventListener("click", async () => {
      const on = await window.tp.setAlwaysOnTop();
      $("btnPin").classList.toggle("off", !on);
    });
    $("btnHide").addEventListener("click", () => window.tp.hide());
  } else {
    $("winBtns").style.display = "none";
    $("btnSubHide").style.display = "none";
  }
}

function changeFont(delta) {
  const next = Math.min(26, Math.max(11, currentFontSize() + delta));
  document.documentElement.style.setProperty("--code-size", next + "px");
  const fs = $("setFont");
  if (fs) fs.textContent = next + "px";
}

/* ---------------------------------------------------------------- stream */

function connect() {
  const es = new EventSource("/events" + (TP_TOKEN ? "?token=" + encodeURIComponent(TP_TOKEN) : ""));
  es.onopen = () => console.log("[tp] sse open");
  es.addEventListener("state", (e) => {
    const prev = S.drill && S.drill.id;
    S = JSON.parse(e.data);
    if (S.drill && S.drill.id !== prev) {
      console.log("[tp] new drill " + S.drill.id);
      resetPractice(S.drill, S.progress);
      applyLayout(chooseLayout(S.drill));
      scrollCurrentIntoView();
      if (layout === "panel") $("typer").focus();
      return;
    }
    if (!S.drill && prev && layout === "subtitle") {
      /* تمرین پاک شد → پنجره به پنل/مرکز شروع برمی‌گردد */
      applyLayout("panel", false);
      return;
    }
    render();
  });
  es.addEventListener("drill", () => {});
  es.addEventListener("done", (e) => {
    let n = null;
    try { n = JSON.parse(e.data); } catch (_) {}
    showToast(notifyText(n) || "✓");
  });
  es.onerror = () => {
    console.log("[tp] sse error readyState=" + es.readyState);
    es.close();
    setTimeout(connect, 2000);
  };
}

/** تا وقتی تمرینی نیست: وضعیت اتصال‌ها و پیام سرور را تازه نگه می‌دارد */
async function idleTick() {
  if (S.drill) return;
  try {
    const r = await fetch("/api/state");
    const s = await r.json();
    if (s.drill) {
      S = s;
      resetPractice(s.drill, s.progress);
      applyLayout(chooseLayout(s.drill));
      scrollCurrentIntoView();
      return;
    }
    S = s;
    const status = $("emptyStatus");
    if (status) delete status.dataset.err;
    renderHub();
  } catch (_) {
    const status = $("emptyStatus");
    if (status) {
      status.dataset.err = "1";
      status.textContent = t("hub.statusErr");
    }
    const pill = $("hubServer");
    if (pill) pill.className = "pill bad";
  }
}

async function boot() {
  bindControls();
  bindHub();
  /* نوار سیستم می‌تواند چیدمان را عوض کند («نوار زیرنویس» در منوی ترِی) */
  if (isElectron && typeof window.tp.onLayout === "function") {
    window.tp.onLayout((l) => applyLayout(l, true));
  }
  applyLang(false); /* رندرِ اول با زبانِ انتخابی (پیش‌فرض: en) */
  try {
    const r = await fetch("/api/state");
    S = await r.json();
    if (S.drill) {
      resetPractice(S.drill, S.progress);
      applyLayout(chooseLayout(S.drill));
    }
  } catch (_) {}
  render();
  if (S.drill) {
    scrollCurrentIntoView();
    if (layout === "panel") $("typer").focus();
  }
  connect();

  setInterval(idleTick, 3000);
}

boot();
