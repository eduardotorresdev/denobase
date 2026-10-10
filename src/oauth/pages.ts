import type { OAuthBranding, PageKind, ResolvedOAuthOptions } from "./types.ts";
import { type Messages, messages } from "./messages.ts";

export const esc = (v: unknown) =>
  String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const ASSETS = "/oauth/assets";

export interface LoginData {
  appName: string;
  clientName: string;
  txn: string;
  csrf: string;
  /** Codes by email offered: on when any collection that may authorize has them, so the page never tells which. */
  otp: boolean;
  email: string;
  error: string;
}

export interface OtpData {
  appName: string;
  clientName: string;
  txn: string;
  csrf: string;
  otpId: string;
  email: string;
  error: string;
}

export interface ConsentData {
  appName: string;
  txn: string;
  csrf: string;
  client: { name: string; logoUri: string; kind: string; id: string; unverified: boolean };
  redirectHost: string;
  loopback: boolean;
  resource: string;
  scopes: { name: string; description: string }[];
  user: { email: string };
}

/** The last page of a decision: the result goes to the client while this stays on screen. */
export interface DoneData {
  appName: string;
  allowed: boolean;
  clientName: string;
  email: string;
  /** The redirect_uri with code (or error), state and iss. Never shown as text: only the iframe and the link carry it. */
  returnUrl: string;
  /** A native app on this computer: delivered in a hidden frame, the page stays. Else the browser goes on to the app. */
  loopback: boolean;
}

export interface ErrorData {
  appName: string;
  title: string;
  message: string;
}

/**
 * Security headers of every page: no script at all, styles and forms of our own origin, never framed. `frameSrc` is
 * the one origin the final page may frame: the loopback redirect it delivers the result to.
 */
export function pageHeaders(frameSrc?: string): Record<string, string> {
  const frame = frameSrc ? `frame-src ${frameSrc}; ` : "";
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' https: data:; ` +
      `${frame}form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

function shell(
  b: OAuthBranding | undefined,
  m: Messages,
  appName: string,
  title: string,
  body: string,
  head = "",
): string {
  const name = b?.name || appName || "Denobase";
  const logo = b?.logoUrl || `${ASSETS}/logo.svg`;
  const extra = b?.cssHref ? `<link rel="stylesheet" href="${esc(b.cssHref)}">` : "";
  return `<!doctype html>
<html lang="${esc(m.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · ${esc(name)}</title>
<link rel="stylesheet" href="${ASSETS}/oauth.css">${extra}${head}
</head>
<body>
<main class="oa-card">
<header class="oa-brand"><img src="${esc(logo)}" alt="" width="28" height="28"><span>${esc(name)}</span></header>
${body}
</main>
</body>
</html>`;
}

const alert = (error: string) => error ? `<p class="oa-error" role="alert">${esc(error)}</p>` : "";

const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${esc(value)}">`;

function login(b: OAuthBranding | undefined, m: Messages, d: LoginData): string {
  const emailField = `<label class="oa-field"><span>${m.email}</span><input name="email" type="email" required ` +
    `autocomplete="username" value="${esc(d.email)}"></label>`;
  const otpForm = d.otp
    ? `<form class="oa-alt" method="post" action="/oauth/otp/request">
<p class="oa-muted">${m.orCode}</p>
${hidden("txn", d.txn)}${hidden("csrf", d.csrf)}
${emailField}
<button class="oa-btn" type="submit">${m.emailMeCode}</button>
</form>`
    : "";
  return shell(
    b,
    m,
    d.appName,
    m.signIn,
    `<h1>${m.signIn}</h1>
<p class="oa-muted">${m.signInLead(esc(d.clientName))}</p>
${alert(d.error)}
<form method="post" action="/oauth/login">
${hidden("txn", d.txn)}${hidden("csrf", d.csrf)}
${emailField}
<label class="oa-field"><span>${m.password}</span><input name="password" type="password" required autocomplete="current-password"></label>
<button class="oa-btn oa-primary" type="submit">${m.signIn}</button>
</form>
${otpForm}`,
  );
}

function otp(b: OAuthBranding | undefined, m: Messages, d: OtpData): string {
  return shell(
    b,
    m,
    d.appName,
    m.enterCode,
    `<h1>${m.checkEmail}</h1>
<p class="oa-muted">${m.codeSent(esc(d.email))}</p>
${alert(d.error)}
<form method="post" action="/oauth/otp/verify">
${hidden("txn", d.txn)}${hidden("csrf", d.csrf)}${hidden("otpId", d.otpId)}
<label class="oa-field"><span>${m.code}</span><input name="code" inputmode="numeric" autocomplete="one-time-code" required></label>
<button class="oa-btn oa-primary" type="submit">${m.continue}</button>
</form>`,
  );
}

/**
 * The decision as labeled items, top to bottom: who asks, with which account, what it may do, where it is used; the
 * ids and raw scopes folded under the technical details.
 */
function consent(b: OAuthBranding | undefined, m: Messages, d: ConsentData): string {
  const logo = d.client.logoUri
    ? `<img class="oa-client-logo" src="${esc(d.client.logoUri)}" alt="" width="40" height="40">`
    : "";
  const badge = d.client.unverified
    ? ` <span class="oa-badge" title="${esc(m.unverifiedHint)}">${m.unverified}</span>`
    : "";
  const item = (label: string, body: string) =>
    `<section class="oa-item"><h2 class="oa-label">${label}</h2>${body}</section>`;
  return shell(
    b,
    m,
    d.appName,
    m.authorizeTitle,
    `<h1>${m.authorizeTitle}</h1>
${
      item(
        m.whoAsks,
        `<div class="oa-client">${logo}<strong>${esc(d.client.name)}</strong>${badge}</div>${
          d.loopback ? `<p class="oa-warn">${m.loopbackWarn}</p>` : ""
        }`,
      )
    }
${
      item(
        m.whichAccount,
        `<form method="post" action="/oauth/logout" class="oa-switch">
${hidden("txn", d.txn)}${hidden("csrf", d.csrf)}
<strong>${
          esc(d.user.email)
        }</strong> <span class="oa-muted">${m.notYou()}</span> <button class="oa-link" type="submit">${m.otherAccount}</button>
</form>`,
      )
    }
${
      item(
        m.whatItCanDo,
        `<ul class="oa-scopes">${d.scopes.map((s) => `<li>${esc(s.description || s.name)}</li>`).join("")}</ul>`,
      )
    }
${
      item(
        m.whereUsed,
        `<dl class="oa-facts">
<dt>${m.resource}</dt><dd class="oa-mono">${esc(d.resource.replace(/^https?:\/\//, ""))}</dd>
<dt>${m.sendsBackTo}</dt><dd class="oa-mono">${esc(d.redirectHost)}</dd>
</dl>`,
      )
    }
<details class="oa-details"><summary>${m.details}</summary>
<dl class="oa-facts">
<dt>${m.clientId}</dt><dd class="oa-mono">${esc(d.client.id)}</dd>
<dt>${m.permissions}</dt><dd class="oa-mono">${esc(d.scopes.map((s) => s.name).join(" "))}</dd>
</dl>
</details>
<form method="post" action="/oauth/consent" class="oa-actions">
${hidden("txn", d.txn)}${hidden("csrf", d.csrf)}
<button class="oa-btn" type="submit" name="action" value="deny">${m.deny}</button>
<button class="oa-btn oa-primary" type="submit" name="action" value="allow">${m.allow}</button>
</form>`,
  );
}

const ICON_OK =
  `<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" ` +
  `stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const ICON_NO =
  `<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" ` +
  `stroke-width="2.5" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>`;

/**
 * Allowed or denied, the result goes to the client without leaving this page: to a loopback app through a hidden,
 * sandboxed frame (it only needs the GET on its callback), to a web app by a meta refresh, both with a link as the
 * fallback. Neither the code nor the URL is ever printed as text.
 */
function done(b: OAuthBranding | undefined, m: Messages, d: DoneData): string {
  const name = b?.name || d.appName || "Denobase";
  const title = d.allowed ? m.allowedTitle : m.deniedTitle;
  const lead = d.allowed
    ? m.allowedLead(esc(d.clientName), esc(name), esc(d.email))
    : m.deniedLead(esc(d.clientName), esc(name));
  const url = esc(d.returnUrl);
  const deliver = d.loopback
    ? `<iframe class="oa-deliver" src="${url}" sandbox referrerpolicy="no-referrer" title="" hidden></iframe>
<p class="oa-muted">${m.closeTab}</p>`
    : `<p class="oa-muted">${m.returning}</p>`;
  return shell(
    b,
    m,
    d.appName,
    title,
    `<div class="oa-done">
<div class="oa-done-icon ${d.allowed ? "oa-ok" : "oa-no"}">${d.allowed ? ICON_OK : ICON_NO}</div>
<h1>${title}</h1>
<p>${lead}</p>
${deliver}
<p class="oa-fallback">${m.notReacting} <a class="oa-return" href="${url}" rel="noreferrer">${m.backToApp}</a></p>
</div>
<footer class="oa-foot">${d.allowed ? m.revokeHint : m.nothingShared}</footer>`,
    d.loopback ? "" : `\n<meta http-equiv="refresh" content="2;url=${url}">`,
  );
}

function error(b: OAuthBranding | undefined, m: Messages, d: ErrorData): string {
  return shell(b, m, d.appName, d.title, `<h1>${esc(d.title)}</h1><p class="oa-error">${esc(d.message)}</p>`);
}

/** A page's HTML: the consumer's renderPage when it returns one, else the built-in. */
export function renderPage(opts: ResolvedOAuthOptions, kind: "login", data: LoginData): string;
export function renderPage(opts: ResolvedOAuthOptions, kind: "otp", data: OtpData): string;
export function renderPage(opts: ResolvedOAuthOptions, kind: "consent", data: ConsentData): string;
export function renderPage(opts: ResolvedOAuthOptions, kind: "done", data: DoneData): string;
export function renderPage(opts: ResolvedOAuthOptions, kind: "error", data: ErrorData): string;
export function renderPage(opts: ResolvedOAuthOptions, kind: PageKind, data: unknown): string {
  const custom = opts.renderPage?.(kind, data as Record<string, unknown>);
  if (custom !== undefined) return custom;
  const b = opts.branding;
  const m = messages(opts.locale);
  switch (kind) {
    case "login":
      return login(b, m, data as LoginData);
    case "otp":
      return otp(b, m, data as OtpData);
    case "consent":
      return consent(b, m, data as ConsentData);
    case "done":
      return done(b, m, data as DoneData);
    default:
      return error(b, m, data as ErrorData);
  }
}
