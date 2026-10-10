import type { Settings } from "../settings/mod.ts";

/** PB default templates, placeholders included. */
export interface EmailTemplate {
  subject: string;
  body: string;
}

const thanks = `<p>
  Thanks,<br/>
  {APP_NAME} team
</p>`;

const button = (path: string, label: string) =>
  `<p>
  <a class="btn" href="{APP_URL}/_/#/auth/${path}/{TOKEN}" target="_blank" rel="noopener">${label}</a>
</p>`;

export const TEMPLATES = {
  verification: {
    subject: "Verify your {APP_NAME} email",
    body: `<p>Hello,</p>
<p>Thank you for joining us at {APP_NAME}.</p>
<p>Click on the button below to verify your email address.</p>
${button("confirm-verification", "Verify")}
<p><i>If you didn't recently register, please ignore this email.</i></p>
${thanks}`,
  },
  resetPassword: {
    subject: "Reset your {APP_NAME} password",
    body: `<p>Hello,</p>
<p>Click on the button below to reset your password.</p>
${button("confirm-password-reset", "Reset password")}
<p><i>If you didn't ask to reset your password, please ignore this email.</i></p>
${thanks}`,
  },
  confirmEmailChange: {
    subject: "Confirm your {APP_NAME} new email address",
    body: `<p>Hello,</p>
<p>Click on the button below to confirm your new email address.</p>
${button("confirm-email-change", "Confirm new email")}
<p><i>If you didn't ask to change your email address, please ignore this email.</i></p>
${thanks}`,
  },
  authAlert: {
    subject: "Login from a new location",
    body: `<p>Hello,</p>
<p>We noticed a login to your {APP_NAME} account from a new location:</p>
<p><em>{ALERT_INFO}</em></p>
<p><strong>If this wasn't you, you should immediately change your {APP_NAME} account password to revoke access from all other locations.</strong></p>
<p>If this was you, you may disregard this email.</p>
${thanks}`,
  },
  otp: {
    subject: "OTP for {APP_NAME}",
    body: `<p>Hello,</p>
<p>Your one-time password is: <strong>{OTP}</strong></p>
<p><i>If you didn't ask for the one-time password, you can ignore this email.</i></p>
${thanks}`,
  },
} satisfies Record<string, EmailTemplate>;

/** PB resolveEmailTemplate: fills {APP_NAME}, {APP_URL} and the caller's placeholders in subject and body. */
export function renderTemplate(
  t: EmailTemplate,
  meta: Settings["meta"],
  vars: Record<string, string> = {},
): { subject: string; html: string } {
  const all: Record<string, string> = { "{APP_NAME}": meta.appName, "{APP_URL}": meta.appURL, ...vars };
  const fill = (s: string) => Object.entries(all).reduce((acc, [k, v]) => acc.replaceAll(k, v), s);
  return { subject: fill(t.subject), html: fill(t.body) };
}
