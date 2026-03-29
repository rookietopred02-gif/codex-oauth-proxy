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
  let dialogOpen = false;
  let dialogMode = "set-password";
  let pendingDesiredEnabled = null;

  function isLocked() {
    return state.enabled === true && state.authenticated !== true;
  }

  function getDesiredEnabled() {
    if (typeof pendingDesiredEnabled === "boolean") return pendingDesiredEnabled;
    return state.enabled === true;
  }

  function getModalPasswordInput() {
    return $("dashboardAuthModalPassword");
  }

  function modeRequiresPassword(mode) {
    return mode === "set-password" || mode === "update-password" || mode === "unlock-session";
  }

  function resolveDialogMode() {
    const desiredEnabled = getDesiredEnabled();
    if (state.enabled) {
      if (desiredEnabled === false) return "disable-protection";
      return state.authenticated ? "lock-session" : "unlock-session";
    }
    if (desiredEnabled === true) {
      return state.configured ? "enable-protection" : "set-password";
    }
    return state.configured ? "update-password" : "set-password";
  }

  function getActionLabelKey(mode) {
    switch (mode) {
      case "unlock-session":
        return "dashboard_auth_action_unlock";
      case "lock-session":
        return "dashboard_auth_action_lock";
      case "enable-protection":
        return "dashboard_auth_action_enable";
      case "disable-protection":
        return "dashboard_auth_action_disable";
      case "update-password":
        return "dashboard_auth_action_update";
      case "set-password":
      default:
        return "dashboard_auth_action_set";
    }
  }

  function getDialogText(mode) {
    switch (mode) {
      case "unlock-session":
        return {
          title: t("dashboard_auth_modal_unlock_title"),
          subtitle: t("dashboard_auth_modal_unlock_subtitle")
        };
      case "lock-session":
        return {
          title: t("dashboard_auth_modal_lock_title"),
          subtitle: t("dashboard_auth_modal_lock_subtitle")
        };
      case "enable-protection":
        return {
          title: t("dashboard_auth_modal_enable_title"),
          subtitle: t("dashboard_auth_modal_enable_subtitle")
        };
      case "disable-protection":
        return {
          title: t("dashboard_auth_modal_disable_title"),
          subtitle: t("dashboard_auth_modal_disable_subtitle")
        };
      case "update-password":
        return {
          title: t("dashboard_auth_modal_update_title"),
          subtitle: t("dashboard_auth_modal_update_subtitle")
        };
      case "set-password":
      default:
        return {
          title: t("dashboard_auth_modal_set_title"),
          subtitle: getDesiredEnabled()
            ? t("dashboard_auth_modal_set_enable_subtitle")
            : t("dashboard_auth_modal_set_subtitle")
        };
    }
  }

  function setModalOpen(open) {
    const backdrop = $("dashboardAuthModalBackdrop");
    if (!backdrop) return;
    backdrop.hidden = !open;
    document.body.style.overflow = open ? "hidden" : "";
  }

  function renderDialog() {
    const titleEl = $("dashboardAuthModalTitle");
    const subtitleEl = $("dashboardAuthModalSubtitle");
    const passwordField = $("dashboardAuthModalPasswordField");
    const submitBtn = $("dashboardAuthModalSubmitBtn");
    const modalStatus = $("dashboardAuthModalStatus");
    const passwordInput = getModalPasswordInput();
    const text = getDialogText(dialogMode);

    if (titleEl) titleEl.textContent = text.title;
    if (subtitleEl) subtitleEl.textContent = text.subtitle;
    if (submitBtn instanceof HTMLButtonElement) {
      submitBtn.textContent = t(getActionLabelKey(dialogMode));
    }
    if (passwordField instanceof HTMLElement) {
      passwordField.hidden = !modeRequiresPassword(dialogMode);
    }
    if (passwordInput instanceof HTMLInputElement) {
      passwordInput.value = "";
      passwordInput.placeholder =
        dialogMode === "unlock-session"
          ? t("dashboard_auth_modal_password_placeholder_current")
          : t("dashboard_auth_modal_password_placeholder_new");
      passwordInput.autocomplete = dialogMode === "unlock-session" ? "current-password" : "new-password";
    }
    if (modalStatus instanceof HTMLElement) {
      modalStatus.className = "result";
      modalStatus.textContent = "-";
    }
  }

  function render() {
    const enabled = state.enabled === true;
    const configured = state.configured === true;
    const authenticated = state.authenticated === true;
    const locked = isLocked();
    const desiredEnabled = getDesiredEnabled();
    const statusMessage = enabled
      ? authenticated
        ? t("dashboard_auth_status_enabled_active")
        : t("dashboard_auth_status_enabled_locked")
      : configured
        ? t("dashboard_auth_status_disabled_set")
        : t("dashboard_auth_status_disabled_unset");
    const statusTone = enabled ? (authenticated ? "ok" : "warn") : configured ? "" : "warn";
    const actionLabel = t(getActionLabelKey(resolveDialogMode()));

    if ($("dashboardAuthEnabled")) {
      $("dashboardAuthEnabled").checked = desiredEnabled;
    }
    if ($("dashboardAuthActionBtn")) {
      $("dashboardAuthActionBtn").textContent = actionLabel;
    }
    if ($("dashboardAuthGateActionBtn")) {
      $("dashboardAuthGateActionBtn").textContent = actionLabel;
    }

    setResultMessage("dashboardAuthStatus", statusMessage, statusTone);

    const gate = $("dashboardAuthGate");
    if (gate) gate.hidden = !locked;
    if (locked) {
      setResultMessage("dashboardAuthGateStatus", t("dashboard_auth_status_session_required"), "warn");
    }
    if (dialogOpen) {
      renderDialog();
    }
  }

  async function refreshStatus(options = {}) {
    const data = await api("/dashboard-auth/status");
    state = {
      enabled: data?.enabled === true,
      configured: data?.configured === true,
      authenticated: data?.authenticated === true
    };
    pendingDesiredEnabled = null;
    render();
    if (options.loadProtectedData === true && !isLocked()) {
      await loadProtectedData();
    }
    return getState();
  }

  function openDialog(mode = resolveDialogMode()) {
    dialogMode = mode;
    dialogOpen = true;
    setModalOpen(true);
    renderDialog();
    window.requestAnimationFrame(() => {
      const passwordInput = getModalPasswordInput();
      if (modeRequiresPassword(dialogMode) && passwordInput instanceof HTMLInputElement) {
        passwordInput.focus();
        passwordInput.select();
        return;
      }
      $("dashboardAuthModalSubmitBtn")?.focus();
    });
  }

  function closeDialog(options = {}) {
    if (options.restoreDesiredEnabled === true) {
      pendingDesiredEnabled = null;
    }
    dialogOpen = false;
    setModalOpen(false);
    render();
  }

  /**
   * @param {Record<string, unknown>} payload
   * @param {{ successMessageKey?: string }} [options]
   */
  async function configureDashboard(payload, options = {}) {
    const { successMessageKey } = options;
    await api("/dashboard-auth/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    pendingDesiredEnabled = null;
    await refreshStatus({ loadProtectedData: payload?.enabled === true });
    if (successMessageKey) {
      setResultMessage("dashboardAuthStatus", t(successMessageKey), "ok");
    }
    return true;
  }

  async function submitLogin(password) {
    await api("/dashboard-auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password })
    });
    pendingDesiredEnabled = null;
    await refreshStatus({ loadProtectedData: true });
    return true;
  }

  async function lockSession() {
    await api("/dashboard-auth/logout", { method: "POST" });
    state = { ...state, authenticated: false };
    pendingDesiredEnabled = null;
    render();
    setResultMessage("dashboardAuthStatus", t("dashboard_auth_status_locked"), "ok");
    return true;
  }

  async function submitDialog() {
    const passwordInput = getModalPasswordInput();
    const password = String(passwordInput?.value || "");
    const modalStatusToneId = "dashboardAuthModalStatus";
    const desiredEnabled = getDesiredEnabled();

    if (modeRequiresPassword(dialogMode)) {
      const needsMinimumLength = dialogMode !== "unlock-session";
      if (needsMinimumLength && password.length < minimumPasswordLength) {
        setResultMessage(modalStatusToneId, t("dashboard_auth_status_password_required"), "bad");
        return false;
      }
      if (!needsMinimumLength && !password) {
        setResultMessage(modalStatusToneId, t("dashboard_auth_status_password_missing"), "bad");
        return false;
      }
    }

    try {
      if (dialogMode === "unlock-session") {
        setResultMessage(modalStatusToneId, t("dashboard_auth_status_unlocking"));
        await submitLogin(password);
      } else if (dialogMode === "lock-session") {
        await lockSession();
      } else if (dialogMode === "enable-protection") {
        await configureDashboard({ enabled: true }, { successMessageKey: "dashboard_auth_status_saved" });
      } else if (dialogMode === "disable-protection") {
        await configureDashboard({ enabled: false }, { successMessageKey: "dashboard_auth_status_saved" });
      } else if (dialogMode === "update-password") {
        await configureDashboard({ password }, { successMessageKey: "dashboard_auth_status_saved" });
      } else {
        await configureDashboard(
          {
            enabled: desiredEnabled,
            password
          },
          { successMessageKey: "dashboard_auth_status_saved" }
        );
      }
      closeDialog();
      return true;
    } catch (err) {
      const lowered = String(err?.message || "").trim().toLowerCase();
      const message =
        dialogMode === "unlock-session"
          ? lowered.includes("incorrect dashboard password")
            ? t("dashboard_auth_status_incorrect")
            : tt("dashboard_auth_status_unlock_failed", { message: err.message })
          : tt("dashboard_auth_status_save_failed", { message: err.message });
      setResultMessage(modalStatusToneId, message, "bad");
      return false;
    }
  }

  async function handleEnabledToggle(nextEnabled) {
    const desired = nextEnabled === true;
    pendingDesiredEnabled = desired;
    render();

    try {
      if (desired === state.enabled) {
        if (desired && !state.configured) {
          openDialog("set-password");
        }
        return false;
      }
      if (desired) {
        if (!state.configured) {
          openDialog("set-password");
          return false;
        }
        await configureDashboard({ enabled: true }, { successMessageKey: "dashboard_auth_status_saved" });
        return true;
      }
      await configureDashboard({ enabled: false }, { successMessageKey: "dashboard_auth_status_saved" });
      return true;
    } catch (err) {
      pendingDesiredEnabled = null;
      render();
      setResultMessage("dashboardAuthStatus", tt("dashboard_auth_status_save_failed", { message: err.message }), "bad");
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
    openDialog,
    closeDialog,
    submitDialog,
    handleEnabledToggle,
    lockSession,
    markUnauthenticated
  };
}
