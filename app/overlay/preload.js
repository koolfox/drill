"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tp", {
  setAlwaysOnTop: () => ipcRenderer.invoke("tp:setAlwaysOnTop"),
  hide: () => ipcRenderer.invoke("tp:hide"),
  show: () => ipcRenderer.invoke("tp:show"),
  /* چیدمان پنجره: "panel" (پنجره‌ی کامل) یا "subtitle" (نوار زیرنویسِ پایین صفحه) */
  setLayout: (l) => ipcRenderer.invoke("tp:setLayout", l),
  /* نوار سیستم چیدمان را عوض کرده → رندرر هم‌زمان می‌شود */
  onLayout: (cb) => ipcRenderer.on("tp:layout", (_e, l) => cb(l)),
  /* زبان رابط → منوی ترِی هم همان را نشان می‌دهد (تفکیک کامل FA/EN) */
  setLang: (l) => ipcRenderer.send("tp:setLang", l),
  /* جای نوار زیرنویس (بالا/پایین) و اندازه‌ی دلخواهِ آن */
  setSubPos: (p) => ipcRenderer.invoke("tp:setSubPos", p),
  setSubSize: (s) => ipcRenderer.invoke("tp:setSubSize", s),
  /* پس‌ترو: true = دکمه‌ها کلیک‌خور می‌شوند؛ false = کلیک‌ها به برنامه‌ی پشت می‌رسند */
  setMouseInteractive: (on) => ipcRenderer.invoke("tp:setMouseInteractive", !!on),
});
