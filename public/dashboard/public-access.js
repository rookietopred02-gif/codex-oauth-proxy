// @ts-check

export function createPublicAccessFeature(deps) {
  const { $, api, t, tt, syncCustomSelect, copyTextToClipboard } = deps;
  let lastStatus = null;
  let activeRuntimePort = 8787;
  let configuredRuntimePort = 8787;

  function getStatusSnapshot() {
    return lastStatus && typeof lastStatus === "object" ? { ...lastStatus } : null;
  }

  function renderLocalBinding() {
    const bindingEl = $("publicAccessLocalBinding");
    if (!bindingEl) return;
    const active = Number(activeRuntimePort || 8787);
    const configured = Number(configuredRuntimePort || active);
    bindingEl.textContent =
      configured !== active
        ? tt("public_access_binding_pending", { active, configured })
        : tt("public_access_binding", { port: active });
  }

  function updateTokenUi() {
    const mode = String($("publicAccessMode")?.value || "quick").trim().toLowerCase();
    const tokenInput = $("publicAccessToken");
    if (!tokenInput) return;
    const authMode = mode === "auth";
    tokenInput.disabled = false;
    tokenInput.placeholder = authMode ? "Required in auth mode" : "Optional in quick mode";
  }

  function render(status) {
    lastStatus = status && typeof status === "object" ? { ...status } : null;
    const statusEl = $("publicAccessStatus");
    const urlEl = $("publicAccessUrl");
    const installBtn = $("publicAccessInstallBtn");
    const startBtn = $("publicAccessStartBtn");
    const stopBtn = $("publicAccessStopBtn");
    if (!statusEl || !urlEl) return;
    renderLocalBinding();
    if (!status || typeof status !== "object") {
      statusEl.textContent = "-";
      urlEl.textContent = "-";
      if (installBtn) installBtn.disabled = false;
      if (startBtn) startBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = false;
      return;
    }
    const installed = status.installed === true;
    const running = status.running === true;
    const installing = status.installInProgress === true;
    const statusLabel = installing
      ? t("public_access_status_installing")
      : installed
        ? running
          ? t("public_access_status_running")
          : t("public_access_status_stopped")
        : t("public_access_status_not_installed");
    const mode = String(status.mode || "quick");
    const localPort = Number(status.localPort || 0) || Number(activeRuntimePort || 8787);
    const useHttp2 = status.useHttp2 === true ? "on" : "off";
    const version = String(status.version || "-");
    const pid = Number(status.pid || 0) > 0 ? String(status.pid) : "-";
    const url = String(status.url || "").trim();
    const err = String(status.error || "").trim();
    const segments = [
      tt("public_access_status_line", { status: statusLabel, mode, port: localPort, http2: useHttp2 }),
      tt("public_access_status_line_2", {
        installed: installed ? "yes" : "no",
        version,
        pid
      })
    ];
    if (url) segments.push(tt("public_access_status_url", { url }));
    if (err) segments.push(tt("public_access_status_error", { error: err }));
    if (String(status.installMessage || "").trim()) {
      segments.push(String(status.installMessage || "").trim());
    }
    statusEl.textContent = segments.join("\n");
    urlEl.textContent = url || "-";
    if (installBtn) installBtn.disabled = installing;
    if (startBtn) startBtn.disabled = installing;
    if (stopBtn) stopBtn.disabled = installing || !running;
  }

  function applyConfigFromState(state) {
    const cfg = state?.config?.publicAccess || {};
    const status = state?.publicAccess || {};
    activeRuntimePort = Number(state?.config?.activeRuntimePort || 0) || 8787;
    configuredRuntimePort = Number(state?.config?.runtimePort || activeRuntimePort || 8787);
    const mode = String(status.mode || cfg.mode || "quick").trim().toLowerCase();
    const useHttp2 = status.useHttp2 !== false && cfg.useHttp2 !== false;
    $("publicAccessMode").value = mode === "auth" ? "auth" : "quick";
    $("publicAccessHttp2").checked = useHttp2;
    syncCustomSelect($("publicAccessMode"));
    updateTokenUi();
    renderLocalBinding();
    render(status);
  }

  async function fetchStatus() {
    const data = await api("/admin/public-access/status");
    const status = data?.status || null;
    render(status);
    return status;
  }

  async function waitForReady(initialStatus, { timeoutMs = 15000, intervalMs = 700 } = {}) {
    let status = initialStatus || null;
    const hasUrl = (value) => String(value?.url || "").trim().length > 0;
    if (hasUrl(status)) return status;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      status = await fetchStatus();
      if (hasUrl(status)) return status;

      const running = status?.running === true;
      const installing = status?.installInProgress === true;
      const err = String(status?.error || "").trim();
      if ((!running && !installing) || (err && !installing)) {
        return status;
      }
    }
    return status;
  }

  async function start() {
    const mode = String($("publicAccessMode").value || "quick").trim().toLowerCase();
    const payload = {
      mode,
      useHttp2: $("publicAccessHttp2").checked
    };
    const token = String($("publicAccessToken").value || "").trim();
    if (mode === "auth") {
      payload.token = token;
    }
    const data = await api("/admin/public-access/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const initialStatus = data?.status || null;
    render(initialStatus);
    return await waitForReady(initialStatus);
  }

  async function stop() {
    const data = await api("/admin/public-access/stop", {
      method: "POST"
    });
    render(data?.status || null);
    return data?.status || null;
  }

  async function install() {
    const previousStatus = getStatusSnapshot() || {};
    render({
      ...previousStatus,
      installInProgress: true,
      installMessage: t("public_access_status_installing"),
      error: ""
    });
    try {
      const data = await api("/admin/public-access/install", { method: "POST" });
      render(data?.status || null);
      return data?.status || null;
    } catch (err) {
      render(
        err?.data?.status || {
          ...previousStatus,
          installInProgress: false,
          error: err.message,
          installMessage: err.message
        }
      );
      throw err;
    }
  }

  async function copyCurrentUrl() {
    const url = String($("publicAccessUrl")?.textContent || "").trim();
    if (!url || url === "-") return false;
    await copyTextToClipboard(url);
    return true;
  }

  return {
    applyConfigFromState,
    copyCurrentUrl,
    fetchStatus,
    getStatusSnapshot,
    install,
    render,
    start,
    stop,
    updateTokenUi,
    waitForReady
  };
}
