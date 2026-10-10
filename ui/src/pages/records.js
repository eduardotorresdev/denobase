import {
  badge,
  confirm,
  empty,
  errorState,
  formattedDate,
  loading,
  onUnmount,
  page,
  pager,
  toast,
  toastError,
} from "../ui.js";
import { cellText, download, listFields, openSchema, resolveCollection, toCsv, typeBadge } from "./records/shared.js";
import { openApiDocs } from "./apiDocs.js";

const PER_PAGE = 30;
const FLASH_MS = 4000;

/** Records list of route.params.collection: filter/sort, skipTotal paging, live realtime updates, export. */
export async function render(route) {
  const col = await resolveCollection(route.params.collection);
  const fields = listFields(col);
  const hasCreated = fields.some((f) => f.name === "created");
  const state = store({
    filter: route.query.filter?.[0] || "",
    draft: route.query.filter?.[0] || "",
    sort: route.query.sort?.[0] ?? (hasCreated ? "-created" : ""),
    page: 1,
    perPage: PER_PAGE,
    totalItems: -1,
    totalPages: -1,
    items: [],
    loading: true,
    error: null,
    live: true,
    flash: {},
  });
  let seq = 0;
  let unsub = null;

  async function load(p = state.page) {
    const mine = ++seq;
    state.loading = true;
    state.error = null;
    try {
      const opts = { skipTotal: true, requestKey: null };
      if (state.filter) opts.filter = state.filter;
      if (state.sort) opts.sort = state.sort;
      const res = await app.pb.collection(col.name).getList(p, PER_PAGE, opts);
      if (mine !== seq) return;
      state.items = res.items;
      state.page = p;
      // skipTotal: we only know there is no next page when this one is short.
      state.totalItems = -1;
      state.totalPages = res.items.length < PER_PAGE ? p : -1;
      count(mine);
    } catch (err) {
      if (mine === seq) state.error = err;
    } finally {
      if (mine === seq) state.loading = false;
    }
  }

  // Total in the background (PB UI's separate count request), so the list paints first.
  async function count(mine) {
    try {
      const opts = { fields: "id", skipTotal: false, requestKey: null };
      if (state.filter) opts.filter = state.filter;
      const res = await app.pb.collection(col.name).getList(1, 1, opts);
      if (mine !== seq) return;
      state.totalItems = res.totalItems;
      state.totalPages = Math.max(1, Math.ceil(res.totalItems / PER_PAGE));
    } catch { /* count is optional */ }
  }

  function flash(id, kind) {
    state.flash = { ...state.flash, [id]: kind };
    setTimeout(() => {
      const next = { ...state.flash };
      delete next[id];
      state.flash = next;
    }, FLASH_MS);
  }

  function onEvent(e) {
    const r = e.record;
    const i = state.items.findIndex((x) => x.id === r.id);
    if (e.action === "delete") {
      if (i >= 0) state.items = state.items.filter((x) => x.id !== r.id);
      return;
    }
    if (i >= 0) {
      const items = state.items.slice();
      items[i] = r;
      state.items = items;
      flash(r.id, "updated");
    } else if (e.action === "create" && state.page === 1 && !state.filter) {
      state.items = [r, ...state.items].slice(0, PER_PAGE);
      if (state.totalItems >= 0) state.totalItems++;
      flash(r.id, "created");
    }
  }

  async function subscribe() {
    try {
      unsub = await app.pb.collection(col.name).subscribe("*", onEvent);
    } catch (err) {
      state.live = false;
      toastError(err);
    }
  }

  async function unsubscribe() {
    const fn = unsub;
    unsub = null;
    try {
      await fn?.();
    } catch { /* already gone */ }
  }

  function toggleLive() {
    state.live = !state.live;
    if (state.live) subscribe();
    else unsubscribe();
  }

  function sortBy(name) {
    state.sort = state.sort === name ? `-${name}` : state.sort === `-${name}` ? "" : name;
    load(1);
  }

  function applyFilter(e) {
    e?.preventDefault();
    state.filter = state.draft.trim();
    load(1);
  }

  function exportAs(kind) {
    const base = `${col.name}-p${state.page}`;
    if (kind === "json") download(`${base}.json`, JSON.stringify(state.items, null, 2), "application/json");
    else download(`${base}.csv`, toCsv(state.items, fields), "text/csv");
    toast(`Exported ${state.items.length} records`, "success", 2000);
  }

  async function remove(rec, ev) {
    ev.stopPropagation();
    if (!(await confirm(`Delete record ${rec.id}?`, { danger: true, yes: "Delete" }))) return;
    try {
      await app.pb.collection(col.name).delete(rec.id);
      toast("Record deleted", "success");
      load();
    } catch (err) {
      toastError(err);
    }
  }

  function header(f) {
    return t.th(
      { className: "sortable", onclick: () => sortBy(f.name), title: `Sort by ${f.name}` },
      f.name,
      () => state.sort === f.name ? " ↑" : state.sort === `-${f.name}` ? " ↓" : "",
    );
  }

  function cell(rec, f) {
    const v = rec[f.name];
    if (f.type === "date" || f.type === "autodate") return t.td({ className: "muted" }, v ? formattedDate(v) : "");
    if (f.type === "bool") return t.td({}, badge(v ? "true" : "false", v ? "accent" : "neutral"));
    if (f.name === "id") return t.td({ className: "mono", textContent: v });
    if (f.type === "relation" || f.type === "file") {
      return t.td({ className: "mono muted", textContent: cellText(v, f) });
    }
    const s = cellText(v, f);
    return t.td({ className: "ellipsis", title: s, textContent: s.length > 80 ? s.slice(0, 80) + "…" : s });
  }

  const readOnly = col.type === "view";
  const href = (rec) => `#/records/${col.name}/${rec.id}`;

  const el = page(
    col.name,
    [
      typeBadge(col.type),
      t.button({
        className: () => `btn btn-sm ${state.live ? "" : "btn-ghost"}`,
        title: "Realtime updates",
        textContent: () => state.live ? "● Live" : "○ Live off",
        onclick: toggleLive,
      }),
      t.button({ className: "btn btn-sm btn-ghost", textContent: "Export JSON", onclick: () => exportAs("json") }),
      t.button({ className: "btn btn-sm btn-ghost", textContent: "Export CSV", onclick: () => exportAs("csv") }),
      t.button({ className: "btn btn-sm btn-ghost", textContent: "Schema", onclick: () => openSchema(col) }),
      t.button({ className: "btn btn-sm btn-ghost", textContent: "API", onclick: () => openApiDocs(col) }),
      readOnly
        ? null
        : t.a({ className: "btn btn-sm btn-primary", href: `#/records/${col.name}/new`, textContent: "New" }),
    ],
    t.form(
      { className: "searchbar", onsubmit: applyFilter },
      t.input({
        className: "input",
        placeholder: `Filter, e.g. id != "" && created > "2024-01-01"`,
        value: () => state.draft,
        oninput: (e) => state.draft = e.target.value,
      }),
      t.button({ className: "btn btn-sm", type: "submit", textContent: "Search" }),
      t.button({
        className: "btn btn-sm btn-ghost",
        type: "button",
        textContent: "Clear",
        hidden: () => !state.filter,
        onclick: () => {
          state.draft = "";
          applyFilter();
        },
      }),
    ),
    () => {
      if (state.error) return errorState(state.error, () => load());
      if (state.loading && !state.items.length) return loading();
      if (!state.items.length) {
        return empty(
          state.filter ? "No records match the filter." : "No records yet.",
          readOnly || state.filter ? null : t.a({
            className: "btn btn-sm btn-primary",
            href: `#/records/${col.name}/new`,
            textContent: "New record",
          }),
        );
      }
      return t.div(
        { className: "table-wrap" },
        t.table(
          { className: "table" },
          t.thead({}, t.tr({}, fields.map(header), readOnly ? null : t.th({}))),
          t.tbody(
            {},
            state.items.map((rec) =>
              t.tr(
                {
                  className: () => `clickable ${state.flash[rec.id] ? "flash" : ""}`,
                  title: () => state.flash[rec.id] ? `Live: ${state.flash[rec.id]}` : "",
                  onclick: () => globalThis.location.hash = href(rec),
                },
                fields.map((f) => cell(rec, f)),
                readOnly ? null : t.td(
                  { className: "actions" },
                  t.button({
                    className: "btn btn-xs btn-ghost",
                    textContent: "Delete",
                    onclick: (e) => remove(rec, e),
                  }),
                ),
              )
            ),
          ),
        ),
      );
    },
    pager(state, (p) => load(p)),
  );

  onUnmount(el, () => {
    seq++;
    unsubscribe();
  });
  load(1);
  if (state.live) subscribe();
  return el;
}
