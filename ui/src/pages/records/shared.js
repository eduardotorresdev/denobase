// Helpers shared by the collections, records and recordForm pages.
import { findCollection, loadCollections } from "../../store.js";
import { badge, formatDate, jsonView, modal } from "../../ui.js";

/** Badge kind per collection type. */
export function typeBadge(type) {
  return badge(type || "base", type === "auth" ? "accent" : type === "view" ? "info" : "neutral");
}

/** Read-only schema of a collection in a modal: fields table plus the raw JSON. */
export function openSchema(col) {
  const flags = (f) =>
    [f.system && "system", f.required && "required", f.hidden && "hidden", f.presentable && "presentable"]
      .filter(Boolean).join(", ");
  modal(
    t.div(
      { className: "stack" },
      t.div(
        { className: "table-wrap" },
        t.table(
          { className: "table" },
          t.thead(
            {},
            t.tr({}, t.th({ textContent: "Field" }), t.th({ textContent: "Type" }), t.th({ textContent: "Flags" })),
          ),
          t.tbody(
            {},
            (col.fields || []).map((f) =>
              t.tr(
                {},
                t.td({ className: "mono", textContent: f.name }),
                t.td({ textContent: f.type }),
                t.td({ className: "muted", textContent: flags(f) }),
              )
            ),
          ),
        ),
      ),
      t.details({}, t.summary({ textContent: "Raw JSON" }), jsonView(col)),
    ),
    { title: `${col.name} schema`, size: "lg" },
  );
}

/** Fields grouped for the record form: system (id, dates), auth (email, verified...), then the rest. */
export function groupFields(fields, type) {
  const SYSTEM = new Set(["id", "created", "updated"]);
  const AUTH = new Set(["email", "emailVisibility", "verified", "password", "tokenKey"]);
  const groups = [
    { title: "System", fields: [] },
    { title: "Auth", fields: [] },
    { title: "Fields", fields: [] },
  ];
  for (const f of fields) {
    if (SYSTEM.has(f.name) || f.type === "autodate") groups[0].fields.push(f);
    else if (type === "auth" && AUTH.has(f.name)) groups[1].fields.push(f);
    else groups[2].fields.push(f);
  }
  return groups.filter((g) => g.fields.length);
}

/** Collection by name/id, reloading the list once if it is missing. */
export async function resolveCollection(idOrName) {
  let col = findCollection(idOrName);
  if (!col) {
    await loadCollections();
    col = findCollection(idOrName);
  }
  if (!col) throw new Error(`Collection "${idOrName}" not found.`);
  return col;
}

/** Fields shown as list columns (hidden ones and password/tokenKey are skipped). */
export function listFields(col) {
  return (col.fields || []).filter((f) => !f.hidden && f.type !== "password" && f.name !== "tokenKey");
}

/** Plain text of a record value for cells and CSV. */
export function cellText(value, field) {
  if (value == null || value === "") return "";
  if (field?.type === "date" || field?.type === "autodate") return formatDate(value);
  if (field?.type === "bool") return value ? "true" : "false";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Starts a browser download of `text`. */
export function download(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = t.a({ href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Records -> CSV text (RFC 4180 quoting). */
export function toCsv(records, fields) {
  const q = (s) => /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  const names = fields.map((f) => f.name);
  const rows = [names.map(q).join(",")];
  for (const r of records) {
    rows.push(fields.map((f) => q(cellText(r[f.name], f).replaceAll("\n", " "))).join(","));
  }
  return rows.join("\r\n");
}
