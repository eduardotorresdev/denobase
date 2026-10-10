import { badge, listRow } from "../ui.js";
import { typeBadge } from "./records/shared.js";
import { openApiDocs } from "./apiDocs.js";

const ICONS = {
  base:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M2 6h12M6 6v8"/></svg>',
  auth:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="5.5" r="3"/><path d="M2.5 14c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/></svg>',
  view:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
};

/** Icon per collection type (base / auth / view). */
export function typeIcon(type) {
  return t.span({ className: `col-icon col-icon-${type || "base"}`, innerHTML: ICONS[type] || ICONS.base });
}

/** List row of a collection: icon, name, type (+ system badge), `desc` text, Records and API actions. */
export function collectionRow(c, desc) {
  const row = listRow(
    [t.span({ textContent: c.name }), typeBadge(c.type), c.system === true ? badge("system", "warning") : null],
    desc,
    [
      t.a({ className: "btn btn-sm", href: `#/records/${c.name}`, textContent: "Records" }),
      t.button({
        type: "button",
        className: "btn btn-sm btn-ghost",
        textContent: "API",
        onclick: () => openApiDocs(c),
      }),
    ],
    { lead: typeIcon(c.type) },
  );
  row.rid = c.id;
  return row;
}
