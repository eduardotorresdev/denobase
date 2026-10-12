/**
 * Storage editor shared by the files storage (Settings) and the backups storage (Backups page): pick local or S3,
 * paste any bucket URL to fill the form, pick the provider by name, and watch a staged check of the unsaved draft
 * (reach, sign in, bucket, write, read back, clean up) with one-click fixes for what the server points out.
 */
import { onUnmount } from "./ui.js";
import { errMessage } from "./pb.js";
import {
  checkable,
  detectProvider,
  needsPathStyle,
  objectUrl,
  parseS3Url,
  provider,
  PROVIDERS,
  stepAdvice,
  STEPS,
} from "./s3.js";

const CHECK = "/api/_denobase/s3/check";
const CHECK_DELAY_MS = 900;

const DISK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><rect x="3" y="13" width="18" height="7" rx="1.5"/>' +
  '<path d="M5 13l2.5-8h9L19 13"/><circle cx="17" cy="16.5" r=".8" fill="currentColor"/></svg>';
const CLOUD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="M7 18h10.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.3 9.2 4.5 4.5 ' +
  '0 0 0 7 18z"/></svg>';

/** Icon of where a storage config points, for CTAs outside the editor. */
export const storageIcon = (enabled) => enabled ? CLOUD : DISK;

/**
 * opts:
 * - filesystem: "storage" | "backups" (the server check reuses that filesystem's saved secret)
 * - cfg: reactive S3Config being edited (the caller saves it)
 * - saved: () => the saved S3Config, to tell whether an empty secret means "keep"
 * - error: (key) => field error from the last save
 * - local: { title, path } of the local option
 * - sampleKey: an object key this storage would hold, for the URL preview
 * - copyFrom: optional { label, cfg: () => S3Config } offered as a one-click prefill (secret not included)
 */
export function storageEditor(opts) {
  const { cfg, filesystem } = opts;
  const found = detectProvider(cfg.endpoint);
  const ui = store({
    provider: cfg.endpoint ? found.id : "aws",
    account: found.account || "",
    paste: "",
    pasteNote: "",
    flash: [],
    showAdvanced: false,
    check: null, // { running, result, error, key }
  });

  const p = () => provider(ui.provider);
  const savedSecret = () => {
    const s = opts.saved();
    return !!(s?.enabled && s.accessKey && s.accessKey === cfg.accessKey);
  };

  function flash(keys) {
    ui.flash = keys;
    setTimeout(() => ui.flash = [], 1200);
  }
  const fieldClass = (key, base = "input") => () => {
    const cls = [base];
    if (opts.error(key)) cls.push("invalid");
    if (ui.flash.includes(key)) cls.push("s3-flash");
    return cls.join(" ");
  };

  /** Rebuilds the endpoint of a provider that derives it from region/account. */
  function syncEndpoint() {
    const pv = p();
    if (pv.fixedRegion) cfg.region = pv.fixedRegion;
    if (pv.endpoint) cfg.endpoint = pv.endpoint({ region: cfg.region, account: ui.account });
  }

  function pickProvider(id) {
    if (ui.provider === id) return;
    ui.provider = id;
    const pv = p();
    if (pv.regions && !pv.regions.includes(cfg.region)) cfg.region = pv.regions[0];
    if (!pv.endpoint && !pv.fixedRegion && !cfg.region) cfg.region = "us-east-1";
    if (pv.endpoint) syncEndpoint();
    else if (detectProvider(cfg.endpoint).id !== id) cfg.endpoint = "";
    if (typeof pv.pathStyle === "boolean") cfg.forcePathStyle = pv.pathStyle;
  }

  function applyPaste(text) {
    ui.paste = text;
    const got = parseS3Url(text);
    if (!got) {
      ui.pasteNote = text.trim() ? "Not a URL this can read. Paste a bucket or object URL, or s3://bucket." : "";
      return;
    }
    const keys = [];
    if (got.provider) {
      ui.provider = got.provider;
      ui.account = detectProvider(got.endpoint).account || ui.account;
    }
    for (const k of ["endpoint", "bucket", "region", "forcePathStyle"]) {
      if (got[k] === undefined || got[k] === cfg[k]) continue;
      cfg[k] = got[k];
      keys.push(k);
    }
    if (!cfg.region) cfg.region = "us-east-1";
    const names = { endpoint: "endpoint", bucket: "bucket", region: "region", forcePathStyle: "addressing style" };
    ui.pasteNote = keys.length
      ? `Filled ${keys.map((k) => names[k]).join(", ")} from the URL${cfg.accessKey ? "." : ". Now the keys."}`
      : "Already matches the form.";
    flash(keys);
    ui.paste = "";
  }

  // ---- connection check ---------------------------------------------------------------------------------------

  const draftKey = () =>
    JSON.stringify([cfg.endpoint, cfg.bucket, cfg.region, cfg.accessKey, cfg.secret, cfg.forcePathStyle]);
  let timer = 0;

  async function runCheck() {
    clearTimeout(timer);
    const key = draftKey();
    ui.check = { running: true, result: null, error: "", key };
    try {
      const result = await app.pb.send(CHECK, {
        method: "POST",
        body: JSON.stringify({ filesystem, s3: { ...cfg } }),
        headers: { "content-type": "application/json" },
        requestKey: `s3-check-${filesystem}`,
      });
      if (draftKey() === key) ui.check = { running: false, result, error: "", key };
    } catch (err) {
      if (err?.isAbort) return;
      const fe = err?.response?.data || {};
      const missing = Object.keys(fe).filter((k) => k !== "filesystem");
      const error = missing.includes("secret") ? "Enter the secret to check this access key." : errMessage(err);
      if (draftKey() === key) ui.check = { running: false, result: null, error, key };
    }
  }

  // Checks the draft on its own once it is complete and the typing settles: no button to find first.
  const auto = watch(() => {
    const key = draftKey();
    if (!cfg.enabled || !checkable(cfg) || (!cfg.secret && !savedSecret())) return;
    if (ui.check?.key === key) return;
    clearTimeout(timer);
    timer = setTimeout(runCheck, CHECK_DELAY_MS);
  });

  function applyFix(suggest) {
    const keys = Object.keys(suggest);
    Object.assign(cfg, suggest);
    if (suggest.region && p().endpoint) syncEndpoint();
    flash(keys);
    runCheck();
  }

  // ---- pieces -------------------------------------------------------------------------------------------------

  function destination() {
    const card = (on, icon, title, sub) =>
      t.button(
        {
          type: "button",
          role: "radio",
          className: () => cfg.enabled === on ? "s3-dest is-on" : "s3-dest",
          ariaChecked: () => String(cfg.enabled === on),
          onclick: () => {
            cfg.enabled = on;
            if (on && !cfg.region) pickProvider(ui.provider);
          },
        },
        t.span({ className: "s3-dest-icon", innerHTML: icon }),
        t.span(
          { className: "s3-dest-text" },
          t.strong({ textContent: title }),
          t.span({ className: "muted", textContent: sub }),
        ),
        t.span({ className: "s3-dest-tick", ariaHidden: "true" }),
      );
    return t.div(
      { className: "s3-dests", role: "radiogroup", ariaLabel: "Where files are stored" },
      card(false, DISK, opts.local.title, opts.local.path),
      card(
        true,
        CLOUD,
        "S3-compatible bucket",
        () => cfg.enabled && cfg.bucket ? cfg.bucket : "AWS, R2, B2, Spaces, MinIO...",
      ),
    );
  }

  function pasteBar() {
    return t.div(
      { className: "s3-paste" },
      t.input({
        className: "input s3-paste-input",
        type: "text",
        spellcheck: false,
        autocomplete: "off",
        placeholder: "Paste a bucket URL, an object link or s3://bucket — the form fills itself",
        value: () => ui.paste,
        onpaste: (e) => {
          e.preventDefault();
          applyPaste(e.clipboardData?.getData("text") || "");
        },
        oninput: (e) => ui.paste = e.target.value,
        onkeydown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            applyPaste(ui.paste);
          }
        },
        onblur: () => ui.paste && applyPaste(ui.paste),
      }),
      t.span({ className: "s3-paste-note muted", textContent: () => ui.pasteNote }),
      () =>
        opts.copyFrom?.cfg()?.enabled
          ? t.button({
            type: "button",
            className: "btn btn-xs btn-ghost",
            textContent: opts.copyFrom.label,
            onclick: () => {
              const src = opts.copyFrom.cfg();
              const keys = ["endpoint", "bucket", "region", "accessKey", "forcePathStyle"];
              for (const k of keys) cfg[k] = src[k];
              const d = detectProvider(cfg.endpoint);
              ui.provider = d.id;
              ui.account = d.account || "";
              cfg.secret = "";
              flash([...keys, "secret"]);
              ui.pasteNote = "Copied. Use another bucket (or a prefix) for backups, and enter the secret again.";
            },
          })
          : null,
    );
  }

  function providers() {
    return t.div(
      { className: "s3-providers", role: "radiogroup", ariaLabel: "Provider" },
      PROVIDERS.map((pv) =>
        t.button({
          type: "button",
          role: "radio",
          className: "s3-provider",
          ariaChecked: () => String(ui.provider === pv.id),
          textContent: pv.label,
          onclick: () => pickProvider(pv.id),
        })
      ),
    );
  }

  const label = (text, ...children) =>
    t.label({ className: "field" }, t.span({ className: "field-label", textContent: text }), ...children);
  const err = (key) => t.span({ className: "field-error", textContent: () => opts.error(key) });

  function where() {
    return () => {
      const pv = p();
      const parts = [];
      if (pv.account) {
        parts.push(label(
          "Account ID",
          t.input({
            className: fieldClass("account", "input mono"),
            placeholder: "32-character id from the R2 dashboard",
            spellcheck: false,
            value: () => ui.account,
            oninput: (e) => {
              ui.account = e.target.value.trim();
              syncEndpoint();
            },
          }),
        ));
      }
      if (pv.regions) {
        parts.push(label(
          "Region",
          t.select(
            {
              className: fieldClass("region"),
              value: () => cfg.region,
              onchange: (e) => {
                cfg.region = e.target.value;
                syncEndpoint();
              },
            },
            // A region outside the list (pasted or saved) stays selectable instead of being dropped silently.
            (pv.regions.includes(cfg.region) ? pv.regions : [cfg.region, ...pv.regions]).map((r) =>
              t.option({ value: r, textContent: r, selected: () => cfg.region === r })
            ),
          ),
          err("region"),
        ));
      }
      if (!pv.endpoint) {
        parts.push(label(
          "Endpoint",
          t.input({
            className: fieldClass("endpoint", "input mono"),
            placeholder: pv.id === "selfhosted" ? "http://localhost:9000" : "https://s3.example.com",
            spellcheck: false,
            value: () => cfg.endpoint,
            oninput: (e) => {
              cfg.endpoint = e.target.value.trim();
              if (needsPathStyle(cfg.endpoint)) cfg.forcePathStyle = true;
            },
          }),
          err("endpoint"),
        ));
        parts.push(label(
          "Region",
          t.input({
            className: fieldClass("region", "input mono"),
            placeholder: "us-east-1",
            spellcheck: false,
            value: () => cfg.region,
            oninput: (e) => cfg.region = e.target.value.trim(),
          }),
          err("region"),
        ));
      }
      parts.push(label(
        "Bucket",
        t.input({
          className: fieldClass("bucket", "input mono"),
          spellcheck: false,
          placeholder: filesystem === "backups" ? "my-app-backups" : "my-app-files",
          value: () => cfg.bucket,
          oninput: (e) => cfg.bucket = e.target.value.trim(),
        }),
        err("bucket"),
      ));
      return t.div({ className: "s3-grid" }, parts);
    };
  }

  function keys() {
    return t.div(
      { className: "stack s3-keys" },
      t.div(
        { className: "s3-grid" },
        label(
          "Access key",
          t.input({
            className: fieldClass("accessKey", "input mono"),
            spellcheck: false,
            autocomplete: "off",
            value: () => cfg.accessKey,
            oninput: (e) => cfg.accessKey = e.target.value.trim(),
          }),
          err("accessKey"),
        ),
        label(
          "Secret",
          t.input({
            className: fieldClass("secret", "input mono"),
            type: "password",
            autocomplete: "new-password",
            placeholder: () => savedSecret() ? "Saved · leave empty to keep it" : "",
            value: () => cfg.secret,
            oninput: (e) => cfg.secret = e.target.value.trim(),
          }),
          err("secret"),
        ),
      ),
      t.p({ className: "muted s3-hint", textContent: () => p().keyHint || "" }),
    );
  }

  function addressing() {
    return t.div(
      { className: "s3-address" },
      t.div(
        { className: "s3-address-head" },
        t.span({ className: "muted", textContent: "Objects land at" }),
        t.span({ className: "spacer" }),
        t.button({
          type: "button",
          role: "switch",
          className: "switch",
          ariaLabel: "Force path-style addressing",
          ariaChecked: () => String(!!cfg.forcePathStyle),
          onclick: () => cfg.forcePathStyle = !cfg.forcePathStyle,
        }, t.span({ className: "switch-knob" })),
        t.span({
          className: "s3-address-mode",
          textContent: () => cfg.forcePathStyle ? "Path style" : "Virtual host",
          title:
            "Path style puts the bucket in the path (MinIO, most self-hosted servers); virtual host in the hostname (AWS).",
        }),
      ),
      t.code({
        className: () => ui.flash.includes("forcePathStyle") ? "s3-url s3-flash" : "s3-url",
        textContent: () => objectUrl(cfg, opts.sampleKey),
      }),
    );
  }

  function checkPanel() {
    return t.div({ className: "s3-check", ariaLive: "polite" }, () => {
      const c = ui.check;
      const r = c?.result;
      const failed = r?.steps.find((s) => s.status === "fail");
      const stepState = (id, i) => {
        if (!c) return "idle";
        if (c.running) return "running";
        if (!r) return "idle";
        return r.steps[i]?.id === id ? r.steps[i].status : "idle";
      };
      const total = r ? r.steps.reduce((a, s) => a + s.ms, 0) : 0;
      const head = !c
        ? (checkable(cfg)
          ? "Waiting for the secret to check the connection."
          : "Fill the form: the connection is checked as you type.")
        : c.running
        ? "Checking the connection..."
        : c.error
        ? c.error
        : r.ok
        ? `Connected · read and write work · ${total} ms`
        : "The connection failed";
      return [
        t.div(
          { className: "s3-check-head" },
          t.span({
            className: () =>
              `s3-check-led ${c?.running ? "is-running" : r?.ok ? "is-ok" : failed || c?.error ? "is-fail" : ""}`,
          }),
          t.span({ className: "s3-check-title", textContent: head }),
          t.span({ className: "spacer" }),
          t.button({
            type: "button",
            className: "btn btn-xs btn-ghost",
            textContent: c?.running ? "Checking..." : "Check again",
            disabled: !!c?.running || !checkable(cfg),
            onclick: runCheck,
          }),
        ),
        t.ol(
          { className: "s3-steps" },
          STEPS.map(([id, name], i) =>
            t.li(
              {
                className: `s3-step is-${stepState(id, i)}`,
                style: `--i:${i}`,
                title: r?.steps[i]?.ms ? `${r.steps[i].ms} ms` : "",
              },
              t.span({ className: "s3-step-dot" }),
              t.span({ className: "s3-step-name", textContent: name }),
            )
          ),
        ),
        failed
          ? t.div(
            { className: "s3-failure" },
            t.strong({ textContent: stepAdvice(failed, cfg) || "S3 refused the request." }),
            t.code({
              className: "s3-raw",
              textContent: `${failed.code ? `${failed.code}: ` : ""}${failed.message || ""}`,
            }),
            r.suggest
              ? t.div(
                { className: "row" },
                ...Object.entries(r.suggest).map(([k, v]) =>
                  t.button({
                    type: "button",
                    className: "btn btn-sm btn-primary",
                    textContent: k === "region" ? `Use region ${v}` : "Turn on path style",
                    onclick: () => applyFix({ [k]: v }),
                  })
                ),
              )
              : null,
          )
          : null,
      ];
    });
  }

  const el = t.div(
    { className: "s3-editor" },
    destination(),
    () =>
      cfg.enabled
        ? t.div(
          { className: "s3-body" },
          pasteBar(),
          providers(),
          where(),
          keys(),
          addressing(),
          checkPanel(),
        )
        : t.p({
          className: "muted s3-local-note",
          textContent: `Stored on this server's disk, in ${opts.local.path}.`,
        }),
  );
  return onUnmount(el, () => {
    clearTimeout(timer);
    auto.unwatch();
  });
}
