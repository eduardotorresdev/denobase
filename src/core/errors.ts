/** One field's validation error, PB's `data.<field>`. */
export interface FieldError {
  code: string;
  message: string;
}

/** PB `data`: validation errors by field name. */
export type ErrorData = Record<string, FieldError>;

/**
 * PocketBase-compatible error; serialized as {status, message, data}. A stable domain code travels as
 * the bare string `data.code`, which the screen matches instead of the human message; it is kept apart from the
 * field errors so `data.<field>.code` stays typed.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data: ErrorData = {},
    readonly code?: string,
  ) {
    super(message);
  }
  toJSON(): { status: number; message: string; data: Record<string, FieldError | string> } {
    return {
      status: this.status,
      message: this.message,
      data: this.code ? { ...this.data, code: this.code } : this.data,
    };
  }
}

export function badRequest(
  msg: string = "Something went wrong while processing your request.",
  data: ErrorData = {},
): ApiError {
  return new ApiError(400, msg, data);
}
export function unauthorized(msg: string = "The request requires valid record authorization token."): ApiError {
  return new ApiError(401, msg);
}
export function forbidden(msg: string = "The authorized record is not allowed to perform this action."): ApiError {
  return new ApiError(403, msg);
}
export function notFound(msg: string = "The requested resource wasn't found."): ApiError {
  return new ApiError(404, msg);
}

/**
 * `data.code` of every authorization 403: belongs to the authorization mechanism, not to a module, so it is the same
 * on every route. A wire value the front-end matches: never rename.
 */
export const CODE_PERMISSION_DENIED = "permissao_negada";

/** snake_case, like every domain code (the front reads them). */
const CODE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/**
 * Domain error with a stable code: human `message`, identifier in `data.code`.
 * 400 = "I did not understand what you sent"; 422 = "understood, and the entity's state refuses it".
 */
export function stableError(status: 400 | 403 | 404 | 409 | 422, code: string, message: string): ApiError {
  if (!CODE.test(code)) throw new Error(`stableError: code must be snake_case, got ${JSON.stringify(code)}`);
  return new ApiError(status, message, {}, code);
}

export const stableBadRequest = (code: string, message: string): ApiError => stableError(400, code, message);
export const stableNotFound = (code: string, message: string): ApiError => stableError(404, code, message);
export const stableUnprocessable = (code: string, message: string): ApiError => stableError(422, code, message);
/** 403 of authorization; defaults to CODE_PERMISSION_DENIED so screens tell "no access" from a state refusal. */
export const stableForbidden = (message: string, code: string = CODE_PERMISSION_DENIED): ApiError =>
  stableError(403, code, message);

/** Throws for unfinished stubs so parallel owners see a loud failure instead of silent wrong data. */
export function notImplemented(what: string): never {
  throw new Error(`not implemented: ${what}`);
}
