/* Teleprompter web admin panel — system, setup, drills, server settings */
"use strict";

const $ = (id) => document.getElementById(id);
const LANGS = window.TP_LANGS || { en: { name: "English", dir: "ltr", s: {} } };
let lang = "en";
try {
  const saved = localStorage.getItem("tpLang");
  if (saved && LANGS[saved]) lang = saved;
} catch (_) {}

function t(key) {
  return (LANGS[lang] && LANGS[lang].s[key]) || LANGS.en.s[key] || key;
}

function setLang(l) {
  if (!LANGS[l]) return;
  lang = l;
  try {
    localStorage.setItem("tpLang", l);
  } catch (_) {}
  applyLang();
  void refresh();
}

function applyLang() {
  const L = LANGS[lang] || LANGS.en;
  document.documentElement.lang = lang;
  document.documentElement.dir = L.dir;
  document.title = t("admin.title");
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  document.querySelectorAll("#langSeg button").forEach((b) =>
    b.classList.toggle("on", b.getAttribute("data-setlang") === lang),
  );
}

/* توکن از ‎?token=‎ می‌آید (Electron و لینک‌ها همان را می‌گذارند) */
let TOKEN = "";
try {
  TOKEN = new URLSearchParams(location.search).get("token") || "";
} catch (_) {}

const withTok = (p) => (TOKEN ? p + (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN) : p);

async function api(p, body) {
  const r = await fetch(withTok(p), body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  if (r.status === 401) {
    showGate();
    throw new Error("unauthorized");
  }
  return r.json();
}

function showGate() {
  $("app").classList.add("hidden");
  $("gate").classList.remove("hidden");
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function kvRow(dl, label, value, cls) {
  dl.appendChild(el("dt", label));
  const dd = el("dd", typeof value === "string" ? value : String(value == null ? "" : value), cls);
  dl.appendChild(dd);
  return dd;
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function uptime(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function refresh() {
  let sys, st, notes, cfg;
  try {
    [sys, st, notes, cfg] = await Promise.all([
      api("/api/admin/system"),
      api("/api/state"),
      api("/api/notifications?since=0"),
      api("/api/admin/settings"),
    ]);
  } catch (_) {
    return;
  }

  /* سیستم */
  const dl = $("sysKv");
  dl.innerHTML = "";
  kvRow(dl, t("admin.platform"), `${sys.platform}`, "mono");
  kvRow(dl, t("admin.node"), sys.node, "mono");
  kvRow(dl, t("admin.uptime"), uptime(sys.uptimeSec), "mono");
  kvRow(dl, t("admin.port"), String(sys.port), "mono");
  kvRow(dl, t("admin.token"), t(sys.tokenSet ? "admin.tokenOn" : "admin.tokenOff"), sys.tokenSet ? "ok" : "bad");
  kvRow(
    dl,
    t("admin.stateFile"),
    sys.stateFile.exists ? `${sys.stateFile.path} (${sys.stateFile.size} B)` : t("admin.none"),
    sys.stateFile.exists ? "mono" : "",
  );

  const il = $("installList");
  il.innerHTML = "";
  const inst = [
    ["Electron runtime", sys.install.electron],
    ["install.sh", sys.install.installSh],
  ];
  for (const [name, v] of inst) {
    const li = el("li");
    li.appendChild(el("span", name));
    const pill = el("span", v.ok ? "OK" : "—", "pill " + (v.ok ? "on" : "off"));
    pill.title = v.path || "";
    li.appendChild(pill);
    il.appendChild(li);
  }

  /* هدف‌های نصب — هر کدام با وضعیت و دکمه‌ی خودش (از همان API نصب می‌شوند) */
  const it = $("installTargets");
  if (it) {
    it.innerHTML = "";
    for (const k of ["opencode", "vscode", "codex", "claude", "gemini", "app", "login"]) {
      const v = (sys.install && sys.install[k]) || { ok: false, path: "" };
      const li = el("li");
      li.appendChild(el("span", k, "mono"));
      const pill = el("span", v.ok ? "OK" : "—", "pill " + (v.ok ? "on" : "off"));
      pill.title = v.path || "";
      li.appendChild(pill);
      const b = el("button", t("admin.installOne"), "btn");
      b.addEventListener("click", () => {
        b.disabled = true;
        api("/api/admin/install", { target: k })
          .then(() => setTimeout(() => { b.disabled = false; installLog(); refresh(); }, 3000))
          .catch(() => { b.disabled = false; });
      });
      li.appendChild(b);
      it.appendChild(li);
    }
  }

  /* وضعیت زنده */
  const lv = $("liveKv");
  lv.innerHTML = "";
  const d = st.drill;
  kvRow(lv, t("admin.activeDrill"), d ? `${d.title} (${d.mode})` : t("admin.none"));
  if (d && d.targetFile) kvRow(lv, t("admin.kDest"), `${d.targetFile}:${d.startLine || 1}`, "mono");
  if (d && st.progress) {
    const p = st.progress;
    kvRow(lv, t("admin.kFile"), `${(p.file && p.file.matched) || 0}/${p.total || 0}`, "mono");
    kvRow(lv, t("admin.kPractice"), `${(p.practice && p.practice.matched) || 0}/${p.total || 0}`, "mono");
    if (p.verification) kvRow(lv, t("admin.kVerify"), p.verification.ok ? "✓" : `✗ exit ${p.verification.code}`, p.verification.ok ? "ok" : "bad");
  }
  kvRow(lv, t("admin.queued"), String(st.queueLen || 0), "mono");
  const unacked = (notes.notifications || []).length;
  kvRow(lv, t("admin.unacked"), String(unacked), unacked ? "bad" : "ok");
  const det = st.integrationDetails || {};
  const integ = Object.entries(st.integrations || {})
    .map(([k, ts]) => {
      const d = det[k] || {};
      const bits = [];
      if (d.drillSeen) bits.push(`sees:${d.drillId || "?"}`);
      if (d.targetOpen) bits.push("target:open");
      if (d.stateOk === false) bits.push("state:ERR");
      if (d.err) bits.push(`err:${String(d.err).slice(0, 60)}`);
      return `${k} ${ago(ts)}${bits.length ? " [" + bits.join(" ") + "]" : ""}`;
    })
    .join(" · ");
  kvRow(lv, t("admin.hb"), integ || t("admin.none"), "mono");

  /* صف */
  const ql = $("queueList");
  ql.innerHTML = "";
  const q = st.queue || [];
  if (!d && !q.length) ql.appendChild(el("li", t("admin.none")));
  q.forEach((qd, i) => {
    const li = el("li");
    li.appendChild(el("span", `#${i + 1} ${qd.title}`, "mono"));
    li.appendChild(el("span", qd.targetFile ? `${qd.targetFile}:${qd.startLine || 1}` : (qd.mode || ""), "pill off"));
    ql.appendChild(li);
  });

  /* تنظیمات */
  if (cfg && cfg.settings) {
    $("setMatch").value = cfg.settings.defaultMatchMode || "exact";
    $("setQueueMax").value = cfg.settings.queueMax;
    $("setNotifyMax").value = cfg.settings.notifyMax;
    $("setVerifyTimeout").value = cfg.settings.verifyTimeoutSec;
  }

  /* اتاق فرمان: بک‌اندها + فایلِ مقصد */
  const bInteg = st.integrations || {};
  const idet = st.integrationDetails || {};
  const bl = $("backendList");
  if (bl) {
    bl.innerHTML = "";
    const rows = Object.keys(bInteg);
    if (!rows.length) bl.appendChild(el("li", t("admin.none")));
    for (const k of rows) {
      const dd = idet[k] || {};
      const li = el("li");
      li.appendChild(el("span", k, "mono"));
      const bits = [`${ago(bInteg[k])}`];
      if (dd.drillSeen) bits.push("sees drill");
      if (dd.targetOpen) bits.push("file open");
      li.appendChild(el("span", bits.join(" · ")));
      li.appendChild(el("span", "●", "pill " + (Date.now() - bInteg[k] < 45000 ? "on" : "off")));
      bl.appendChild(li);
    }
  }
  const fv = $("fileView");
  if (fv) {
    if (d && d.targetFile) {
      try {
        const fr = await api(`/api/file?path=${encodeURIComponent(d.targetFile)}&center=${d.startLine || 1}&context=30`);
        if (fr && fr.exists) {
          fv.textContent = fr.lines.map((ln, i) => `${String(fr.from + i).padStart(4)}  ${ln}`).join("\n");
        } else {
          fv.textContent = t("admin.none");
        }
      } catch (_) {
        fv.textContent = t("admin.none");
      }
    } else {
      fv.textContent = t("admin.none");
    }
  }
  const askBtn = $("btnAsk");
  if (askBtn && !askBtn.onclick) {
    askBtn.onclick = async () => {
      const inp = $("askInput");
      const msg = $("askMsg");
      const text = (inp && inp.value) || "";
      if (!text.trim()) return;
      try {
        const r = await api("/api/ask", { text: text.trim() });
        if (msg) msg.textContent = r && r.ok ? t("admin.sent") : t("admin.cannotReach");
        if (inp && r && r.ok) inp.value = "";
      } catch (_) {
        if (msg) msg.textContent = t("admin.cannotReach");
      }
      setTimeout(() => { if (msg) msg.textContent = ""; }, 3000);
    };
  }

  /* اعلان‌ها */
  const nl = $("notesList");
  nl.innerHTML = "";
  const all = (notes.notifications || []).slice(-15).reverse();
  if (!all.length) nl.appendChild(el("li", t("admin.none")));
  for (const n of all) {
    const li = el("li");
    let txt = `${n.title} — ${n.by}`;
    if (n.params && n.params.verify) txt += n.params.verify.ok ? " · verify ✓" : ` · verify ✗(${n.params.verify.code})`;
    li.appendChild(el("span", txt));
    li.appendChild(el("span", n.acked ? "acked" : "…", "pill " + (n.acked ? "on" : "off")));
    nl.appendChild(li);
  }
}

async function installLog() {
  try {
    const r = await api("/api/admin/install/log");
    $("installLog").textContent = (r && r.log) || "";
    $("installLog").scrollTop = 1e9;
  } catch (_) {}
}

function bind() {
  document.querySelectorAll("#langSeg button").forEach((b) =>
    b.addEventListener("click", () => setLang(b.getAttribute("data-setlang"))),
  );
  $("tokenApply").addEventListener("click", () => {
    const v = $("tokenInput").value || "";
    location.search = v ? "?token=" + encodeURIComponent(v) : "";
  });
  $("tokenInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("tokenApply").click();
  });
  $("btnHub").addEventListener("click", () => {
    location.href = "/" + (TOKEN ? "?token=" + encodeURIComponent(TOKEN) : "");
  });
  $("btnOverlay").addEventListener("click", () => void api("/api/open", {}).catch(() => {}));
  $("btnNext").addEventListener("click", () => void api("/api/next", {}).then(refresh).catch(() => {}));
  $("btnQueueClear").addEventListener("click", () => void api("/api/queue/clear", {}).then(refresh).catch(() => {}));
  $("btnResetNext").addEventListener("click", () => void api("/api/reset", {}).then(refresh).catch(() => {}));
  $("btnResetAll").addEventListener("click", () => void api("/api/reset", { all: true }).then(refresh).catch(() => {}));
  $("btnPushTest").addEventListener("click", () =>
    void api("/api/drill", {
      id: "admin-test-" + Date.now(),
      title: "Admin test drill",
      language: "text",
      mode: "practice",
      source: "admin",
      code: "hello admin\nsecond line\n",
    }).then(refresh).catch(() => {}),
  );
  $("btnSave").addEventListener("click", async () => {
    try {
      const r = await api("/api/admin/settings", {
        defaultMatchMode: $("setMatch").value,
        queueMax: Number($("setQueueMax").value),
        notifyMax: Number($("setNotifyMax").value),
        verifyTimeoutSec: Number($("setVerifyTimeout").value),
      });
      if (r && r.ok) {
        $("saveMsg").textContent = t("admin.saved");
        setTimeout(() => ($("saveMsg").textContent = ""), 2500);
      }
    } catch (_) {}
  });
  $("btnInstall").addEventListener("click", async () => {
    try {
      await api("/api/admin/install", {});
      setTimeout(installLog, 1500);
    } catch (_) {}
  });
  $("btnInstallLog").addEventListener("click", installLog);
}

(async function boot() {
  applyLang();
  bind();
  try {
    await api("/api/admin/system");
    $("gate").classList.add("hidden");
    $("app").classList.remove("hidden");
    await refresh();
    await installLog();
    setInterval(refresh, 5000);
  } catch (_) {
    /* showGate از داخل api صدا زده شده */
  }
})();
