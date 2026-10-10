import { errMessage, fieldErrors } from "../pb.js";
import {
  confirm,
  empty,
  errorState,
  field,
  formatBytes,
  formattedDate,
  loading,
  modal,
  page,
  toast,
  toastError,
} from "../ui.js";
import { humanizeCron } from "../cron.js";
import { scheduleField } from "../schedule.js";

/** Backups: list, create, upload, download, restore, delete (PB backup routes). */
export function render(_route) {
  const data = store({ items: [], loading: true, error: null, busy: "" });

  async function load() {
    data.loading = true;
    data.error = null;
    try {
      const items = await app.pb.backups.getFullList();
      data.items = items.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
    } catch (err) {
      if (!err?.isAbort) data.error = err;
    } finally {
      data.loading = false;
    }
  }

  function openCreate() {
    const f = store({ name: "", error: "", busy: false });
    modal((close) =>
      t.form(
        {
          className: "form",
          onsubmit: async (e) => {
            e.preventDefault();
            if (f.busy) return;
            f.busy = true;
            f.error = "";
            try {
              await app.pb.backups.create(f.name.trim());
              toast("Backup created.", "success");
              close();
              load();
            } catch (err) {
              f.error = fieldErrors(err).name || errMessage(err);
            } finally {
              f.busy = false;
            }
          },
        },
        field(
          "Name (optional, e.g. my_backup.zip)",
          t.input({
            className: () => f.error ? "input invalid mono" : "input mono",
            placeholder: "Leave empty for an auto-generated name",
            value: () => f.name,
            oninput: (e) => f.name = e.target.value,
            onmount: (el) => el.focus(),
          }),
          () => f.error,
        ),
        t.div(
          { className: "row" },
          t.span({ className: "spacer" }),
          t.button({ type: "button", className: "btn btn-ghost", textContent: "Cancel", onclick: close }),
          t.button({
            type: "submit",
            className: "btn btn-primary",
            disabled: () => f.busy,
            textContent: () => f.busy ? "Creating..." : "Create backup",
          }),
        ),
      ), { title: "Create backup", size: "sm" });
  }

  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    data.busy = "upload";
    try {
      const form = new FormData();
      form.append("file", file);
      await app.pb.backups.upload(form);
      toast(`Uploaded "${file.name}".`, "success");
      load();
    } catch (err) {
      const fe = fieldErrors(err);
      toast(fe.file || errMessage(err), "error", 6000);
    } finally {
      data.busy = "";
    }
  }

  async function download(key) {
    try {
      const token = await app.pb.files.getToken();
      const a = document.createElement("a");
      a.href = app.pb.backups.getDownloadURL(token, key);
      a.download = key;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      toastError(err);
    }
  }

  function restore(key) {
    const f = store({ typed: "", busy: false });
    modal((close) =>
      t.div(
        { className: "stack" },
        t.div({
          className: "alert alert-warning",
          textContent: "Restoring replaces ALL current data with the backup content and restarts the app state. " +
            "This cannot be undone.",
        }),
        field(
          `Type "${key}" to confirm`,
          t.input({
            className: "input mono",
            value: () => f.typed,
            oninput: (e) => f.typed = e.target.value,
            onmount: (el) => el.focus(),
          }),
        ),
        t.div(
          { className: "row" },
          t.span({ className: "spacer" }),
          t.button({ className: "btn btn-ghost", textContent: "Cancel", onclick: close }),
          t.button({
            className: "btn btn-danger",
            disabled: () => f.busy || f.typed !== key,
            textContent: () => f.busy ? "Restoring..." : "Restore backup",
            onclick: async () => {
              f.busy = true;
              try {
                await app.pb.backups.restore(key);
                toast("Restore started. The page will reload shortly.", "success");
                close();
                setTimeout(() => globalThis.location.reload(), 3000);
              } catch (err) {
                toastError(err);
              } finally {
                f.busy = false;
              }
            },
          }),
        ),
      ), { title: "Restore backup", size: "sm" });
  }

  async function remove(key) {
    if (!(await confirm(`Delete backup "${key}"?`, { danger: true, yes: "Delete" }))) return;
    try {
      await app.pb.backups.delete(key);
      toast("Backup deleted.", "success");
      load();
    } catch (err) {
      toastError(err);
    }
  }

  load();

  const fileInput = t.input({ type: "file", accept: ".zip,application/zip", hidden: true, onchange: upload });

  function table() {
    return t.div(
      { className: "table-wrap" },
      t.table(
        { className: "table" },
        t.thead(
          {},
          t.tr(
            {},
            t.th({ textContent: "Name" }),
            t.th({ textContent: "Size" }),
            t.th({ textContent: "Date" }),
            t.th({}),
          ),
        ),
        t.tbody(
          {},
          data.items.map((b) =>
            t.tr(
              { rid: b.key },
              t.td({ className: "mono", textContent: b.key }),
              t.td({ className: "muted", textContent: formatBytes(b.size) }),
              t.td({}, formattedDate(b.modified)),
              t.td(
                { className: "actions" },
                t.button({
                  className: "btn btn-xs btn-ghost",
                  textContent: "Download",
                  onclick: () => download(b.key),
                }),
                t.button({ className: "btn btn-xs btn-ghost", textContent: "Restore", onclick: () => restore(b.key) }),
                t.button({ className: "btn btn-xs btn-danger", textContent: "Delete", onclick: () => remove(b.key) }),
              ),
            )
          ),
        ),
      ),
    );
  }

  const settings = () => app.store.settings?.backups || {};
  const CLOCK =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>';

  function autoBackupCta() {
    const cron = () => settings().cron || "";
    return t.button({
      type: "button",
      className: () => cron() ? "btn btn-sm auto-backup-cta is-on" : "btn btn-sm auto-backup-cta",
      title: () => cron() ? `Auto backup cron: ${cron()}` : "Configure automatic backups",
      onclick: () => openAutoBackup(),
    }, () =>
      cron()
        ? [
          t.span({ className: "auto-backup-dot", ariaHidden: "true" }),
          t.span({ textContent: `${humanizeCron(cron())} · keep ${settings().cronMaxKeep ?? 0}` }),
        ]
        : [
          t.span({ className: "auto-backup-icon", innerHTML: CLOCK }),
          t.span({ textContent: "Set up automatic backups" }),
        ]);
  }

  function openAutoBackup() {
    const cfg = settings();
    const f = store({
      enabled: !!cfg.cron,
      cron: cfg.cron || "0 2 * * *",
      keep: Number(cfg.cronMaxKeep) || 3,
      busy: false,
      error: "",
    });
    const expr = () => f.cron;

    async function save(close) {
      const next = { cron: f.enabled ? expr().trim() : "", cronMaxKeep: Math.max(1, Math.trunc(f.keep)) };
      const body = {};
      for (const [k, v] of Object.entries(next)) if (v !== (cfg[k] ?? (k === "cron" ? "" : undefined))) body[k] = v;
      if (!Object.keys(body).length) return close();
      f.busy = true;
      f.error = "";
      try {
        app.store.settings = await app.pb.settings.update({ backups: body });
        toast("Auto backup settings saved.", "success");
        close();
      } catch (err) {
        const fe = err?.response?.data?.backups || {};
        f.error = fe.cron?.message || fe.cronMaxKeep?.message || errMessage(err);
      } finally {
        f.busy = false;
      }
    }

    const off = () => !f.enabled;
    modal((close) =>
      t.form(
        { className: "form auto-backup-form", onsubmit: (e) => (e.preventDefault(), !f.busy && save(close)) },
        t.label(
          { className: "field field-check" },
          t.button({
            type: "button",
            role: "switch",
            className: "switch",
            ariaChecked: () => String(f.enabled),
            onclick: () => f.enabled = !f.enabled,
          }, t.span({ className: "switch-knob" })),
          t.span({ className: "field-label", textContent: "Enable automatic backups" }),
        ),
        t.div(
          { className: () => f.enabled ? "auto-backup-schedule" : "auto-backup-schedule is-off" },
          scheduleField({ value: f.cron, onChange: (c) => f.cron = c, disabled: off }),
        ),
        field(
          "Max backups to keep",
          t.div(
            { className: "stepper" },
            t.button({
              type: "button",
              className: "stepper-btn",
              ariaLabel: "Decrease by 1",
              textContent: "\u2212",
              disabled: () => off() || f.keep <= 1,
              onclick: () => f.keep = Math.max(1, f.keep - 1),
            }),
            t.input({
              className: "input stepper-input",
              type: "number",
              inputMode: "numeric",
              min: 1,
              step: 1,
              disabled: off,
              value: () => String(f.keep),
              oninput: (e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && e.target.value !== "") f.keep = Math.max(1, Math.trunc(v));
              },
            }),
            t.button({
              type: "button",
              className: "stepper-btn",
              ariaLabel: "Increase by 1",
              textContent: "+",
              disabled: off,
              onclick: () => f.keep += 1,
            }),
          ),
        ),
        field(
          "Storage",
          t.div({
            className: "muted",
            textContent: cfg.s3?.enabled ? `S3 · ${cfg.s3.bucket}` : "Local (pb_data/backups)",
          }),
        ),
        () => f.error ? t.div({ className: "alert alert-danger", textContent: f.error }) : null,
        t.div(
          { className: "row" },
          t.span({ className: "spacer" }),
          t.button({ type: "button", className: "btn btn-ghost", textContent: "Cancel", onclick: close }),
          t.button({
            type: "submit",
            className: "btn btn-primary",
            disabled: () => f.busy,
            textContent: () => f.busy ? "Saving..." : "Save",
          }),
        ),
      ), { title: "Automatic backups", size: "sm" });
  }

  return page(
    "Backups",
    [
      autoBackupCta(),
      fileInput,
      t.button({ className: "btn btn-sm btn-ghost", textContent: "Refresh", onclick: load }),
      t.button({
        className: "btn btn-sm",
        disabled: () => data.busy === "upload",
        textContent: () => data.busy === "upload" ? "Uploading..." : "Upload",
        onclick: () => fileInput.click(),
      }),
      t.button({ className: "btn btn-sm btn-primary", textContent: "Create backup", onclick: openCreate }),
    ],
    t.div({ className: "stack" }, () => {
      if (data.loading) return loading();
      if (data.error) return errorState(data.error, load);
      if (!data.items.length) {
        return empty(
          "No backups yet.",
          t.button({ className: "btn btn-sm btn-primary", textContent: "Create backup", onclick: openCreate }),
        );
      }
      return table();
    }),
  );
}
