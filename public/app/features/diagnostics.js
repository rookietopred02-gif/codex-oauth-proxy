// @ts-check

import { renderExpiredAccountCleanupState, renderPreheatStatus } from "../renderers/diagnostics.js";

export function createDiagnosticsFeature(deps) {
  const { $, t, fmtUptime, displayUpstreamMode, pulseElement = () => {} } = deps;

  function renderPreheat(preheat) {
    renderPreheatStatus(deps, preheat || null);
  }

  function renderExpiredCleanup(cleanup) {
    renderExpiredAccountCleanupState(deps, cleanup || null);
  }

  function render(state, options = {}) {
    $("mode").textContent = `${state.config.authMode} | ${displayUpstreamMode(state.config.upstreamMode)}`;
    $("uptime").textContent = fmtUptime(state.uptimeMs);

    renderPreheat(state.preheat || null);
    renderExpiredCleanup(state.expiredAccountCleanup || null);

    const authOk = Boolean(state.auth?.authenticated);
    const badge = $("authBadge");
    if (!(badge instanceof HTMLElement)) return;

    badge.className = `status ${authOk ? "ok" : "bad"}`;
    badge.textContent = authOk ? t("runtime_authenticated") : t("runtime_not_authenticated");
    const prevBadge = String(badge.dataset.fxBadge || "");
    if (options.fxEnabled === true && prevBadge && prevBadge !== badge.textContent) {
      pulseElement(badge);
    }
    badge.dataset.fxBadge = badge.textContent;
  }

  return {
    render,
    renderExpiredCleanup,
    renderPreheat
  };
}
