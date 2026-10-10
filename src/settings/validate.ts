import type { ApiError } from "../core/errors.ts";
import { isTimeZone, Schedule } from "../cron/schedule.ts";
import type { Settings } from "./model.ts";
import { EMAIL } from "../core/text.ts";

type Errs = ApiError["data"];
const err = (code: string, message: string) => ({ code, message });
const required = () => err("validation_required", "Cannot be blank.");

/** The PB validation rules a client can trip; nested errors keep PB's shape (data.meta.appName.code). */
export function validateSettings(s: Settings): Errs {
  const errs: Record<string, Record<string, unknown>> = {};
  const add = (group: string, field: string, e: { code: string; message: string }) => {
    (errs[group] ??= {})[field] = e;
  };
  if (!s.meta.appName) add("meta", "appName", required());
  else if (s.meta.appName.length > 255) {
    add("meta", "appName", err("validation_length_out_of_range", "The length must be between 1 and 255."));
  }
  if (!s.meta.appURL) add("meta", "appURL", required());
  else if (!URL.canParse(s.meta.appURL)) add("meta", "appURL", err("validation_is_url", "Must be a valid URL."));
  if (!s.meta.timezone) add("meta", "timezone", required());
  else if (!isTimeZone(s.meta.timezone)) {
    add("meta", "timezone", err("validation_invalid_timezone", "Must be a valid IANA timezone."));
  }
  if (!s.meta.senderName) add("meta", "senderName", required());
  if (!s.meta.senderAddress) add("meta", "senderAddress", required());
  else if (!EMAIL.test(s.meta.senderAddress)) {
    add("meta", "senderAddress", err("validation_is_email", "Must be a valid email address."));
  }
  if (s.smtp.enabled) {
    if (!s.smtp.host) add("smtp", "host", required());
    if (!s.smtp.port) add("smtp", "port", required());
  }
  for (const [k, v] of [["maxRequests", s.batch.maxRequests], ["timeout", s.batch.timeout]] as const) {
    if (v < 0) add("batch", k, err("validation_min_greater_equal_than_required", "Must be no less than 0."));
  }
  if (s.logs.maxDays < 0) {
    add("logs", "maxDays", err("validation_min_greater_equal_than_required", "Must be no less than 0."));
  }
  const min0 = () => err("validation_min_greater_equal_than_required", "Must be no less than 0.");
  for (const k of ["maxDays", "minDurationMs", "slowMs", "maxSpansPerTrace"] as const) {
    if (!(s.traces[k] >= 0)) add("traces", k, min0());
  }
  if (!(s.traces.sampleRatio >= 0 && s.traces.sampleRatio <= 1)) {
    add("traces", "sampleRatio", err("validation_out_of_range", "Must be between 0 and 1."));
  }
  if (!Array.isArray(s.traces.propagateHosts) || s.traces.propagateHosts.some((h) => typeof h !== "string")) {
    add("traces", "propagateHosts", err("validation_invalid_value", "Must be a list of host names."));
  }
  for (const k of ["accessTokenTTL", "refreshTokenTTL", "codeTTL", "sessionTTL"] as const) {
    if (!(Number.isInteger(s.oauth[k]) && s.oauth[k] >= 1)) {
      add("oauth", k, err("validation_min_greater_equal_than_required", "Must be no less than 1."));
    }
  }
  if (s.oauth.codeTTL > 600) add("oauth", "codeTTL", err("validation_out_of_range", "Must be at most 600."));
  if (typeof s.oauth.defaultCollection !== "string") {
    add("oauth", "defaultCollection", err("validation_invalid_value", "Must be a collection name."));
  }
  for (const k of ["allowedCollections", "cimdAllowDomains", "cimdDenyDomains", "allowedRedirectHosts"] as const) {
    if (!Array.isArray(s.oauth[k]) || s.oauth[k].some((h) => typeof h !== "string")) {
      add("oauth", k, err("validation_invalid_value", "Must be a list of names."));
    }
  }
  if (s.backups.cron) {
    try {
      new Schedule(s.backups.cron);
    } catch (e) {
      add("backups", "cron", err("validation_invalid_cron", (e as Error).message));
    }
  }
  if (s.backups.cronMaxKeep < 0) {
    add("backups", "cronMaxKeep", err("validation_min_greater_equal_than_required", "Must be no less than 0."));
  }
  return errs as unknown as Errs;
}
