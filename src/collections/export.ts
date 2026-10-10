import { type CollectionConfig, type Field, LOCKED } from "../core/types.ts";
import { collectionId, collectionType, crc32, getCollection } from "../core/registry.ts";
import { TOKEN_TTL } from "../auth/jwt.ts";
import { TEMPLATES } from "../auth/templates.ts";
import { DEFAULT_MAX_SIZE } from "../engine/files.ts";

/**
 * Our code-declared collections in PB's collection JSON,
 * so the PB admin UI and SDK can read the schema. Rules are functions here: a missing one is null (superuser-only,
 * PB's meaning), a present one a filter comment saying where it lives.
 */
export type PbField = Record<string, unknown> & { id: string; name: string; type: string };

const CODE_RULE = "// defined in code";
const rule = (fn: unknown) => (fn && fn !== LOCKED ? CODE_RULE : null);
const fieldId = (type: string, name: string) => `${type}${crc32(name)}`;

function base(f: { name: string; hidden?: boolean; required?: boolean }, type: string, system = false) {
  return {
    hidden: !!f.hidden,
    id: fieldId(type, f.name),
    name: f.name,
    presentable: false,
    required: !!f.required,
    system,
    type,
  };
}

function field(f: Field, all: CollectionConfig[]): PbField {
  switch (f.type) {
    case "text":
      return {
        ...base(f, "text"),
        autogeneratePattern: "",
        max: f.maxLength ?? 0,
        min: f.minLength ?? 0,
        pattern: "",
        primaryKey: false,
      };
    case "email":
      return { ...base(f, "email"), exceptDomains: null, onlyDomains: null };
    case "number":
      return { ...base(f, "number"), max: f.max ?? null, min: f.min ?? null, onlyInt: !!f.integer };
    case "checkbox":
      return base(f, "bool");
    case "date":
      return { ...base(f, "date"), max: "", min: "" };
    case "json":
      return { ...base(f, "json"), maxSize: 0 };
    case "select":
      return { ...base(f, "select"), maxSelect: f.hasMany ? f.options.length : 1, values: [...f.options] };
    case "relationship": {
      let target = f.relationTo;
      try {
        target = collectionId(getCollection(f.relationTo, all));
      } catch { /* unregistered target: keep the slug */ }
      return {
        ...base(f, "relation"),
        cascadeDelete: false,
        collectionId: target,
        maxSelect: f.hasMany ? 999 : 1,
        minSelect: 0,
      };
    }
    case "file":
      return {
        ...base(f, "file"),
        maxSelect: Math.max(1, f.maxSelect ?? 1),
        maxSize: f.maxSize ?? DEFAULT_MAX_SIZE,
        mimeTypes: f.mimeTypes ?? [],
        protected: !!f.protected,
        thumbs: f.thumbs ?? [],
      };
  }
}

const idField: PbField = {
  autogeneratePattern: "[a-z0-9]{15}",
  hidden: false,
  id: "text3208210256",
  max: 15,
  min: 15,
  name: "id",
  pattern: "^[a-z0-9]+$",
  presentable: false,
  primaryKey: true,
  required: true,
  system: true,
  type: "text",
};

const autodate = (name: "created" | "updated"): PbField => ({
  hidden: false,
  id: fieldId("autodate", name),
  name,
  onCreate: true,
  onUpdate: name === "updated",
  presentable: false,
  system: false,
  type: "autodate",
});

const authFields = (): PbField[] => [
  {
    ...base({ name: "password", hidden: true, required: true }, "password", true),
    cost: 0,
    max: 0,
    min: 8,
    pattern: "",
  },
  {
    ...base({ name: "tokenKey", hidden: true, required: true }, "text", true),
    autogeneratePattern: "[a-zA-Z0-9]{50}",
    max: 60,
    min: 30,
    pattern: "",
    primaryKey: false,
  },
  { ...base({ name: "email", required: true }, "email", true), exceptDomains: null, onlyDomains: null },
  base({ name: "emailVisibility" }, "bool", true),
  base({ name: "verified" }, "bool", true),
];

const token = (duration: number) => ({ duration });

function authOptions(c: CollectionConfig) {
  const auth = typeof c.auth === "object" ? c.auth : {};
  const t = (x: { subject: string; body: string }) => ({ subject: x.subject, body: x.body });
  return {
    authRule: "",
    manageRule: rule(auth.manage),
    authAlert: { enabled: !!auth.authAlert?.enabled, emailTemplate: t(TEMPLATES.authAlert) },
    oauth2: { providers: [], mappedFields: { id: "", name: "", username: "", avatarURL: "" }, enabled: false },
    passwordAuth: { enabled: true, identityFields: ["email"] },
    mfa: { enabled: false, duration: 1800, rule: "" },
    otp: {
      enabled: !!auth.otp?.enabled,
      duration: auth.otp?.duration ?? 180,
      length: auth.otp?.length ?? 8,
      emailTemplate: t(TEMPLATES.otp),
    },
    authToken: token(auth.tokenExpiration ?? TOKEN_TTL.auth),
    passwordResetToken: token(TOKEN_TTL.passwordReset),
    emailChangeToken: token(TOKEN_TTL.emailChange),
    verificationToken: token(TOKEN_TTL.verification),
    fileToken: token(TOKEN_TTL.file),
    verificationTemplate: t(TEMPLATES.verification),
    resetPasswordTemplate: t(TEMPLATES.resetPassword),
    confirmEmailChangeTemplate: t(TEMPLATES.confirmEmailChange),
  };
}

function indexes(c: CollectionConfig): string[] {
  const out: string[] = [];
  const quote = (n: string) => `\`${n}\``;
  for (const f of c.fields) {
    if (f.unique && !f.virtual) {
      out.push(`CREATE UNIQUE INDEX ${quote(`idx_${c.slug}_${f.name}`)} ON ${quote(c.slug)} (${quote(f.name)})`);
    }
  }
  for (const i of c.indexes ?? []) {
    const name = i.name ?? `idx_${c.slug}_${i.fields.join("_")}`;
    out.push(
      `CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${quote(name)} ON ${quote(c.slug)} (${
        i.fields.map((f) => quote(f) + (i.desc?.includes(f) ? " DESC" : "")).join(", ")
      })${i.where ? ` WHERE ${i.where}` : ""}`,
    );
  }
  if (c.auth) out.push(`CREATE UNIQUE INDEX ${quote(`idx_email_${collectionId(c)}`)} ON ${quote(c.slug)} (\`email\`)`);
  return out;
}

/** PB collection JSON for c; `all` resolves relation targets to their collection ids. */
export function exportCollection(c: CollectionConfig, all: CollectionConfig[]): Record<string, unknown> {
  const type = collectionType(c);
  const own = c.fields.filter((f) => !f.virtual).map((f) => field(f, all));
  const fields = type === "view" ? [idField, ...own.filter((f) => f.name !== "id")] : [
    idField,
    ...(type === "auth" ? authFields().filter((a) => !own.some((f) => f.name === a.name)) : []),
    ...own,
    autodate("created"),
    autodate("updated"),
  ];
  const out: Record<string, unknown> = {
    id: collectionId(c),
    listRule: rule(c.access?.read),
    viewRule: rule(c.access?.read),
    createRule: type === "view" ? null : rule(c.access?.create),
    updateRule: type === "view" ? null : rule(c.access?.update),
    deleteRule: type === "view" ? null : rule(c.access?.delete),
    name: c.slug,
    type,
    fields,
    indexes: type === "view" ? [] : indexes(c),
    // PB's meaning: only the built-in "_" collections (_superusers) are system; the consumer's ones are not.
    system: c.slug.startsWith("_"),
    created: "",
    updated: "",
  };
  if (type === "auth") Object.assign(out, authOptions(c));
  if (type === "view") out.viewQuery = CODE_RULE;
  return out;
}

/** PB's GET /api/collections/meta/scaffolds: empty collections of each type, the "new collection" templates. */
export function scaffolds(): Record<string, unknown> {
  const blank = (type: "base" | "auth" | "view"): CollectionConfig =>
    ({
      slug: "",
      fields: [],
      ...(type === "auth" ? { auth: true } : {}),
      ...(type === "view" ? { view: {} } : {}),
    }) as CollectionConfig;
  const out: Record<string, unknown> = {};
  for (const type of ["auth", "base", "view"] as const) {
    out[type] = { ...exportCollection(blank(type), []), id: "", name: "", system: false };
  }
  return out;
}
