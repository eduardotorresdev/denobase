import { fieldErrors } from "../pb.js";
import { confirm, copyButton, field, jsonView, modal, page, toast, toastError } from "../ui.js";
import { groupFields, resolveCollection, typeBadge } from "./records/shared.js";

const SKIP = new Set(["autodate"]);

/** Create/edit/delete a record: route.params.collection, route.params.id ("new" creates). */
export async function render(route) {
  const col = await resolveCollection(route.params.collection);
  const isNew = route.params.id === "new";
  const coll = app.pb.collection(col.name);
  const original = isNew ? {} : await coll.getOne(route.params.id, { requestKey: null });
  const fileToken = isNew ? "" : await app.pb.files.getToken().catch(() => "");
  const isAuth = col.type === "auth";
  const readOnly = col.type === "view";

  const fields = (col.fields || []).filter((f) =>
    !SKIP.has(f.type) && f.name !== "tokenKey" && !(f.name === "id" && !isNew) && f.type !== "password"
  );

  const init = {};
  for (const f of fields) init[f.name] = initial(f, original[f.name], isNew);
  const state = store({
    data: init,
    files: {}, // field -> File[] to upload
    removed: {}, // field -> filenames to delete
    password: "",
    passwordConfirm: "",
    errors: {},
    busy: false,
  });

  const back = `#/records/${col.name}`;

  async function save(e) {
    e.preventDefault();
    if (state.busy || readOnly) return;
    state.busy = true;
    state.errors = {};
    try {
      const body = new FormData();
      for (const f of fields) {
        const v = state.data[f.name];
        if (f.type === "file") continue;
        if (f.name === "id" && !v) continue;
        if (f.type === "json") {
          body.append(f.name, v.trim() === "" ? "null" : v);
        } else if (f.type === "date") {
          body.append(f.name, v ? new Date(v).toISOString().replace("T", " ") : "");
        } else if (isMulti(f)) {
          const list = String(v).split(/[\s,]+/).filter(Boolean);
          if (!list.length) body.append(f.name, "");
          for (const x of list) body.append(f.name, x);
        } else {
          body.append(f.name, v == null ? "" : String(v));
        }
      }
      for (const [name, list] of Object.entries(state.files)) {
        for (const file of list) body.append(isNew ? name : `${name}+`, file);
      }
      for (const [name, list] of Object.entries(state.removed)) {
        for (const fn of list) body.append(`${name}-`, fn);
      }
      if (isAuth && (state.password || isNew)) {
        body.append("password", state.password);
        body.append("passwordConfirm", state.passwordConfirm);
      }
      const rec = isNew ? await coll.create(body) : await coll.update(original.id, body);
      toast(isNew ? "Record created" : "Record saved", "success");
      globalThis.location.hash = isNew ? `#/records/${col.name}/${rec.id}` : back;
    } catch (err) {
      state.errors = fieldErrors(err);
      toastError(err);
    } finally {
      state.busy = false;
    }
  }

  async function remove() {
    if (!(await confirm(`Delete record ${original.id}?`, { danger: true, yes: "Delete" }))) return;
    try {
      await coll.delete(original.id);
      toast("Record deleted", "success");
      globalThis.location.hash = back;
    } catch (err) {
      toastError(err);
    }
  }

  function input(f) {
    const err = () => state.errors[f.name] || "";
    const cls = () => `input${state.errors[f.name] ? " invalid" : ""}`;
    const bind = {
      disabled: readOnly,
      value: () => state.data[f.name] ?? "",
      oninput: (e) => state.data[f.name] = e.target.value,
    };
    const label = f.name + (f.required && !(f.name === "id" && f.autogeneratePattern) ? " *" : "");
    switch (f.type) {
      case "bool":
        return t.label(
          { className: "checkbox" },
          t.input({
            type: "checkbox",
            disabled: readOnly,
            checked: () => !!state.data[f.name],
            onchange: (e) => state.data[f.name] = e.target.checked,
          }),
          t.span({ textContent: f.name }),
          t.span({ className: "field-error", textContent: err }),
        );
      case "number":
        return field(label, t.input({ ...bind, className: cls, type: "number", step: f.onlyInt ? "1" : "any" }), err);
      case "email":
        return field(label, t.input({ ...bind, className: cls, type: "email" }), err);
      case "url":
        return field(label, t.input({ ...bind, className: cls, type: "url" }), err);
      case "date":
        return field(label, t.input({ ...bind, className: cls, type: "datetime-local", step: "1" }), err);
      case "editor":
        return wide(field(label, t.textarea({ ...bind, className: "textarea", rows: 6 }), err));
      case "json":
      case "geoPoint":
        return wide(field(label, t.textarea({ ...bind, className: "textarea mono", rows: 6 }), err));
      case "select":
        if (isMulti(f)) {
          return field(
            `${label} (multiple)`,
            t.select(
              {
                className: "select",
                multiple: true,
                disabled: readOnly,
                onchange: (e) => state.data[f.name] = [...e.target.selectedOptions].map((o) => o.value).join(","),
              },
              (f.values || []).map((v) =>
                t.option({ value: v, textContent: v, selected: String(state.data[f.name]).split(",").includes(v) })
              ),
            ),
            err,
          );
        }
        return field(
          label,
          t.select(
            { ...bind, className: "select", onchange: bind.oninput, oninput: undefined },
            t.option({ value: "", textContent: "(none)" }),
            (f.values || []).map((v) => t.option({ value: v, textContent: v, selected: state.data[f.name] === v })),
          ),
          err,
        );
      case "relation":
        return field(
          `${label} → ${relationName(f)}${isMulti(f) ? " (ids, comma separated)" : ""}`,
          t.div(
            { className: "row" },
            t.input({ ...bind, className: () => `${cls()} mono` }),
            readOnly ? null : t.button({
              className: "btn btn-sm",
              type: "button",
              textContent: "Pick",
              onclick: () => pickRelation(f),
            }),
          ),
          err,
        );
      case "file":
        return wide(fileInput(f, label, err));
      default:
        return field(label, t.input({ ...bind, className: cls, type: "text" }), err);
    }
  }

  function fileInput(f, label, err) {
    const existing = [].concat(original[f.name] || []).filter(Boolean);
    return field(
      label,
      t.div(
        { className: "stack" },
        existing.map((fn) =>
          t.div(
            { className: "row" },
            t.a({
              className: () => state.removed[f.name]?.includes(fn) ? "muted" : "",
              style: () => state.removed[f.name]?.includes(fn) ? "text-decoration:line-through" : "",
              href: app.pb.files.getURL(original, fn, { token: fileToken }),
              target: "_blank",
              rel: "noopener",
              textContent: fn,
            }),
            readOnly ? null : t.button({
              className: "btn btn-xs btn-ghost",
              type: "button",
              textContent: () => state.removed[f.name]?.includes(fn) ? "Undo" : "Remove",
              onclick: () => {
                const cur = state.removed[f.name] || [];
                state.removed = {
                  ...state.removed,
                  [f.name]: cur.includes(fn) ? cur.filter((x) => x !== fn) : [...cur, fn],
                };
              },
            }),
          )
        ),
        readOnly ? null : t.input({
          type: "file",
          className: "input",
          multiple: isMulti(f),
          onchange: (e) => state.files = { ...state.files, [f.name]: [...e.target.files] },
        }),
      ),
      err,
    );
  }

  function relationName(f) {
    return app.store.collections.find((c) => c.id === f.collectionId)?.name || f.collectionId;
  }

  async function pickRelation(f) {
    const target = relationName(f);
    let items = [];
    try {
      items = (await app.pb.collection(target).getList(1, 50, { skipTotal: true, requestKey: null })).items;
    } catch (err) {
      return toastError(err);
    }
    const label = (r) => {
      const c = app.store.collections.find((x) => x.name === target);
      const pres = c?.fields?.filter((x) => x.presentable).map((x) => r[x.name]).filter(Boolean) || [];
      return pres.length ? `${r.id} · ${pres.join(" · ")}` : r.id;
    };
    modal((close) =>
      items.length
        ? t.div(
          { className: "stack" },
          items.map((r) =>
            t.button({
              className: "btn btn-ghost btn-block mono",
              type: "button",
              textContent: label(r),
              onclick: () => {
                if (isMulti(f)) {
                  const cur = String(state.data[f.name] || "").split(/[\s,]+/).filter(Boolean);
                  if (!cur.includes(r.id)) cur.push(r.id);
                  state.data[f.name] = cur.join(",");
                } else {
                  state.data[f.name] = r.id;
                }
                close();
              },
            })
          ),
        )
        : t.p({ className: "muted", textContent: "No records." }), {
      title: `Pick from ${target} (first 50)`,
      size: "md",
    });
  }

  const errorCount = () => Object.keys(state.errors).length;

  function group(g) {
    return t.section(
      { className: "card" },
      t.div(
        { className: "card-head" },
        t.div({ className: "card-title", style: "margin:0", textContent: g.title }),
        t.span({
          className: "muted",
          style: "font-size:12px",
          textContent: `${g.fields.length} field${g.fields.length === 1 ? "" : "s"}`,
        }),
      ),
      t.div({ className: "form-grid" }, g.fields.map(input)),
    );
  }

  function authCard() {
    return t.section(
      { className: "card" },
      t.div(
        { className: "card-head" },
        t.div({ className: "card-title", style: "margin:0", textContent: "Password" }),
      ),
      t.div(
        { className: "form-grid" },
        field(
          isNew ? "password *" : "new password (leave empty to keep)",
          t.input({
            className: () => `input${state.errors.password ? " invalid" : ""}`,
            type: "password",
            autocomplete: "new-password",
            value: () => state.password,
            oninput: (e) => state.password = e.target.value,
          }),
          () => state.errors.password || "",
        ),
        field(
          "passwordConfirm",
          t.input({
            className: () => `input${state.errors.passwordConfirm ? " invalid" : ""}`,
            type: "password",
            autocomplete: "new-password",
            value: () => state.passwordConfirm,
            oninput: (e) => state.passwordConfirm = e.target.value,
          }),
          () => state.errors.passwordConfirm || "",
        ),
      ),
    );
  }

  return page(
    isNew ? `New ${col.name} record` : `${col.name} / ${original.id}`,
    [
      typeBadge(col.type),
      isNew ? null : copyButton(original.id, "Copy id"),
      t.a({ className: "btn btn-sm btn-ghost", href: back, textContent: "← Back" }),
    ],
    t.form(
      { className: "stack", onsubmit: save },
      groupFields(fields, col.type).map(group),
      isAuth ? authCard() : null,
      () =>
        errorCount()
          ? t.div({
            className: "alert alert-danger",
            textContent: `${errorCount()} field${errorCount() === 1 ? " has" : "s have"} errors: ${
              Object.keys(state.errors).join(", ")
            }`,
          })
          : null,
      readOnly ? t.p({ className: "muted", textContent: "View collections are read-only." }) : t.div(
        { className: "row toolbar-sticky" },
        t.button({
          className: "btn btn-primary",
          type: "submit",
          disabled: () => state.busy,
          textContent: () => state.busy ? "Saving..." : isNew ? "Create" : "Save",
        }),
        t.a({ className: "btn btn-ghost", href: back, textContent: "Cancel" }),
        t.span({ className: "spacer" }),
        isNew
          ? null
          : t.button({ className: "btn btn-danger", type: "button", textContent: "Delete", onclick: remove }),
      ),
    ),
    isNew ? null : t.details(
      { className: "card" },
      t.summary({ className: "muted", textContent: "Raw JSON" }),
      jsonView(original),
    ),
  );
}

/** Marks a field to span the whole form grid. */
function wide(el) {
  el.classList.add("wide");
  return el;
}

function isMulti(f) {
  return (f.type === "select" || f.type === "relation" || f.type === "file") && (f.maxSelect || 1) > 1;
}

/** Form value of a record field: strings for inputs, booleans for checkboxes. */
function initial(f, v, isNew) {
  if (f.type === "bool") return !!v;
  if (f.type === "file") return "";
  if (f.type === "json" || f.type === "geoPoint") {
    return v == null || (isNew && v === "") ? "" : JSON.stringify(v, null, 2);
  }
  if (f.type === "date") {
    if (!v) return "";
    const d = new Date(String(v).replace(" ", "T"));
    if (isNaN(d)) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${
      p(d.getSeconds())
    }`;
  }
  if (Array.isArray(v)) return v.join(",");
  return v == null ? "" : String(v);
}
