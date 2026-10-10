import { errMessage } from "../pb.js";
import { isoScene } from "../iso.js";

/** Superuser password login (POST /api/collections/_superusers/auth-with-password). */
export function render() {
  app.store.title = "Sign in";
  const data = store({ identity: "", password: "", busy: false, error: "" });

  async function submit(e) {
    e.preventDefault();
    if (data.busy) return;
    data.busy = true;
    data.error = "";
    try {
      await app.pb.collection("_superusers").authWithPassword(data.identity, data.password);
      globalThis.location.hash = "#/";
    } catch (err) {
      data.error = err?.status === 400 ? "Invalid email or password." : errMessage(err);
    } finally {
      data.busy = false;
    }
  }

  const form = t.form(
    { className: "login-card", onsubmit: submit },
    t.div(
      { className: "login-head" },
      t.h1({ className: "login-title", textContent: "Admin panel" }),
      t.p({ className: "muted", textContent: "Sign in with your superuser account." }),
    ),
    t.label(
      { className: "field" },
      t.span({ className: "field-label", textContent: "Email" }),
      t.input({
        className: "input",
        type: "email",
        required: true,
        autocomplete: "username",
        placeholder: "you@example.com",
        value: () => data.identity,
        oninput: (e) => data.identity = e.target.value,
        onmount: (el) => el.focus(),
      }),
    ),
    t.label(
      { className: "field" },
      t.span({ className: "field-label", textContent: "Password" }),
      t.input({
        className: "input",
        type: "password",
        required: true,
        autocomplete: "current-password",
        value: () => data.password,
        oninput: (e) => data.password = e.target.value,
      }),
    ),
    t.div({ className: "alert alert-danger", hidden: () => !data.error, textContent: () => data.error }),
    t.button(
      {
        className: "btn btn-primary btn-block",
        type: "submit",
        disabled: () => data.busy,
      },
      t.span({ textContent: () => data.busy ? "Signing in..." : "Sign in" }),
      t.span({
        className: "btn-arrow",
        "html-aria-hidden": "true",
        innerHTML: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
          'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
      }),
    ),
  );

  const art = t.div(
    { className: "login-art", "html-aria-hidden": "true" },
    isoScene(),
  );

  const logo = t.div(
    { className: "login-logo" },
    t.img({ className: "brand-logo", src: "assets/logo.svg", alt: "" }),
    t.span({ textContent: "Denobase" }),
  );

  return t.div({ className: "split-login login" }, logo, art, t.div({ className: "login-form-side" }, form));
}
