/**
 * Teleprompter — OpenCode TUI (CLI) layer + status line.
 *
 * Loaded automatically through the `./tui` export in package.json. Adds:
 *   - a live status slot in the footer:  ✍ 62٪ · 45wpm   (only while a drill runs)
 *   - `/teleprompter [status|open|reset|url]` slash command + palette entries
 *   - `ctrl+alt+t` to bring the overlay window up
 *   - toasts (and a system notification when the terminal is blurred) when a
 *     new drill arrives or when typing/file work completes
 */
import { Plugin } from "@opencode/plugin/tui";

const PORT = Number(process.env.TELEPROMPTER_PORT || 4783);
const BASE = `http://127.0.0.1:${PORT}`;

type DrillState = {
  drill: { id: string; title: string; targetFile?: string | null; createdAt: number } | null;
  progress: {
    total: number;
    completedBy?: string | null;
    file?: { matched: number };
    practice?: { matched: number; wpm: number };
  } | null;
};

type Status = {
  active: boolean;
  pct: number;
  wpm: number;
  file: string;
  done: string;
  title: string;
};

const EMPTY: Status = { active: false, pct: 0, wpm: 0, file: "", done: "", title: "" };

async function api(pathname: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${pathname}`, init);
  return res.json();
}

async function post(pathname: string, body?: unknown): Promise<any> {
  return api(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

function summarize(s: DrillState): string {
  if (!s.drill) return "تمرین فعالی نیست — با /drill شروع کن";
  const total = s.progress?.total || 0;
  const file = s.progress?.file?.matched || 0;
  const prac = s.progress?.practice?.matched || 0;
  const pct = total ? Math.round((Math.max(file, prac) / total) * 100) : 0;
  const wpm = s.progress?.practice?.wpm || 0;
  const done = s.progress?.completedBy ? ` · تکمیل (${s.progress.completedBy})` : "";
  return `${pct}٪ · ${wpm}wpm · فایل ${file}/${total} · «${s.drill.title}»${done}`;
}

function toStatus(s: DrillState): Status {
  if (!s.drill) return EMPTY;
  const total = s.progress?.total || 0;
  const file = s.progress?.file?.matched || 0;
  const prac = s.progress?.practice?.matched || 0;
  return {
    active: true,
    pct: total ? Math.round((Math.max(file, prac) / total) * 100) : 0,
    wpm: s.progress?.practice?.wpm || 0,
    file: `${file}/${total}`,
    done: s.progress?.completedBy ? " ✓" : "",
    title: s.drill.title,
  };
}

export default Plugin.define({
  id: "teleprompter.tui",
  async setup(context) {
    const [status, updateStatus] = context.storage.memory("teleprompter", { initial: EMPTY });

    const setStatus = (next: Status) =>
      updateStatus((draft) => {
        draft.active = next.active;
        draft.pct = next.pct;
        draft.wpm = next.wpm;
        draft.file = next.file;
        draft.done = next.done;
        draft.title = next.title;
      });

    let seenDrill: string | null = null;
    let notifiedAt = Date.now();
    let offline = false;

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ title: "تله‌پرامپتر", message, variant, duration: 6000 });

    const openOverlay = async () => {
      try {
        await post("/api/open");
        toast("پنجره‌ی تله‌پرامپتر را روی صفحه آوردیم", "success");
      } catch {
        toast("سرور تله‌پرامپتر در دسترس نیست", "error");
      }
    };

    const resetDrill = async () => {
      try {
        await post("/api/reset");
        setStatus(EMPTY);
        toast("تمرین پاک شد", "success");
      } catch {
        toast("سرور تله‌پرامپتر در دسترس نیست", "error");
      }
    };

    const tick = async () => {
      try {
        const state: DrillState = await api("/api/state");
        if (offline) {
          offline = false;
          toast("سرور تله‌پرامپتر دوباره در دسترس است", "success");
        }
        setStatus(toStatus(state));

        if (state.drill && state.drill.id !== seenDrill) {
          seenDrill = state.drill.id;
          notifiedAt = Math.max(notifiedAt, state.drill.createdAt);
          toast(`تمرین جدید: «${state.drill.title}» — ${state.progress?.total ?? 0} خط`, "info");
        }
        if (!state.drill) seenDrill = null;

        const res = await api(`/api/notifications?since=${notifiedAt}`);
        for (const n of res.notifications ?? []) {
          notifiedAt = Math.max(notifiedAt, n.at);
          toast(String(n.message ?? "تمرین تمام شد"), n.by === "file" ? "success" : "info");
          try {
            await context.attention.notify({
              title: "تله‌پرامپتر",
              message: String(n.title ?? "تمرین تایپ تمام شد"),
              notification: { when: "blurred" },
            });
          } catch {
            /* attention API optional */
          }
        }
      } catch {
        if (!offline) {
          offline = true;
          toast("سرور تله‌پرامپتر در دسترس نیست (خودش با اولین تمرین بالا می‌آید)", "warning");
        }
      }
    };

    /* live footer status — only visible while a drill is running */
    const Status = () => {
      const s = status;
      if (!s.active) return null;
      return (
        <text fg="#38bdf8">{` ✍ ${s.pct}٪ · ${s.wpm}wpm${s.done}`}</text>
      );
    };

    const offFooter = context.ui.slot({ append: "prompt.footer.status", render: () => <Status /> });
    const offHome = context.ui.slot({ append: "home.footer.status", render: () => <Status /> });

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "teleprompter.status",
          title: "Teleprompter: وضعیت تمرین (status|open|reset|url)",
          group: "Teleprompter",
          palette: true,
          slash: { name: "teleprompter", aliases: ["tp"], arguments: true },
          run: async (input?: string) => {
            const arg = (input ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
            if (arg === "open" || arg === "hide") return openOverlay();
            if (arg === "reset") return resetDrill();
            if (arg === "url") return toast(`${BASE}/`, "info");
            try {
              toast(summarize(await api("/api/state")), "info");
            } catch {
              toast("سرور تله‌پرامپتر در دسترس نیست", "error");
            }
          },
        },
        {
          id: "teleprompter.open",
          title: "Teleprompter: باز کردن پنجره‌ی تله‌پرامپتر",
          group: "Teleprompter",
          palette: true,
          bind: "ctrl+alt+t",
          run: openOverlay,
        },
        {
          id: "teleprompter.reset",
          title: "Teleprompter: پاک کردن تمرین فعلی",
          group: "Teleprompter",
          palette: true,
          run: resetDrill,
        },
      ],
      bindings: ["teleprompter.open"],
    }));

    const timer = setInterval(() => {
      void tick();
    }, 2500);
    void tick();

    return () => {
      clearInterval(timer);
      offFooter();
      offHome();
    };
  },
});
