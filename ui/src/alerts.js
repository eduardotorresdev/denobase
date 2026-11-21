import { appTimeZone, formatDateTime, offsetLabel, toDate } from "./time.js";

const ICON_ERR =
  `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 4.4v4.2M8 11.2v.1" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>`;
const ICON_WARN =
  `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" fill="currentColor"/><path d="M8 6v3.6M8 11.6v.1" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`;

/**
 * Alarms in the Dashboard's style: `{severity: "error"|"warning", title, detail?, href?}`; the detail goes in the
 * tooltip. Nothing when there is none.
 */
export function alarms(items) {
  if (!items.length) return null;
  return t.ul(
    { className: "attn-list attn-standalone" },
    ...items.map((i) =>
      t.li(
        null,
        (i.href ? t.a : t.div)(
          {
            className: `attn-item ${i.severity}${i.href ? "" : " static"}`,
            title: i.detail || "",
            ...(i.href ? { href: i.href } : {}),
          },
          t.span({ className: `attn-icon ${i.severity}`, innerHTML: i.severity === "error" ? ICON_ERR : ICON_WARN }),
          t.span({ className: "attn-text" }, t.span({ className: "attn-title", textContent: i.title })),
          i.href ? t.span({ className: "attn-go", textContent: "→" }) : null,
        ),
      )
    ),
  );
}

/** "UTC (UTC+00:00), the app timezone": the tooltip every displayed time carries. */
export function tzTip() {
  const tz = appTimeZone();
  return `${tz} (${offsetLabel(tz)}), the app timezone (Settings → Application)`;
}

/** "3m ago" / "in 58m" from now, short. */
export function rel(value, now = Date.now()) {
  const d = toDate(value);
  if (!d) return "—";
  const ms = d.getTime() - now;
  const a = Math.abs(ms) / 1000;
  const n = a < 60
    ? `${Math.round(a)}s`
    : a < 3600
    ? `${Math.round(a / 60)}m`
    : a < 172800
    ? `${Math.round(a / 3600)}h`
    : `${Math.round(a / 86400)}d`;
  return ms >= 0 ? `in ${n}` : `${n} ago`;
}

/** A relative time with the exact one (app timezone) in the tooltip. */
export function timeCell(value, now) {
  const d = toDate(value);
  if (!d) return t.span({ className: "muted", textContent: "—" });
  return t.span({ title: `${formatDateTime(d.toISOString())}\n${tzTip()}`, textContent: rel(d, now) });
}
