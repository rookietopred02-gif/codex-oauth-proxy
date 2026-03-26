// @ts-check

export function renderPreheatStatus(deps, preheat) {
  const { $, t, tt, fmtUnixSec } = deps;
  const el = $("preheatStatus");
  if (!el) return;
  if (!preheat) {
    el.className = "preheat-status";
    el.textContent = t("preheat_no_state");
    return;
  }

  const lastRun = fmtUnixSec(Number(preheat.lastRunAt || 0));
  const completed = fmtUnixSec(Number(preheat.lastCompletedAt || 0));
  const summary = preheat.lastSummary || null;
  const summaryText = summary
    ? tt("preheat_summary_fmt", {
        status: summary.status || "-",
        success: summary.success ?? 0,
        failed: summary.failed ?? 0,
        models: summary.modelCount ?? 0,
        accounts: summary.selectedAccounts ?? 0,
        attempts: summary.attempts ?? summary.selected ?? 0
      })
    : t("preheat_summary_none");
  const runningText = preheat.running ? t("preheat_running_state_running") : t("preheat_running_state_idle");
  const errorText =
    typeof preheat.lastError === "string" && preheat.lastError.trim().length > 0
      ? tt("preheat_error_segment", { error: preheat.lastError.trim() })
      : "";

  el.className = `preheat-status ${
    preheat.lastStatus === "failed" ? "bad" : preheat.lastStatus === "ok" || preheat.lastStatus === "partial" ? "ok" : ""
  }`;
  el.textContent = `${tt("preheat_status_line", {
    status: preheat.lastStatus || "idle",
    running: runningText,
    summary: summaryText
  })}\n${tt("preheat_status_line_2", {
    run: lastRun,
    complete: completed,
    duration: Number(preheat.lastDurationMs || 0),
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

  const lastRun = fmtUnixSec(Number(cleanup.lastRunAt || 0));
  const completed = fmtUnixSec(Number(cleanup.lastCompletedAt || 0));
  const errorText =
    typeof cleanup.lastError === "string" && cleanup.lastError.trim().length > 0
      ? tt("expired_cleanup_error_segment", { error: cleanup.lastError.trim() })
      : "";
  const statusClass =
    cleanup.lastStatus === "failed" ? "bad" : cleanup.lastStatus === "ok" || cleanup.lastStatus === "idle" ? "ok" : "";

  el.className = statusClass ? `preheat-status ${statusClass}` : "preheat-status";
  el.textContent = `${tt("expired_cleanup_status_line", {
    status: cleanup.lastStatus || "idle",
    running: cleanup.running ? t("preheat_running_state_running") : t("preheat_running_state_idle"),
    removed: Number(cleanup.lastRemovedCount || 0)
  })}\n${tt("expired_cleanup_status_line_2", {
    run: lastRun,
    complete: completed,
    reason: cleanup.lastReason || "-",
    error: errorText
  })}`;
}
