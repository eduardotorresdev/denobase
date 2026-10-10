// Shared UI kit for pages. Everything returns plain DOM elements built with shablon's `t`.
import { dots } from "./dots.js";
import { formatDateTime } from "./time.js";

let toastSeq = 0;

/** Shows a toast for `ms` (0 = until clicked). type: "info" | "success" | "error". */
export function toast(message, type = "info", ms = 4000) {
  const id = ++toastSeq;
  app.store.toasts.push({ id, type, message: String(message) });
  if (ms) setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id) {
  const i = app.store.toasts.findIndex((x) => x.id === id);
  if (i >= 0) app.store.toasts.splice(i, 1);
}

/** Toast for a thrown SDK error (ignores autocancelled requests). */
export function toastError(err) {
  if (err?.isAbort) return;
  toast(err?.response?.message || err?.message || String(err), "error", 6000);
}

/**
 * Opens a modal and returns { el, close }. `content` is an element or (close) => element.
 * opts: { title, size: "sm"|"md"|"lg"|"full", onclose, footer: element | (close) => element }.
 */
const openModals = new Set();

/** Closes every open modal (route change: a modal never outlives its page). */
export function closeAllModals() {
  for (const close of [...openModals]) close();
}

export function modal(content, opts = {}) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openModals.delete(close);
    document.removeEventListener("keydown", onKey);
    el.remove();
    opts.onclose?.();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const body = typeof content === "function" ? content(close) : content;
  const footer = typeof opts.footer === "function" ? opts.footer(close) : opts.footer;
  const el = t.div(
    {
      className: "modal-backdrop",
      // Statement body on purpose: an on* handler returning false cancels the mousedown
      // for everything inside the dialog (native selects never open).
      onmousedown: (e) => {
        if (e.target === el) close();
      },
    },
    t.div(
      { className: `modal modal-${opts.size || "md"}`, role: "dialog" },
      t.header(
        { className: "modal-header" },
        t.h3({ className: "modal-title", textContent: opts.title || "" }),
        t.button({ className: "btn btn-ghost btn-icon", title: "Close", textContent: "×", onclick: close }),
      ),
      t.div({ className: "modal-body" }, body),
      footer ? t.footer({ className: "modal-footer" }, footer) : null,
    ),
  );
  document.addEventListener("keydown", onKey);
  document.body.appendChild(el);
  openModals.add(close);
  return { el, close };
}

/** Confirm dialog; resolves true on confirm. opts: { title, yes, danger }. */
export function confirm(message, opts = {}) {
  return new Promise((resolve) => {
    let answer = false;
    modal(t.p({ textContent: message }), {
      title: opts.title || "Are you sure?",
      size: "sm",
      onclose: () => resolve(answer),
      footer: (close) => [
        t.button({ className: "btn btn-ghost", textContent: "Cancel", onclick: close }),
        t.button({
          className: `btn ${opts.danger ? "btn-danger" : "btn-primary"}`,
          textContent: opts.yes || "Confirm",
          onmount: (b) => b.focus(),
          onclick: () => {
            answer = true;
            close();
          },
        }),
      ],
    });
  });
}

/** "2024-01-02 03:04:05.678Z" (PB date) -> "2024-01-02 00:04:05" in the app timezone (see time.js). Empty -> "". */
export function formatDate(value) {
  return formatDateTime(value);
}

/** UTC "YYYY-MM-DD HH:MM:SS" of a Date, as PB filters expect. */
export function pbDate(d) {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** <time> with the app-timezone date and the raw UTC value as tooltip. */
export function formattedDate(value) {
  return t.time({ className: "date", title: value || "", textContent: formatDate(value) || "N/A" });
}

/** Bytes -> "1.2 MB". */
export function formatBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Pretty JSON in a <pre class="code">. */
export function jsonView(value) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return t.pre({ className: "code", textContent: text ?? "null" });
}

/** Button that copies `value` (string or () => string) to the clipboard. */
export function copyButton(value, label = "Copy") {
  return t.button({
    className: "btn btn-ghost btn-xs",
    title: "Copy to clipboard",
    textContent: label,
    onclick: async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(typeof value === "function" ? value() : String(value));
        toast("Copied", "success", 1500);
      } catch {
        toast("Copy failed", "error");
      }
    },
  });
}

/** Spinner block. */
export function loading(text = "Loading...") {
  return t.div({ className: "state state-loading" }, t.span({ className: "spinner" }), t.span({ textContent: text }));
}

/** Empty state with optional action element. */
export function empty(text = "Nothing here yet.", action = null) {
  return t.div(
    { className: "state state-empty" },
    dots({ cols: 12, rows: 3, seed: 5, size: 7, gap: 3 }),
    t.span({ textContent: text }),
    action,
  );
}

/** Big number + label (+ optional delta text). value/label may be functions. */
export function stat(value, label, delta = "") {
  return t.div(
    { className: "stat" },
    t.span({ className: "stat-value", textContent: value }),
    t.span({ className: "stat-label", textContent: label }),
    delta ? t.span({ className: "stat-delta", textContent: delta }) : null,
  );
}

/** List row: title (element or text), description, actions (elements). opts: { href, onclick, lead }. */
export function listRow(title, desc, actions = [], opts = {}) {
  const tag = opts.href ? "a" : "div";
  return t[tag](
    { className: "list-row", href: opts.href, onclick: opts.onclick },
    opts.lead || null,
    t.div(
      { className: "list-row-main" },
      t.div({ className: "list-row-title" }, typeof title === "string" ? t.span({ textContent: title }) : title),
      desc ? t.div({ className: "list-row-desc", textContent: desc }) : null,
    ),
    t.div({ className: "list-row-actions" }, ...[].concat(actions)),
  );
}

/** Tabbed code block: snippets = [{ label, code }]. Dark code panel with a Copy button. */
export function codeTabs(snippets) {
  const s = store({ i: 0 });
  return t.div(
    { className: "code-tabs" },
    t.div(
      { className: "tabs" },
      snippets.map((x, i) =>
        t.button({
          type: "button",
          className: () => `tab ${s.i === i ? "active" : ""}`,
          textContent: x.label,
          onclick: () => s.i = i,
        })
      ),
      t.span({ className: "spacer" }),
      copyButton(() => snippets[s.i].code),
    ),
    t.pre({ className: "code", textContent: () => snippets[s.i].code }),
  );
}

/** Error state for a failed load, with a retry button. */
export function errorState(err, retry) {
  return t.div(
    { className: "state state-error" },
    t.span({ textContent: err?.response?.message || err?.message || String(err) }),
    retry ? t.button({ className: "btn btn-sm", textContent: "Retry", onclick: retry }) : null,
  );
}

/** Colored pill. kind: "neutral" | "info" | "success" | "warning" | "danger" | "accent". */
export function badge(text, kind = "neutral") {
  return t.span({ className: `badge badge-${kind}`, textContent: text });
}

/**
 * Pager for list results. state is a store with { page, perPage, totalItems, totalPages };
 * onchange(page) is called on navigation. totalItems -1 (skipTotal) shows only prev/next.
 */
export function pager(state, onchange) {
  return t.div(
    { className: "pager" },
    t.span({
      className: "pager-info",
      textContent: () => state.totalItems >= 0 ? `${state.totalItems} item${state.totalItems === 1 ? "" : "s"}` : "",
    }),
    t.button({
      className: "btn btn-sm btn-ghost",
      textContent: "‹ Prev",
      disabled: () => state.page <= 1,
      onclick: () => onchange(state.page - 1),
    }),
    t.span({
      className: "pager-page",
      textContent: () => state.totalPages > 0 ? `${state.page} / ${state.totalPages}` : String(state.page),
    }),
    t.button({
      className: "btn btn-sm btn-ghost",
      textContent: "Next ›",
      disabled: () => state.totalPages >= 0 && state.page >= state.totalPages,
      onclick: () => onchange(state.page + 1),
    }),
  );
}

/** Page wrapper: actions bar and body. The title is shown only in the topbar (app.store.title). */
export function page(title, actions, ...children) {
  app.store.title = title;
  return t.section(
    { className: "page" },
    t.header(
      { className: "page-header" },
      t.div({ className: "page-actions" }, actions),
    ),
    t.div({ className: "page-body" }, ...children),
  );
}

/** Runs `fn` when `el` unmounts, chained before shablon's own hook (which releases the element watchers). */
export function onUnmount(el, fn) {
  const prev = el.onunmount;
  el.onunmount = (...args) => {
    fn();
    prev?.(...args);
  };
  return el;
}

/** Labeled form field wrapper; error is a string or () => string. */
export function field(label, input, error = "") {
  return t.label(
    { className: "field" },
    t.span({ className: "field-label", textContent: label }),
    input,
    t.span({ className: "field-error", textContent: error }),
  );
}

/** Truncated text with full value as tooltip. */
export function ellipsis(text, max = 60) {
  const s = text == null ? "" : String(text);
  return t.span({ className: "ellipsis", title: s, textContent: s.length > max ? s.slice(0, max) + "…" : s });
}
