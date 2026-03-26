// @ts-check

export function createDashboardAuthFeature(deps) {
  const {
    $,
    api,
    t,
    tt,
    setResultMessage,
    minimumPasswordLength = 8,
    loadProtectedData = async () => {}
  } = deps;

  let state = {
    enabled: false,
    configured: false,
    authenticated: false
  };

  function isLocked() {
    return state.enabled === true && state.authenticated !== true;
  }

  function render() {
    const enabled = state.enabled === true;
    const configured = state.configured === true;
    const authenticated = state.authenticated === true;
    const locked = isLocked();
    const statusMessage = enabled
      ? authenticated
        ? t("dashboard_auth_status_enabled_active")
        : t("dashboard_auth_status_enabled_locked")
      : configured
        ? t("dashboard_auth_status_disabled_set")
        : t("dashboard_auth_status_disabled_unset");
    const statusTone = enabled ? (authenticated ? "ok" : "warn") : configured ? "" : "warn";

    if ($("dashboardAuthEnabled")) {
      $("dashboardAuthEnabled").checked = enabled;
    }
    if ($("dashboardAuthLogoutBtn")) {
      $("dashboardAuthLogoutBtn").disabled = !enabled || !authenticated;
    }

    setResultMessage("dashboardAuthStatus", statusMessage, statusTone);

    const gate = $("dashboardAuthGate");
    if (gate) {
      gate.hidden = !locked;
    }
    if (locked) {
      setResultMessage("dashboardAuthGateStatus", t("dashboard_auth_status_session_required"), "warn");
      window.requestAnimationFrame(() => {
        $("dashboardAuthLoginPassword")?.focus();
      });
    }
  }

  async function refreshStatus(options = {}) {
    const data = await api("/dashboard-auth/status");
    state = {
      enabled: data?.enabled === true,
      configured: data?.configured === true,
      authenticated: data?.authenticated === true
    };
    render();
    if (options.loadProtectedData === true && !isLocked()) {
      await loadProtectedData();
    }
    return getState();
  }

  async function saveSettings() {
    const enabled = $("dashboardAuthEnabled").checked;
    const password = String($("dashboardAuthPassword").value || "");
    if (
      (enabled && !state.configured && password.length < minimumPasswordLength) ||
      (password.length > 0 && password.length < minimumPasswordLength)
    ) {
      setResultMessage("dashboardAuthStatus", t("dashboard_auth_status_password_required"), "bad");
      return false;
    }

    try {
      const payload = { enabled };
      if (password.length > 0) {
        payload.password = password;
      }
      await api("/dashboard-auth/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      $("dashboardAuthPassword").value = "";
      await refreshStatus({ loadProtectedData: enabled });
      setResultMessage("dashboardAuthStatus", t("dashboard_auth_status_saved"), "ok");
      return true;
    } catch (err) {
      setResultMessage("dashboardAuthStatus", tt("dashboard_auth_status_save_failed", { message: err.message }), "bad");
      return false;
    }
  }

  async function submitLogin() {
    const password = String($("dashboardAuthLoginPassword").value || "");
    setResultMessage("dashboardAuthGateStatus", t("dashboard_auth_status_unlocking"));
    try {
      await api("/dashboard-auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password })
      });
      $("dashboardAuthLoginPassword").value = "";
      await refreshStatus({ loadProtectedData: true });
      return true;
    } catch (err) {
      const lowered = String(err?.message || "").trim().toLowerCase();
      const message = lowered.includes("incorrect dashboard password")
        ? t("dashboard_auth_status_incorrect")
        : tt("dashboard_auth_status_unlock_failed", { message: err.message });
      setResultMessage("dashboardAuthGateStatus", message, "bad");
      return false;
    }
  }

  async function lockSession() {
    try {
      await api("/dashboard-auth/logout", { method: "POST" });
      state = { ...state, authenticated: false };
      render();
      setResultMessage("dashboardAuthStatus", t("dashboard_auth_status_locked"));
      return true;
    } catch (err) {
      setResultMessage("dashboardAuthStatus", tt("dashboard_auth_status_unlock_failed", { message: err.message }), "bad");
      return false;
    }
  }

  function markUnauthenticated() {
    state = { ...state, authenticated: false };
    render();
  }

  function getState() {
    return { ...state };
  }

  return {
    getState,
    isLocked,
    render,
    refreshStatus,
    saveSettings,
    submitLogin,
    lockSession,
    markUnauthenticated
  };
}
