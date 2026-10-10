import { errMessage } from "../pb.js";
import { badge, errorState, field, loading, page, toast } from "../ui.js";
import { collectionRow } from "./collections.js";
import { spring } from "../spring.js";
import { isTimeZone, offsetLabel } from "../time.js";

const zones = () => ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];

const TABS = [
  { id: "application", label: "Application" },
  { id: "logs", label: "Logs" },
  { id: "traces", label: "Traces" },
  { id: "batch", label: "Batch" },
  { id: "oauth", label: "OAuth" },
  { id: "rateLimits", label: "Rate limits" },
  { id: "smtp", label: "Mail (SMTP)" },
  { id: "s3", label: "Files storage (S3)" },
  { id: "collections", label: "Collections" },
];

// Editable fields per tab: [section, key, label, type, hint].
const FIELDS = {
  application: [
    ["meta", "appName", "Application name", "text"],
    ["meta", "appURL", "Application URL", "text"],
    ["meta", "timezone", "Timezone", "timezone"],
  ],
  logs: [
    ["logs", "maxDays", "Enable logging", "switch"],
    ["logs", "maxDays", "Max days retention", "retention"],
    ["logs", "minLevel", "Min log level", "level"],
    ["logs", "logIP", "Enable IP logging", "bool"],
    ["logs", "logAuthId", "Enable auth id logging", "bool"],
  ],
  traces: [
    ["traces", "enabled", "Enable tracing", "bool"],
    ["traces", "maxDays", "Max days retention (0 disables tracing)", "number"],
    ["traces", "sampleRatio", "Sample ratio (0 to 1; failed and slow traces are always kept)", "number"],
    ["traces", "slowMs", "Slow trace threshold (ms)", "number"],
    ["traces", "minDurationMs", "Drop child spans faster than (ms)", "number"],
    ["traces", "maxSpansPerTrace", "Max spans per trace", "number"],
    ["traces", "recordDbText", "Record normalized SQL text (no literals)", "bool"],
    ["traces", "trustTraceparent", "Trust incoming traceparent (only behind a trusted proxy)", "bool"],
    ["traces", "propagateHosts", "Send traceparent to these hosts (comma separated)", "list"],
  ],
  oauth: [
    ["oauth", "enabled", "Enable OAuth for the MCP (clients sign users in on this server)", "bool"],
    ["oauth", "allowedCollections", "Collections that may authorize (comma separated, empty = all in code)", "list"],
    [
      "oauth",
      "defaultCollection",
      "Collection a request signs in against when it does not name one (auth_collection)",
      "text",
    ],
    ["oauth", "accessTokenTTL", "Access token lifetime (seconds)", "number"],
    ["oauth", "refreshTokenTTL", "Refresh token lifetime (seconds, renewed on every use)", "number"],
    ["oauth", "codeTTL", "Authorization code lifetime (seconds)", "number"],
    ["oauth", "sessionTTL", "Sign-in session on the authorization page (seconds)", "number"],
    ["oauth", "rememberConsent", "Remember consent (skip the screen for the same client and scopes)", "bool"],
    ["oauth", "dcrEnabled", "Allow dynamic client registration", "bool"],
    ["oauth", "cimdEnabled", "Allow client ID metadata documents (https client_id)", "bool"],
    ["oauth", "cimdAllowDomains", "Metadata document domains allowed (comma separated, empty = any)", "list"],
    ["oauth", "cimdDenyDomains", "Metadata document domains denied (comma separated)", "list"],
    ["oauth", "allowLoopback", "Allow loopback redirects (apps on the user's computer)", "bool"],
    ["oauth", "allowedRedirectHosts", "Redirect hosts allowed (comma separated, empty = any https host)", "list"],
  ],
  batch: [
    ["batch", "enabled", "Enable batch API", "bool"],
    ["batch", "maxRequests", "Max requests per batch", "number"],
    ["batch", "timeout", "Timeout (seconds)", "number"],
    ["batch", "maxBodySize", "Max body size (bytes, 0 = default)", "number"],
  ],
};

const BARS = 20;
// Left to right reads as log volume: Error (fewest) .. Debug (most).
const LEVELS = [[8, "Error"], [4, "Warn"], [0, "Info"], [-4, "Debug"]];

/** Flattens nested ApiError data ({logs:{maxDays:{message}}}) into {"logs.maxDays": message}. */
function flatErrors(data, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(data || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && typeof v.message === "string") out[key] = v.message;
    else if (v && typeof v === "object") flatErrors(v, key, out);
  }
  return out;
}

/** Settings (GET/PATCH /api/settings); only the changed fields are sent. */
export function render(route) {
  const initialTab = route?.query?.tab?.[0];
  const data = store({
    tab: TABS.some((x) => x.id === initialTab) ? initialTab : "application",
    original: null,
    form: null,
    loading: true,
    error: null,
    saving: false,
    errors: {},
  });

  async function load() {
    data.loading = true;
    data.error = null;
    try {
      const s = await app.pb.settings.getAll();
      data.original = s;
      data.form = structuredClone(s);
      data.errors = {};
    } catch (err) {
      if (!err?.isAbort) data.error = err;
    } finally {
      data.loading = false;
    }
  }

  function diff() {
    const out = {};
    for (const list of Object.values(FIELDS)) {
      for (const [sec, key] of list) {
        const a = data.original?.[sec]?.[key];
        const b = data.form?.[sec]?.[key];
        if (JSON.stringify(a) !== JSON.stringify(b)) (out[sec] ||= {})[key] = b;
      }
    }
    return out;
  }

  const dirty = () => Object.keys(diff()).length > 0;

  async function save(e) {
    e?.preventDefault();
    const body = diff();
    if (!Object.keys(body).length || data.saving) return;
    data.saving = true;
    data.errors = {};
    try {
      const s = await app.pb.settings.update(body);
      data.original = s;
      data.form = structuredClone(s);
      app.store.settings = s;
      toast("Settings saved.", "success");
    } catch (err) {
      data.errors = flatErrors(err?.response?.data);
      toast(errMessage(err), "error", 6000);
    } finally {
      data.saving = false;
    }
  }

  function levelSlider(sec, key) {
    const val = () => Number(data.form?.[sec]?.[key] ?? 0);
    const idxOf = (v) => Math.max(0, LEVELS.findIndex(([l]) => l === v));
    const frac = (v) => idxOf(v) / (LEVELS.length - 1);
    const pos = spring(frac(val()), { stiffness: 0.08, damping: 0.5 });
    const counts = store({ byLevel: null });
    let dragging = false;

    // Log counts per level (level >= L) over the last 7 days, fetched once per page load
    // so the rate stays stable; failures just hide it.
    const since = new Date(Date.now() - 7 * 864e5).toISOString().replace("T", " ");
    Promise.all(LEVELS.map(([l]) =>
      app.pb.logs.getList(1, 1, {
        filter: `level>=${l} && created>="${since}"`,
        fields: "id",
        requestKey: `lvl-count-${l}`,
      })
        .then((r) => [l, r.totalItems])
    )).then((rows) => counts.byLevel = Object.fromEntries(rows)).catch(() => {});

    /** Rounded for display: 1.5x, 3x, 8x, ~60x. */
    const nice = (r) =>
      r < 2
        ? `${Number(r.toFixed(1))}\u00d7`
        : r < 10
        ? `${Math.round(r)}\u00d7`
        : `~${Number(r.toPrecision(2))}\u00d7`;
    const rate = () => {
      const c = counts.byLevel;
      const n = c?.[val()] ?? 0, base = c?.[8] ?? 0;
      if (!n || !base) return "";
      if (val() === 8 || n / base < 1.05) return "1\u00d7";
      return `${nice(n / base)} more logs`;
    };
    const hint = () => {
      const c = counts.byLevel;
      if (!c) return "";
      const n = c[val()] ?? 0, base = c[8] ?? 0;
      if (!n) return "No logs at this level in the last 7 days.";
      if (!base || val() === 8) return `${n.toLocaleString()} logs at this level in the last 7 days`;
      if (n / base < 1.05) return `About the same as Error-only (${n.toLocaleString()} logs, last 7 days)`;
      return `${
        (n / base).toFixed(2)
      }\u00d7 more logs than Error-only (${n.toLocaleString()} vs ${base.toLocaleString()}, last 7 days)`;
    };

    const root = t.div({ className: "level-slider" });
    const bars = Array.from({ length: BARS }, (_, i) => {
      const f = i / (BARS - 1);
      return t.i({ className: "level-bar", style: `--f:${f};height:${25 + f * 75}%` });
    });
    pos.subscribe((p) => {
      root.style.setProperty("--pos", String(p));
      // A bar is "logged" (coloured) when its centre is at or left of the thumb.
      bars.forEach((b, i) => b.classList.toggle("off", (i + 0.5) / BARS > p));
    });

    /** Raw, unstepped 0..1 position of the pointer along the track (thumb is 18px). */
    const rawAt = (e) => {
      const r = root.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left - 9) / (r.width - 18)));
    };
    const move = (e) => pos.set(rawAt(e));
    const up = () => {
      dragging = false;
      globalThis.removeEventListener("pointermove", move);
      globalThis.removeEventListener("pointerup", up);
      globalThis.removeEventListener("pointercancel", up);
      pos.set(frac(val()));
    };
    const setLevel = (l) => data.form[sec][key] = l;

    root.append(
      t.div({ className: "level-track" }, bars),
      t.div({ className: "level-thumb" }),
      t.input({
        type: "range",
        className: "level-input",
        min: 0,
        max: LEVELS.length - 1,
        step: 1,
        value: () => String(idxOf(val())),
        ariaValueText: () => {
          const v = val();
          if (!dragging) pos.set(frac(v)); // keyboard, click, reset and load glide via the spring
          return LEVELS[idxOf(v)][1];
        },
        oninput: (e) => setLevel(LEVELS[Number(e.target.value)][0]),
        onpointerdown: (e) => {
          dragging = true;
          move(e);
          globalThis.addEventListener("pointermove", move);
          globalThis.addEventListener("pointerup", up);
          globalThis.addEventListener("pointercancel", up);
        },
      }),
      t.div(
        {
          className: "level-ticks",
          // The strip between track and labels: clicks off a label pick the nearest step by x.
          onclick: (e) => {
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            setLevel(LEVELS[Math.round(rawAt(e) * (LEVELS.length - 1))][0]);
          },
        },
        LEVELS.map(([v, name]) =>
          t.button({
            type: "button",
            tabIndex: -1,
            className: () => val() === v ? "level-tick active" : "level-tick",
            textContent: name,
            onclick: (e) => {
              e.preventDefault(); // inside the field <label>: don't forward the click to the range
              setLevel(v);
            },
          })
        ),
      ),
    );
    return t.div(
      { className: "level-row" },
      root,
      t.span({ className: "level-rate", textContent: rate, title: hint, ariaLabel: hint }),
    );
  }

  // Logging switch: off saves maxDays=0, on restores the last non-zero days (default 7).
  let lastDays = 7;
  const loggingOn = (sec, key) => Number(data.form?.[sec]?.[key] ?? 0) > 0;

  function loggingSwitch(sec, key) {
    return t.button({
      type: "button",
      role: "switch",
      className: "switch",
      ariaChecked: () => String(loggingOn(sec, key)),
      onclick: () => {
        if (loggingOn(sec, key)) {
          lastDays = Number(data.form[sec][key]);
          data.form[sec][key] = 0;
        } else data.form[sec][key] = lastDays || 7;
      },
    }, t.span({ className: "switch-knob" }));
  }

  function retention(sec, key, err) {
    return stepper(sec, key, err, 5, 1, () => !loggingOn(sec, key));
  }

  function stepper(sec, key, err, step = 5, min = 0, off = () => false) {
    const val = () => Number(data.form?.[sec]?.[key] ?? 0);
    const set = (v) => data.form[sec][key] = Math.max(min, Math.trunc(v));
    return t.div(
      { className: "stepper" },
      t.button({
        type: "button",
        className: "stepper-btn",
        ariaLabel: `Decrease by ${step}`,
        textContent: "\u2212",
        disabled: () => off() || val() <= min,
        onclick: () => set(val() - step),
      }),
      t.input({
        className: () => err() ? "input stepper-input invalid" : "input stepper-input",
        type: "number",
        inputMode: "numeric",
        min,
        step: 1,
        id: `settings-${sec}-${key}`,
        disabled: off,
        value: () => String(val()),
        oninput: (e) => {
          const v = e.target.value;
          if (v === "" || Number.isFinite(Number(v))) set(v === "" ? min : Number(v));
        },
      }),
      t.button({
        type: "button",
        className: "stepper-btn",
        ariaLabel: `Increase by ${step}`,
        textContent: "+",
        disabled: off,
        onclick: () => set(val() + step),
      }),
    );
  }

  function input(sec, key, type) {
    const err = () => data.errors[`${sec}.${key}`] || "";
    if (type === "level") return levelSlider(sec, key);
    if (type === "retention") return retention(sec, key, err);
    if (type === "switch") return loggingSwitch(sec, key);
    if (type === "timezone") return timezoneInput(sec, key, err);
    if (type === "bool") {
      return t.input({
        type: "checkbox",
        className: "checkbox",
        checked: () => !!data.form?.[sec]?.[key],
        onchange: (e) => data.form[sec][key] = e.target.checked,
      });
    }
    if (type === "list") {
      return t.input({
        className: () => err() ? "input invalid" : "input",
        type: "text",
        value: () => (data.form?.[sec]?.[key] || []).join(", "),
        oninput: (e) => data.form[sec][key] = e.target.value.split(",").map((x) => x.trim()).filter(Boolean),
      });
    }
    return t.input({
      className: () => err() ? "input invalid" : "input",
      type: type === "number" ? "number" : "text",
      step: type === "number" ? "any" : undefined,
      value: () => data.form?.[sec]?.[key] ?? "",
      oninput: (e) => {
        const v = e.target.value;
        data.form[sec][key] = type === "number" ? (v === "" ? 0 : Number(v)) : v;
      },
    });
  }

  /** Searchable timezone: free text over a datalist of every IANA zone with its current offset. */
  function timezoneInput(sec, key, err) {
    const list = `settings-${sec}-${key}-zones`;
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return t.div(
      { className: "tz-field" },
      t.input({
        id: `settings-${sec}-${key}`,
        className: () => err() ? "input invalid" : "input",
        type: "text",
        autocomplete: "off",
        spellcheck: false,
        placeholder: "UTC",
        value: () => data.form?.[sec]?.[key] ?? "",
        oninput: (e) => data.form[sec][key] = e.target.value.trim(),
        list,
      }),
      t.datalist(
        { id: list },
        ...zones().map((z) => t.option({ value: z, label: `${z} (${offsetLabel(z)})` })),
      ),
      t.span({
        className: "muted tz-now",
        textContent: () => {
          const z = data.form?.[sec]?.[key];
          return z && isTimeZone(z)
            ? `Now ${new Date().toLocaleTimeString("en-GB", { timeZone: z })} (${offsetLabel(z)})`
            : "";
        },
      }),
      t.button({
        type: "button",
        className: "btn btn-xs btn-ghost",
        textContent: `Use browser timezone (${browser})`,
        disabled: () => data.form?.[sec]?.[key] === browser,
        onclick: () => data.form[sec][key] = browser,
      }),
    );
  }

  /** The retention field holds buttons; point its label at the number input, not the first button. */
  function withFor(el, sec, key, type) {
    if (type === "retention" || type === "timezone") el.htmlFor = `settings-${sec}-${key}`;
    return el;
  }

  function formTab(id) {
    return t.form(
      {
        className: () =>
          id === "logs" && Number(data.form?.logs?.maxDays) === 0 ? "form card logging-off" : "form card",
        onsubmit: save,
      },
      ...FIELDS[id].map(([sec, key, label, type]) =>
        type === "bool" || type === "switch"
          ? t.label(
            { className: "field field-check" },
            input(sec, key, type),
            t.span({ className: "field-label", textContent: label }),
          )
          : withFor(field(label, input(sec, key, type), () => data.errors[`${sec}.${key}`] || ""), sec, key, type)
      ),
      t.input({ type: "submit", hidden: true }),
    );
  }

  function collectionsTab() {
    return t.div(
      { className: "list" },
      app.store.collections.map((c) => collectionRow(c, c.id)),
    );
  }

  function rateLimitsTab() {
    const rl = data.original?.rateLimits || {};
    const rules = rl.rules || [];
    return t.div(
      { className: "stack" },
      t.div({ className: "alert alert-info", textContent: "Rate limits are read-only in Denobase v0." }),
      t.div(
        { className: "row" },
        t.span({ textContent: "Status:" }),
        badge(rl.enabled ? "enabled" : "disabled", rl.enabled ? "success" : "neutral"),
      ),
      rules.length
        ? t.div(
          { className: "table-wrap" },
          t.table(
            { className: "table" },
            t.thead(
              {},
              t.tr(
                {},
                t.th({ textContent: "Label" }),
                t.th({ textContent: "Audience" }),
                t.th({ textContent: "Max requests" }),
                t.th({ textContent: "Duration (s)" }),
              ),
            ),
            t.tbody(
              {},
              rules.map((r) =>
                t.tr(
                  {},
                  t.td({ className: "mono", textContent: r.label }),
                  t.td({ textContent: r.audience || "all" }),
                  t.td({ textContent: String(r.maxRequests) }),
                  t.td({ textContent: String(r.duration) }),
                )
              ),
            ),
          ),
        )
        : t.p({ className: "muted", textContent: "No rules." }),
      t.p({ className: "muted", textContent: `Excluded IPs: ${(rl.excludedIPs || []).join(", ") || "none"}` }),
    );
  }

  function unsupportedTab(name) {
    return t.fieldset(
      { className: "card", disabled: true },
      t.div({ className: "alert alert-warning", textContent: `${name} is not supported in Denobase yet.` }),
      field("Enabled", t.input({ type: "checkbox", className: "checkbox", disabled: true })),
      field("Host / endpoint", t.input({ className: "input", disabled: true })),
    );
  }

  load();

  return page(
    "Settings",
    [
      t.button({
        type: "button",
        className: "btn btn-ghost",
        textContent: "Reset",
        disabled: () => !dirty() || data.saving,
        onclick: () => {
          data.form = structuredClone(data.original);
          data.errors = {};
        },
      }),
      t.button({
        type: "button",
        className: "btn btn-primary",
        disabled: () => !dirty() || data.saving,
        textContent: () => data.saving ? "Saving..." : "Save changes",
        onclick: save,
      }),
    ],
    t.div(
      { className: "settings-layout" },
      t.nav(
        { className: "settings-nav" },
        TABS.map((tab) =>
          t.button({
            type: "button",
            className: () => data.tab === tab.id ? "settings-nav-item active" : "settings-nav-item",
            textContent: tab.label,
            onclick: () => data.tab = tab.id,
          })
        ),
      ),
      t.div({ className: "settings-main" }, () => {
        const id = data.tab;
        if (id === "collections") return t.div({ rid: id }, collectionsTab());
        if (data.loading) return loading();
        if (data.error) return errorState(data.error, load);
        if (FIELDS[id]) return t.div({ rid: id }, formTab(id));
        if (id === "rateLimits") return t.div({ rid: id }, rateLimitsTab());
        if (id === "smtp") return t.div({ rid: id }, unsupportedTab("Sending mail through SMTP"));
        return t.div({ rid: id }, unsupportedTab("S3 file storage"));
      }),
    ),
  );
}
