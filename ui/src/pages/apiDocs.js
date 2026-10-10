// "API preview" dialog of a collection: operations on the left, params/body/responses and SDK snippets on the right.
import { badge, copyButton, modal } from "../ui.js";

const LANG_KEY = "denobase_api_lang";
const LANGS = ["JavaScript", "Dart", "curl", "Python", "Go"];

const SKIP_FIELDS = new Set(["id", "created", "updated"]);

const QUERY = {
  page: ["Number", "The page (aka. offset) of the paginated list (default to 1)."],
  perPage: ["Number", "Specify the max returned records per page (default to 30)."],
  sort: ["String", "Specify the records order attribute(s). Prefix with - for DESC, e.g. ?sort=-created,id"],
  filter: ["String", "Filter the returned records, e.g. ?filter=(title~'abc' && created>'2022-01-01')"],
  expand: ["String", "Auto expand record relations, e.g. ?expand=relField1,relField2.subRelField"],
  fields: ["String", "Comma separated string of the fields to return in the JSON response (default: all)."],
  skipTotal: ["Boolean", "Skip the total counts query (totalItems and totalPages become -1)."],
};

const sdkPick = (keys) => Object.fromEntries(keys.map((k) => [k, QUERY[k]]));

/** Example value per PB field type (for the response example). */
function example(f) {
  switch (f.type) {
    case "number":
      return 0;
    case "bool":
      return false;
    case "date":
    case "autodate":
      return "2026-01-01 12:00:00.000Z";
    case "relation":
      return f.maxSelect > 1 ? ["RELATION_RECORD_ID"] : "RELATION_RECORD_ID";
    case "file":
      return f.maxSelect > 1 ? ["filename.jpg"] : "filename.jpg";
    case "json":
      return {};
    case "select": {
      const v = f.values?.[0] ?? "";
      return f.maxSelect > 1 ? [v] : v;
    }
    case "email":
      return "test@example.com";
    default:
      return f.name === "id" ? "RECORD_ID" : "text";
  }
}

function record(col) {
  const out = { id: "RECORD_ID", collectionId: col.id, collectionName: col.name };
  for (const f of col.fields || []) {
    if (f.hidden || f.type === "password" || f.name === "tokenKey") continue;
    if (!(f.name in out)) out[f.name] = example(f);
  }
  return out;
}

/** Body fields for create/update: user fields only (id/created/updated/system skipped). */
function bodyFields(col) {
  return (col.fields || []).filter((f) => !SKIP_FIELDS.has(f.name) && !f.system && f.type !== "autodate");
}

const pbError = (code, message, data = {}) => ({ status: code, message, data });

const ERR = {
  400: pbError(400, "Failed to create record.", {
    name: { code: "validation_required", message: "Missing required value." },
  }),
  403: pbError(403, "Only superusers can perform this action."),
  404: pbError(404, "The requested resource wasn't found."),
};

/** Operations of a collection, each with method, path, params, body, responses and a snippets() function. */
function operations(col) {
  const n = col.name;
  const rec = record(col);
  const list = { page: 1, perPage: 30, totalItems: 1, totalPages: 1, items: [rec] };
  const authOk = { token: "JWT_TOKEN", record: rec };
  const isView = col.type === "view";
  const body = Object.fromEntries(bodyFields(col).map((f) => [f.name, example(f)]));
  const ops = [
    {
      id: "list",
      label: "List / Search",
      method: "GET",
      path: `/api/collections/${n}/records`,
      query: QUERY,
      responses: { 200: list, 400: ERR[400], 403: ERR[403] },
      js:
        `const result = await pb.collection('${n}').getList(1, 30, {\n  filter: 'created >= "2026-01-01 00:00:00"',\n  sort: '-created',\n});`,
      dart:
        `final result = await pb.collection('${n}').getList(\n  page: 1,\n  perPage: 30,\n  filter: 'created >= "2026-01-01 00:00:00"',\n  sort: '-created',\n);`,
      http: { method: "GET", path: `/api/collections/${n}/records?page=1&perPage=30&sort=-created` },
    },
    {
      id: "view",
      label: "View",
      method: "GET",
      path: `/api/collections/${n}/records/:id`,
      query: sdkPick(["expand", "fields"]),
      responses: { 200: rec, 403: ERR[403], 404: ERR[404] },
      js:
        `const record = await pb.collection('${n}').getOne('RECORD_ID', {\n  expand: 'relField1,relField2.subRelField',\n});`,
      dart:
        `final record = await pb.collection('${n}').getOne('RECORD_ID',\n  expand: 'relField1,relField2.subRelField',\n);`,
      http: { method: "GET", path: `/api/collections/${n}/records/RECORD_ID` },
    },
  ];
  if (!isView) {
    ops.push(
      {
        id: "create",
        label: "Create",
        method: "POST",
        path: `/api/collections/${n}/records`,
        query: sdkPick(["expand", "fields"]),
        body: bodyFields(col),
        responses: { 200: rec, 400: ERR[400], 403: ERR[403] },
        js: `const data = ${
          JSON.stringify(body, null, 2)
        };\n\nconst record = await pb.collection('${n}').create(data);`,
        dart: `final body = <String, dynamic>${
          JSON.stringify(body, null, 2)
        };\n\nfinal record = await pb.collection('${n}').create(body: body);`,
        http: { method: "POST", path: `/api/collections/${n}/records`, body },
      },
      {
        id: "update",
        label: "Update",
        method: "PATCH",
        path: `/api/collections/${n}/records/:id`,
        query: sdkPick(["expand", "fields"]),
        body: bodyFields(col),
        responses: { 200: rec, 400: ERR[400], 403: ERR[403], 404: ERR[404] },
        js: `const data = ${
          JSON.stringify(body, null, 2)
        };\n\nconst record = await pb.collection('${n}').update('RECORD_ID', data);`,
        dart: `final body = <String, dynamic>${
          JSON.stringify(body, null, 2)
        };\n\nfinal record = await pb.collection('${n}').update('RECORD_ID', body: body);`,
        http: { method: "PATCH", path: `/api/collections/${n}/records/RECORD_ID`, body },
      },
      {
        id: "delete",
        label: "Delete",
        method: "DELETE",
        path: `/api/collections/${n}/records/:id`,
        query: {},
        responses: { 204: null, 400: pbError(400, "Failed to delete record."), 403: ERR[403], 404: ERR[404] },
        js: `await pb.collection('${n}').delete('RECORD_ID');`,
        dart: `await pb.collection('${n}').delete('RECORD_ID');`,
        http: { method: "DELETE", path: `/api/collections/${n}/records/RECORD_ID` },
      },
      {
        id: "realtime",
        label: "Realtime",
        method: "SSE",
        path: `/api/realtime`,
        query: {},
        note: "Subscribe to changes of the whole collection (*) or of a single record. Only the SDKs are shown: " +
          "realtime is an SSE connection plus a POST /api/realtime with the subscriptions.",
        responses: { 200: { action: "create", record: rec } },
        js:
          `// subscribe to changes of any record of the collection\npb.collection('${n}').subscribe('*', (e) => {\n  console.log(e.action, e.record);\n});\n\n// subscribe to a single record\npb.collection('${n}').subscribe('RECORD_ID', (e) => {\n  console.log(e.action, e.record);\n});\n\n// unsubscribe\npb.collection('${n}').unsubscribe('RECORD_ID');\npb.collection('${n}').unsubscribe();`,
        dart:
          `// subscribe to changes of any record of the collection\npb.collection('${n}').subscribe('*', (e) {\n  print(e.action);\n  print(e.record);\n});\n\n// subscribe to a single record\npb.collection('${n}').subscribe('RECORD_ID', (e) {\n  print(e.action);\n  print(e.record);\n});\n\n// unsubscribe\npb.collection('${n}').unsubscribe('RECORD_ID');\npb.collection('${n}').unsubscribe();`,
        http: {
          method: "POST",
          path: `/api/realtime`,
          body: { clientId: "CLIENT_ID", subscriptions: [`${n}`, `${n}/RECORD_ID`] },
        },
      },
      {
        id: "batch",
        label: "Batch",
        method: "POST",
        path: `/api/batch`,
        query: {},
        note: "Several create/update/upsert/delete requests in one transaction (needs batch enabled in Settings).",
        responses: {
          200: [{ status: 200, body: rec }, { status: 204, body: null }],
          400: pbError(400, "Batch transaction failed.", {
            requests: { 0: { code: "batch_request_failed", message: "Batch request failed." } },
          }),
          403: pbError(403, "Batch requests are not allowed."),
        },
        js: `const batch = pb.createBatch();\n\nbatch.collection('${n}').create(${
          JSON.stringify(body)
        });\nbatch.collection('${n}').update('RECORD_ID', ${
          JSON.stringify(body)
        });\nbatch.collection('${n}').delete('RECORD_ID');\n\nconst result = await batch.send();`,
        dart: `final batch = pb.createBatch();\n\nbatch.collection('${n}').create(body: ${
          JSON.stringify(body)
        });\nbatch.collection('${n}').update('RECORD_ID', body: ${
          JSON.stringify(body)
        });\nbatch.collection('${n}').delete('RECORD_ID');\n\nfinal result = await batch.send();`,
        http: {
          method: "POST",
          path: `/api/batch`,
          body: {
            requests: [
              { method: "POST", url: `/api/collections/${n}/records`, body },
              { method: "DELETE", url: `/api/collections/${n}/records/RECORD_ID` },
            ],
          },
        },
      },
    );
  }
  if (col.type === "auth") {
    ops.push(
      {
        id: "authPassword",
        label: "Auth with password",
        group: "auth",
        method: "POST",
        path: `/api/collections/${n}/auth-with-password`,
        query: sdkPick(["expand", "fields"]),
        body: [
          { name: "identity", type: "text", required: true },
          { name: "password", type: "password", required: true },
        ],
        responses: { 200: authOk, 400: pbError(400, "Failed to authenticate.") },
        js:
          `const authData = await pb.collection('${n}').authWithPassword(\n  'test@example.com',\n  '1234567890',\n);\n\n// after the above you can also access the auth data from the authStore\nconsole.log(pb.authStore.isValid);\nconsole.log(pb.authStore.token);\nconsole.log(pb.authStore.record.id);\n\n// "logout"\npb.authStore.clear();`,
        dart:
          `final authData = await pb.collection('${n}').authWithPassword(\n  'test@example.com',\n  '1234567890',\n);\n\nprint(pb.authStore.isValid);\nprint(pb.authStore.token);\nprint(pb.authStore.record.id);\n\n// "logout"\npb.authStore.clear();`,
        http: {
          method: "POST",
          path: `/api/collections/${n}/auth-with-password`,
          body: { identity: "test@example.com", password: "1234567890" },
        },
      },
      {
        id: "authRefresh",
        label: "Auth refresh",
        group: "auth",
        method: "POST",
        path: `/api/collections/${n}/auth-refresh`,
        query: sdkPick(["expand", "fields"]),
        auth: true,
        responses: {
          200: authOk,
          401: pbError(401, "The request requires valid record authorization token."),
          403: ERR[403],
          404: ERR[404],
        },
        js: `const authData = await pb.collection('${n}').authRefresh();`,
        dart: `final authData = await pb.collection('${n}').authRefresh();`,
        http: { method: "POST", path: `/api/collections/${n}/auth-refresh`, auth: true },
      },
      {
        id: "passwordReset",
        label: "Request password reset",
        group: "auth",
        method: "POST",
        path: `/api/collections/${n}/request-password-reset`,
        query: {},
        body: [{ name: "email", type: "email", required: true }],
        responses: { 204: null, 400: pbError(400, "An error occurred while validating the submitted data.") },
        js:
          `await pb.collection('${n}').requestPasswordReset('test@example.com');\n\n// ---\n// (optional) in your custom confirmation page:\n// ---\nawait pb.collection('${n}').confirmPasswordReset(\n  'RESET_TOKEN',\n  'NEW_PASSWORD',\n  'NEW_PASSWORD_CONFIRM',\n);`,
        dart:
          `await pb.collection('${n}').requestPasswordReset('test@example.com');\n\n// (optional) in your custom confirmation page:\nawait pb.collection('${n}').confirmPasswordReset(\n  'RESET_TOKEN',\n  'NEW_PASSWORD',\n  'NEW_PASSWORD_CONFIRM',\n);`,
        http: {
          method: "POST",
          path: `/api/collections/${n}/request-password-reset`,
          body: { email: "test@example.com" },
        },
      },
      {
        id: "verification",
        label: "Request verification",
        group: "auth",
        method: "POST",
        path: `/api/collections/${n}/request-verification`,
        query: {},
        body: [{ name: "email", type: "email", required: true }],
        responses: { 204: null, 400: pbError(400, "An error occurred while validating the submitted data.") },
        js:
          `await pb.collection('${n}').requestVerification('test@example.com');\n\n// ---\n// (optional) in your custom confirmation page:\n// ---\nawait pb.collection('${n}').confirmVerification('VERIFICATION_TOKEN');`,
        dart:
          `await pb.collection('${n}').requestVerification('test@example.com');\n\n// (optional) in your custom confirmation page:\nawait pb.collection('${n}').confirmVerification('VERIFICATION_TOKEN');`,
        http: {
          method: "POST",
          path: `/api/collections/${n}/request-verification`,
          body: { email: "test@example.com" },
        },
      },
      {
        id: "authMethods",
        label: "List auth methods",
        group: "auth",
        method: "GET",
        path: `/api/collections/${n}/auth-methods`,
        query: sdkPick(["fields"]),
        responses: {
          200: {
            password: { enabled: true, identityFields: ["email"] },
            oauth2: { enabled: false, providers: [] },
            mfa: { enabled: false, duration: 0 },
            otp: { enabled: false, duration: 0 },
          },
        },
        js: `const result = await pb.collection('${n}').listAuthMethods();`,
        dart: `final result = await pb.collection('${n}').listAuthMethods();`,
        http: { method: "GET", path: `/api/collections/${n}/auth-methods` },
      },
    );
  }
  return ops;
}

/** Snippets of an operation in every language. */
function snippets(op, baseUrl) {
  const { method, path, body, auth } = op.http;
  const url = baseUrl + path;
  const json = body ? JSON.stringify(body, null, 2) : "";
  const needsAuth = auth || ["create", "update", "delete", "batch"].includes(op.id);
  const authLine = needsAuth ? "YOUR_AUTH_TOKEN" : "";
  const sdkInit = (lang) =>
    lang === "js"
      ? `import PocketBase from 'pocketbase';\n\nconst pb = new PocketBase('${baseUrl}');\n\n...\n\n`
      : `import 'package:pocketbase/pocketbase.dart';\n\nfinal pb = PocketBase('${baseUrl}');\n\n...\n\n`;

  const curl = [
    `curl -X ${method} '${url}'`,
    needsAuth ? `  -H 'Authorization: ${authLine}'` : null,
    json ? `  -H 'Content-Type: application/json'` : null,
    json ? `  -d '${json.replaceAll("\n", "\n  ")}'` : null,
  ].filter(Boolean).join(" \\\n");

  const py = [
    "import requests",
    "",
    `url = "${url}"`,
    needsAuth ? `headers = {"Authorization": "${authLine}"}` : "headers = {}",
    json
      ? `payload = ${json.replaceAll("null", "None").replaceAll("true", "True").replaceAll("false", "False")}`
      : null,
    "",
    `response = requests.${method.toLowerCase()}(url, headers=headers${json ? ", json=payload" : ""})`,
    "print(response.status_code)",
    "print(response.json() if response.content else None)",
  ].filter((x) => x !== null).join("\n");

  const go = [
    "package main",
    "",
    "import (",
    json ? '\t"bytes"' : null,
    '\t"fmt"',
    '\t"io"',
    '\t"net/http"',
    ")",
    "",
    "func main() {",
    json ? `\tbody := []byte(\`${json}\`)` : null,
    json
      ? `\treq, err := http.NewRequest("${method}", "${url}", bytes.NewReader(body))`
      : `\treq, err := http.NewRequest("${method}", "${url}", nil)`,
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    json ? '\treq.Header.Set("Content-Type", "application/json")' : null,
    needsAuth ? `\treq.Header.Set("Authorization", "${authLine}")` : null,
    "\tres, err := http.DefaultClient.Do(req)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tdefer res.Body.Close()",
    "\tout, _ := io.ReadAll(res.Body)",
    "\tfmt.Println(res.StatusCode, string(out))",
    "}",
  ].filter((x) => x !== null).join("\n");

  return [
    { label: "JavaScript", code: sdkInit("js") + op.js },
    { label: "Dart", code: sdkInit("dart") + op.dart },
    { label: "curl", code: curl },
    { label: "Python", code: py },
    { label: "Go", code: go },
  ];
}

function paramsTable(query) {
  const keys = Object.keys(query);
  if (!keys.length) return null;
  return t.div(
    { className: "table-wrap" },
    t.table(
      { className: "table api-table" },
      t.thead(
        {},
        t.tr({}, t.th({ textContent: "Param" }), t.th({ textContent: "Type" }), t.th({ textContent: "Description" })),
      ),
      t.tbody(
        {},
        keys.map((k) =>
          t.tr(
            {},
            t.td({ className: "mono", textContent: k }),
            t.td({}, badge(query[k][0], "info")),
            t.td({ className: "api-desc", textContent: query[k][1] }),
          )
        ),
      ),
    ),
  );
}

function bodyTable(fields) {
  if (!fields?.length) return t.p({ className: "muted", textContent: "No body fields." });
  return t.div(
    { className: "table-wrap" },
    t.table(
      { className: "table api-table" },
      t.thead(
        {},
        t.tr({}, t.th({ textContent: "Field" }), t.th({ textContent: "Type" }), t.th({ textContent: "Required" })),
      ),
      t.tbody(
        {},
        fields.map((f) =>
          t.tr(
            {},
            t.td({ className: "mono", textContent: f.name }),
            t.td({}, badge(f.type, "info")),
            t.td(
              {},
              f.required ? badge("required", "warning") : t.span({ className: "muted", textContent: "optional" }),
            ),
          )
        ),
      ),
    ),
  );
}

function responses(map) {
  return t.div(
    { className: "api-responses" },
    Object.entries(map).map(([code, body]) =>
      t.div(
        { className: "api-response" },
        t.div(
          { className: "row" },
          badge(code, Number(code) < 300 ? "accent" : "danger"),
          t.span({ className: "muted", textContent: Number(code) === 204 ? "No content" : "application/json" }),
        ),
        body === null ? null : t.pre({ className: "code", textContent: JSON.stringify(body, null, 2) }),
      )
    ),
  );
}

function readLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return LANGS.includes(v) ? v : LANGS[0];
  } catch {
    return LANGS[0];
  }
}

function writeLang(v) {
  try {
    localStorage.setItem(LANG_KEY, v);
  } catch { /* storage blocked: keep the in-memory choice */ }
}

/** Tabbed snippets (same look as the kit's codeTabs) with the chosen language persisted in localStorage. */
function langTabs(list) {
  const s = store({ lang: readLang() });
  const current = () => list.find((x) => x.label === s.lang) || list[0];
  return t.div(
    { className: "code-tabs" },
    t.div(
      { className: "tabs" },
      list.map((x) =>
        t.button({
          type: "button",
          className: () => `tab ${current().label === x.label ? "active" : ""}`,
          textContent: x.label,
          onclick: () => {
            s.lang = x.label;
            writeLang(x.label);
          },
        })
      ),
      t.span({ className: "spacer" }),
      copyButton(() => current().code),
    ),
    t.pre({ className: "code", textContent: () => current().code }),
  );
}

function section(title, ...children) {
  return t.div({ className: "api-section" }, t.h4({ className: "card-title", textContent: title }), ...children);
}

/** Opens the API preview modal of a collection. */
export function openApiDocs(col) {
  const baseUrl = (app.pb?.baseURL || globalThis.location.origin).replace(/\/$/, "");
  const ops = operations(col);
  const s = store({ id: ops[0].id });
  const current = () => ops.find((o) => o.id === s.id) || ops[0];

  const nav = (group) =>
    ops.filter((o) => (o.group || "records") === group).map((o) =>
      t.button(
        {
          type: "button",
          rid: o.id,
          className: () => `api-nav-item ${s.id === o.id ? "active" : ""}`,
          onclick: () => s.id = o.id,
        },
        t.span({ className: `api-method api-method-${o.method.toLowerCase()}`, textContent: o.method }),
        t.span({ textContent: o.label }),
      )
    );

  const detail = () => {
    const op = current();
    return t.div(
      { rid: op.id, className: "api-detail" },
      t.div(
        { className: "api-endpoint" },
        t.span({ className: `api-method api-method-${op.method.toLowerCase()}`, textContent: op.method }),
        t.code({ className: "api-path", textContent: baseUrl + op.path }),
      ),
      op.note ? t.p({ className: "muted", textContent: op.note }) : null,
      op.auth
        ? t.div({ className: "alert alert-info", textContent: "Requires an Authorization header with a record token." })
        : null,
      Object.keys(op.query).length ? section("Query parameters", paramsTable(op.query)) : null,
      op.body ? section("Body parameters", bodyTable(op.body)) : null,
      section("Responses", responses(op.responses)),
      section("Code", langTabs(snippets(op, baseUrl))),
    );
  };

  return modal(
    t.div(
      { className: "api-docs" },
      t.aside(
        { className: "api-nav" },
        t.div({ className: "nav-section", textContent: "Records" }),
        ...nav("records"),
        col.type === "auth" ? t.div({ className: "nav-section", textContent: "Auth" }) : null,
        ...(col.type === "auth" ? nav("auth") : []),
      ),
      t.div({ className: "api-main" }, detail),
    ),
    { title: `API preview · ${col.name}`, size: "full" },
  );
}
