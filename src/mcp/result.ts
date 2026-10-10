import { ApiError, CODE_PERMISSION_DENIED } from "../core/errors.ts";
import type { McpContent, McpReadResult, McpResourceContents } from "./types.ts";

/** The CallToolResult shape we build (the SDK's type is wider; this is what we send). */
export interface ToolResult {
  [k: string]: unknown;
  content: McpContent["content"];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const enc = new TextEncoder();

export function isMcpContent(v: unknown): v is McpContent {
  return !!v && typeof v === "object" && Array.isArray((v as { content?: unknown }).content);
}

/**
 * A handler's value as a tool result: an object becomes structuredContent and its JSON as text, so both always
 * carry the same value. A tool with an output schema must return an object (the SDK validates it) and is never
 * cut. Without one, text over maxBytes is not cut mid-JSON: the call answers an isError `resultado_truncado` (text
 * and structuredContent alike) telling the model to ask for less.
 */
export function toolResult(value: unknown, maxBytes: number, hasOutput: boolean): ToolResult {
  if (isMcpContent(value)) return value as ToolResult;
  const structured = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (hasOutput && !structured) {
    return internalErrorResult("The tool declares an output schema but did not return an object.");
  }
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 0);
  const bytes = enc.encode(text).length;
  if (hasOutput || bytes <= maxBytes) {
    return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
  }
  return errorResult({
    code: "resultado_truncado",
    status: 413,
    message: `Result of ${bytes} bytes is over ${maxBytes}: page it (page/perPage), narrow it (filter, fields) ` +
      "or ask for less.",
    truncated: true,
  });
}

function errorResult(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: true };
}

/** The code of an error: its stable code when it has one, permissao_negada for any other 403. */
export function errorCode(e: ApiError): string {
  if (e.code) return e.code;
  if (e.status === 403) return CODE_PERMISSION_DENIED;
  if (e.status === 404) return "nao_encontrado";
  if (e.status === 401) return "nao_autenticado";
  return e.status === 400 ? "requisicao_invalida" : `http_${e.status}`;
}

/** An ApiError as a tool-level error (isError), never a protocol error: the model reads it and can recover. */
export function apiErrorResult(e: ApiError): ToolResult {
  return errorResult(apiErrorBody(e));
}

/** The one error body of the MCP surface: tools (isError) and resources/prompts (JSON-RPC error data) share it. */
export function apiErrorBody(e: ApiError): { code: string; status: number; message: string; data: unknown } {
  return { code: errorCode(e), status: e.status, message: e.message, data: e.toJSON().data };
}

export function internalErrorResult(
  message = "Internal error while running the tool.",
  code = "erro_interno",
): ToolResult {
  return errorResult({ code, status: 500, message });
}

/** A resource read value as contents of uri. */
export function readContents(
  uri: string,
  value: McpReadResult,
  mimeType?: string,
): { contents: McpResourceContents[] } {
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.contents)) {
    return value as { contents: McpResourceContents[] };
  }
  if (typeof value === "string") return { contents: [{ uri, mimeType: mimeType ?? "text/plain", text: value }] };
  return { contents: [{ uri, mimeType: mimeType ?? "application/json", text: JSON.stringify(value, null, 2) }] };
}
