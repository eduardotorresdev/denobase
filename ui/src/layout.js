import { resetBootstrap } from "./router.js";
import { dismissToast } from "./ui.js";

/** 16px line icons, stroke 1.5, same grid for every nav item. */
const svg = (paths) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const ICONS = {
  dashboard: svg(
    '<rect x="2" y="2" width="5" height="5"/><rect x="9" y="2" width="5" height="5"/><rect x="2" y="9" width="5" height="5"/><rect x="9" y="9" width="5" height="5"/>',
  ),
  collections: svg(
    '<ellipse cx="8" cy="4" rx="5.5" ry="2"/><path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4"/><path d="M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>',
  ),
  logs: svg('<path d="M3 3h10M3 6.5h7M3 10h10M3 13.5h5"/>'),
  traces: svg('<path d="M2 4h6M5 8h7M8 12h6"/>'),
  crons: svg('<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>'),
  backups: svg(
    '<path d="M2.5 8a5.5 5.5 0 0 1 9.6-3.7L13.5 6"/><path d="M13.5 2.5V6H10"/><path d="M13.5 8a5.5 5.5 0 0 1-9.6 3.7L2.5 10"/><path d="M2.5 13.5V10H6"/>',
  ),
  notifications: svg('<path d="M4 6.5a4 4 0 0 1 8 0V10l1.5 2h-11L4 10z"/><path d="M6.5 14h3"/>'),
  oauth: svg('<circle cx="5.5" cy="8" r="3"/><path d="M8.5 8H14M12 8v2.5M14 8v2"/>'),
  settings: svg(
    '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  ),
};

const NAV = [
  { href: "#/", label: "Dashboard", icon: "dashboard" },
  { href: "#/logs", label: "Logs", icon: "logs" },
  { href: "#/traces", label: "Traces", icon: "traces" },
  { href: "#/crons", label: "Crons", icon: "crons" },
  { href: "#/backups", label: "Backups", icon: "backups" },
  { href: "#/notifications", label: "Notifications", icon: "notifications" },
  { href: "#/oauth", label: "OAuth", icon: "oauth" },
  { href: "#/settings", label: "Settings", icon: "settings" },
];

function isActive(href) {
  const p = app.store.path || "#/";
  return href === "#/" ? p === "#/" || p === "#" : p === href || p.startsWith(href + "/") || p.startsWith(href + "?");
}

function logout() {
  app.pb.authStore.clear();
  resetBootstrap();
  globalThis.location.hash = "#/login";
}

function collectionItem(c) {
  return t.a(
    {
      rid: c.id,
      className: () => `nav-item nav-sub ${isActive("#/records/" + c.name) ? "active" : ""}`,
      href: "#/records/" + c.name,
      title: `${c.name} (${c.type})`,
    },
    t.span({ className: `dot dot-${c.type}` }),
    t.span({ className: "nav-label", textContent: c.name }),
  );
}

const SYS_KEY = "denobase.sidebar.system";
const isSysRoute = () => (app.store.path || "").startsWith("#/records/_");

function readSysOpen() {
  try {
    return localStorage.getItem(SYS_KEY) === "1";
  } catch {
    return false;
  }
}

/** FLIP: animate every sidebar child from its old box (First) to its new one (Last). */
function flip(sidebar, mutate) {
  const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const els = [...sidebar.querySelectorAll(".nav-system-toggle ~ *, .nav-system-toggle ~ * .nav-item")];
  const first = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
  mutate();
  if (reduce) return;
  const opts = { duration: 220, easing: "cubic-bezier(.2,.7,.2,1)" };
  for (const el of sidebar.querySelectorAll(".nav-system-list .nav-item")) {
    const f = first.get(el);
    const l = el.getBoundingClientRect();
    if (f && f.height) {
      el.animate([{ transform: `translateY(${f.top - l.top}px)` }, { transform: "none" }], opts);
    } else if (l.height) {
      // Revealed item: invert to the toggle's position, then play in.
      const top = sidebar.querySelector(".nav-system-toggle").getBoundingClientRect().top;
      el.animate([{ transform: `translateY(${top - l.top}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], opts);
    }
  }
}

function systemSection() {
  let open = readSysOpen() || isSysRoute();
  const listId = "nav-system-list";
  const apply = (root) => {
    const btn = root.querySelector(".nav-system-toggle");
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-controls", listId);
    btn.classList.toggle("open", open);
    root.querySelector(".nav-system-list").hidden = !open;
  };
  const toggle = (e) => {
    const sb = e.currentTarget.closest(".sidebar");
    const list = sb.querySelector(".nav-system-list");
    open = !open;
    try {
      localStorage.setItem(SYS_KEY, open ? "1" : "0");
    } catch { /* storage unavailable */ }
    if (open) {
      flip(sb, () => apply(sb));
    } else {
      // Collapse: play items into the toggle, then hide (Last state).
      const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const btn = sb.querySelector(".nav-system-toggle");
      btn.setAttribute("aria-expanded", "false");
      btn.classList.remove("open");
      if (reduce) return apply(sb);
      const top = btn.getBoundingClientRect().top;
      const anims = [...list.querySelectorAll(".nav-item")].map((el) =>
        el.animate([{ transform: "none", opacity: 1 }, {
          transform: `translateY(${top - el.getBoundingClientRect().top}px)`,
          opacity: 0,
        }], { duration: 180, easing: "cubic-bezier(.4,0,.6,1)" })
      );
      Promise.all(anims.map((a) => a.finished)).then(() => !open && apply(sb), () => {});
    }
  };
  return t.div(
    {
      className: () => {
        // Auto-expand when navigating to a "_" collection.
        if (isSysRoute()) open = true;
        {
          queueMicrotask(() => {
            const sb = document.querySelector(".sidebar");
            if (sb) apply(sb);
          });
        }
        return "nav-system";
      },
    },
    t.button(
      {
        type: "button",
        className: () => `nav-section nav-system-toggle ${open ? "open" : ""}`,
        onclick: toggle,
      },
      t.span({ className: "nav-chevron", ariaHidden: "true", innerHTML: svg('<path d="M6 4l4 4-4 4"/>') }),
      t.span({ textContent: "System" }),
    ),
    t.nav(
      { id: listId, className: "nav nav-collections nav-system-list", hidden: !open, ariaLabel: "System collections" },
      () => app.store.collections.filter((c) => c.name.startsWith("_")).map(collectionItem),
    ),
  );
}

function sidebar() {
  return t.aside(
    { className: "sidebar" },
    t.a(
      { className: "brand", href: "#/" },
      t.img({ className: "brand-logo", src: "assets/logo.svg", alt: "" }),
      t.span({ className: "brand-name", textContent: () => app.store.settings?.meta?.appName || "Denobase" }),
    ),
    t.nav(
      { className: "nav" },
      NAV.map((n) =>
        t.a(
          { className: () => `nav-item ${isActive(n.href) ? "active" : ""}`, href: n.href, title: n.label },
          t.span({ className: "nav-icon", innerHTML: ICONS[n.icon] }),
          t.span({ className: "nav-label", textContent: n.label }),
        )
      ),
    ),
    t.div({ className: "nav-section", textContent: "Collections" }),
    t.nav(
      { className: "nav nav-collections" },
      () => app.store.collections.filter((c) => !c.name.startsWith("_")).map(collectionItem),
    ),
    systemSection(),
  );
}

function header() {
  return t.header(
    { className: "topbar" },
    t.div({ className: "topbar-title", textContent: () => app.store.title }),
    t.div(
      { className: "topbar-actions" },
      t.span({ className: "topbar-user", textContent: () => app.store.authEmail }),
      t.button({ className: "btn btn-ghost btn-sm", textContent: "Logout", onclick: logout }),
    ),
  );
}

function toasts() {
  return t.div(
    { className: "toasts" },
    () =>
      app.store.toasts.map((x) =>
        t.div({
          rid: x.id,
          className: `toast toast-${x.type}`,
          textContent: x.message,
          onclick: () => dismissToast(x.id),
        })
      ),
  );
}

/** The whole app: shell (sidebar + header + page) when signed in, the bare page on guest routes. */
export function layout() {
  // Built fresh on each switch: shablon unwatches an element's reactive parts once it leaves the DOM.
  const shell = () =>
    t.div(
      { rid: "shell", className: "shell" },
      sidebar(),
      t.div({ className: "main" }, header(), t.main({ className: "content" }, () => app.store.page)),
    );
  const bare = () => t.div({ rid: "bare", className: "bare" }, () => app.store.page);
  return t.div({ className: "app" }, () => (app.store.showShell ? shell() : bare()), toasts());
}
