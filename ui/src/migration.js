// Files migration texts (GET /api/_denobase/files-migration and its plan). Kept free of DOM so they are unit tested.
import { formatBytes } from "./ui.js";
import { formatDateTime } from "./time.js";

/** "local" / "s3:bucket@endpoint" as people read it. */
export function storageName(label) {
  if (!label || label === "local") return "local storage";
  return label.startsWith("s3:") ? `S3 ${label.slice(3)}` : label;
}

/** The dialog's question for a plan from GET .../plan. */
export function planQuestion(plan) {
  const n = plan.toCopy;
  return `Migrate ${n.toLocaleString("en-US")} file${n === 1 ? "" : "s"} (${formatBytes(plan.bytes)}) from ${
    storageName(plan.from)
  } to ${storageName(plan.to)}?`;
}

/** 0..100; a job that has not listed its source yet reads 0. */
export function progressPercent(s) {
  if (!s) return 0;
  if (s.status === "done") return 100;
  return s.total > 0 ? Math.min(100, Math.floor((s.processed / s.total) * 100)) : 0;
}

/** One line under the bar. */
export function progressLine(s) {
  const parts = [
    `${s.processed.toLocaleString("en-US")} of ${s.total.toLocaleString("en-US")} files`,
    `${s.copied} copied`,
    `${s.skipped} already there`,
  ];
  if (s.failed) parts.push(`${s.failed} failed`);
  parts.push(formatBytes(s.bytes));
  return parts.join(" · ");
}

/** Status label and badge kind. */
export function statusBadge(s) {
  if (s.status === "running" && s.stalled) return ["stalled", "warning"];
  return {
    proposed: ["proposed", "neutral"],
    running: ["running", "info"],
    done: ["done", "success"],
    failed: ["failed", "danger"],
    canceled: ["canceled", "warning"],
  }[s.status] || [s.status, "neutral"];
}

/** A failed or canceled job, or a running one whose process died, can be resumed. */
export function canResume(s) {
  return !!s && (s.status === "failed" || s.status === "canceled" || (s.status === "running" && s.stalled));
}

/** "Finished 2026-10-11 10:00:00" / "Updated ..." in the app timezone. */
export function whenLine(s) {
  if (s.finished) return `Finished ${formatDateTime(s.finished)}`;
  return s.updated ? `Updated ${formatDateTime(s.updated)}` : "";
}
