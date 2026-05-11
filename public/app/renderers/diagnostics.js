// @ts-check

function toIntegerNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : fallback;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function toNonNegativeInteger(value, fallback = 0) {
  const n = toIntegerNumber(value, null);
  if (n === null || n < 0) return fallback;
  return n;
}

function safeText(value, fallback = "-") {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return text || fallback;
}

export function renderPreheatStatus(deps, preheat) {
  const { $, t, tt, fmtUnixSec } = deps;
  const el = $("preheatStatus");
  if (!el) return;
  if (!preheat) {
    el.className = "preheat-status";
    el.textContent = t("preheat_no_state");
    return;
  }

  const lastRun = fmtUnixSec(toNonNegativeInteger(preheat.lastRunAt, 0));
  const completed = fmtUnixSec(toNonNegativeInteger(preheat.lastCompletedAt, 0));
  const summary = preheat.lastSummary || null;
  const selectedAttempts = toNonNegativeInteger(summary?.selected, 0);
  const summaryText = summary
    ? tt("preheat_summary_fmt", {
        status: safeText(summary.status, "-"),
        success: toNonNegativeInteger(summary.success, 0),
        failed: toNonNegativeInteger(summary.failed, 0),
        models: toNonNegativeInteger(summary.modelCount, 0),
        accounts: toNonNegativeInteger(summary.selectedAccounts, 0),
        attempts: toNonNegativeInteger(summary.attempts, selectedAttempts)
      })
    : t("preheat_summary_none");
  const runningText = preheat.running ? t("preheat_running_state_running") : t("preheat_running_state_idle");
  const errorText =
    typeof preheat.lastError === "string" && preheat.lastError.trim().length > 0
      ? tt("preheat_error_segment", { error: preheat.lastError.trim() })
      : "";

  const status = safeText(preheat.lastStatus, "idle");
  const statusClass = status === "failed" ? "bad" : status === "ok" || status === "partial" ? "ok" : "";
  el.className = statusClass ? `preheat-status ${statusClass}` : "preheat-status";
  el.textContent = `${tt("preheat_status_line", {
    status,
    running: runningText,
    summary: summaryText
  })}\n${tt("preheat_status_line_2", {
    run: lastRun,
    complete: completed,
    duration: toNonNegativeInteger(preheat.lastDurationMs, 0),
    error: errorText
  })}`;
}

export function renderExpiredAccountCleanupState(deps, cleanup) {
  const { $, t, tt, fmtUnixSec } = deps;
  const el = $("expiredAccountCleanupStatus");
  if (!el) return;
  if (!cleanup) {
    el.className = "preheat-status";
    el.textContent = t("expired_cleanup_idle");
    return;
  }

  const lastRun = fmtUnixSec(toNonNegativeInteger(cleanup.lastRunAt, 0));
  const completed = fmtUnixSec(toNonNegativeInteger(cleanup.lastCompletedAt, 0));
  const errorText =
    typeof cleanup.lastError === "string" && cleanup.lastError.trim().length > 0
      ? tt("expired_cleanup_error_segment", { error: cleanup.lastError.trim() })
      : "";
  const status = safeText(cleanup.lastStatus, "idle");
  const statusClass = status === "failed" ? "bad" : status === "ok" || status === "idle" ? "ok" : "";

  el.className = statusClass ? `preheat-status ${statusClass}` : "preheat-status";
  el.textContent = `${tt("expired_cleanup_status_line", {
    status,
    running: cleanup.running ? t("preheat_running_state_running") : t("preheat_running_state_idle"),
    removed: toNonNegativeInteger(cleanup.lastRemovedCount, 0)
  })}\n${tt("expired_cleanup_status_line_2", {
    run: lastRun,
    complete: completed,
    reason: safeText(cleanup.lastReason, "-"),
    error: errorText
  })}`;
}
