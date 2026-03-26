// @ts-check

export function createTempMailFeature(deps) {
  const {
    $,
    api,
    t,
    tt,
    escapeHtml,
    refreshState,
    readStoredBool,
    readStoredNumber,
    readStoredString,
    writeStoredString,
    countStorageKey,
    passwordStorageKey,
    delayStorageKey,
    allowParallelStorageKey,
    workersStorageKey,
    activeRefreshMs = 2000
  } = deps;

  let lastState = null;
  let actionInFlight = false;
  let refreshTimerId = 0;

  function readNumberInputValue(id, fallback, min, max) {
    const node = $(id);
    const raw = String(node?.value ?? "").trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  }

  function syncWorkersDisabled() {
    const input = $("tempMailWorkers");
    if (!(input instanceof HTMLInputElement)) return;
    input.disabled = !$("tempMailAllowParallel").checked;
  }

  function loadFormFromStorage() {
    $("tempMailCount").value = String(readStoredNumber(countStorageKey, 1, 1, 100));
    $("tempMailPassword").value = readStoredString(passwordStorageKey) || "";
    $("tempMailDelay").value = String(readStoredNumber(delayStorageKey, 15, 0, 300));
    $("tempMailWorkers").value = String(readStoredNumber(workersStorageKey, 1, 1, 50));
    $("tempMailAllowParallel").checked = readStoredBool(allowParallelStorageKey) === true;
    syncWorkersDisabled();
  }

  function saveFormToStorage() {
    writeStoredString(countStorageKey, String(readNumberInputValue("tempMailCount", 1, 1, 100)));
    writeStoredString(passwordStorageKey, String($("tempMailPassword").value || ""));
    writeStoredString(delayStorageKey, String(readNumberInputValue("tempMailDelay", 15, 0, 300)));
    writeStoredString(workersStorageKey, String(readNumberInputValue("tempMailWorkers", 1, 1, 50)));
    writeStoredString(allowParallelStorageKey, $("tempMailAllowParallel").checked ? "1" : "0");
  }

  function buildPayload() {
    return {
      count: readNumberInputValue("tempMailCount", 1, 1, 100),
      password: String($("tempMailPassword").value || "").trim(),
      workers: readNumberInputValue("tempMailWorkers", 1, 1, 50),
      nextDelaySeconds: readNumberInputValue("tempMailDelay", 15, 0, 300),
      allowParallel: $("tempMailAllowParallel").checked
    };
  }

  function renderConsole(logs) {
    const el = $("tempMailConsole");
    if (!(el instanceof HTMLElement)) return;
    const entries = Array.isArray(logs) ? logs : [];
    const stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (entries.length === 0) {
      el.innerHTML = `<div class="temp-mail-console-line">${escapeHtml(t("temp_mail_console_empty"))}</div>`;
      return;
    }
    el.innerHTML = entries
      .map((entry) => {
        const level = String(entry?.level || "info").toLowerCase();
        const cls = level === "success" ? " is-success" : level === "warning" ? " is-warning" : level === "error" ? " is-error" : "";
        return `<div class="temp-mail-console-line${cls}">${escapeHtml(String(entry?.text || ""))}</div>`;
      })
      .join("");
    if (stickToBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }

  function isPasswordRequiredError(err) {
    const message = String(err?.message || err || "").trim().toLowerCase();
    return message === "temp mail password is required.";
  }

  function showInlineWarning(message) {
    const summaryEl = $("tempMailSummary");
    if (!(summaryEl instanceof HTMLElement)) return;
    summaryEl.className = "result temp-mail-summary warn";
    summaryEl.textContent = message;
    renderConsole([{ level: "warning", text: message }]);
  }

  function syncRefreshLoop() {
    const isActive = Boolean(lastState && (lastState.running || lastState.stopping));
    if (!isActive) {
      if (refreshTimerId) {
        clearInterval(refreshTimerId);
        refreshTimerId = 0;
      }
      return;
    }
    if (refreshTimerId) return;
    refreshTimerId = setInterval(() => {
      if (!(lastState && (lastState.running || lastState.stopping))) {
        clearInterval(refreshTimerId);
        refreshTimerId = 0;
        return;
      }
      refreshState(false).catch(() => {});
    }, activeRefreshMs);
  }

  function render(tempMail) {
    lastState = tempMail || null;
    const summaryEl = $("tempMailSummary");
    const toggleBtn = $("tempMailToggleBtn");
    if (!(summaryEl instanceof HTMLElement) || !(toggleBtn instanceof HTMLButtonElement)) return;

    if (!tempMail) {
      summaryEl.className = "result temp-mail-summary";
      summaryEl.textContent = t("temp_mail_idle");
      toggleBtn.textContent = t("temp_mail_toggle_run");
      toggleBtn.disabled = actionInFlight;
      syncWorkersDisabled();
      renderConsole([]);
      syncRefreshLoop();
      return;
    }

    const state = tempMail || {};
    const logs = Array.isArray(state.logs) ? state.logs : [];
    const progress = state.progress || {};
    const running = state.running === true;
    const stopping = state.stopping === true;
    const runnerReady = state.runnerReady === true;
    const supported = state.supported !== false;
    const config = state.config || {};
    const effectiveThreads = Number(config.effectiveWorkers || 1) || 1;

    if (!supported) {
      summaryEl.className = "result temp-mail-summary bad";
      summaryEl.textContent = tt("temp_mail_runner_missing", { message: state.runnerError || "unsupported mode" });
    } else if (!runnerReady) {
      summaryEl.className = "result temp-mail-summary bad";
      summaryEl.textContent = tt("temp_mail_runner_missing", { message: state.runnerError || "go toolchain not found" });
    } else if (stopping) {
      summaryEl.className = "result temp-mail-summary";
      summaryEl.textContent = t("temp_mail_stopping");
    } else if (running) {
      summaryEl.className = "result temp-mail-summary";
      summaryEl.textContent = tt("temp_mail_running", {
        success: progress.success ?? 0,
        total: progress.total ?? 0,
        fail: progress.fail ?? 0,
        threads: effectiveThreads
      });
    } else if (state.lastResult?.summary) {
      summaryEl.className = "result temp-mail-summary ok";
      summaryEl.textContent = tt("temp_mail_done", {
        success: state.lastResult.summary.success ?? 0,
        total: state.lastResult.summary.total ?? 0,
        fail: state.lastResult.summary.fail ?? 0
      });
    } else if (state.lastError) {
      summaryEl.className = "result temp-mail-summary bad";
      summaryEl.textContent = state.lastError;
    } else {
      summaryEl.className = "result temp-mail-summary";
      summaryEl.textContent = t("temp_mail_idle");
    }

    toggleBtn.textContent = running || stopping ? t("temp_mail_toggle_stop") : t("temp_mail_toggle_run");
    toggleBtn.disabled = actionInFlight || !supported || !runnerReady || stopping;
    for (const id of ["tempMailCount", "tempMailPassword", "tempMailDelay", "tempMailAllowParallel", "tempMailWorkers"]) {
      const node = $(id);
      if (node) node.disabled = running || stopping;
    }
    if (!running && !stopping) {
      syncWorkersDisabled();
    }
    renderConsole(logs);
    syncRefreshLoop();
  }

  async function toggleRun() {
    if (actionInFlight) return;
    if (!(lastState?.running || lastState?.stopping)) {
      const payload = buildPayload();
      saveFormToStorage();
      if (!payload.password) {
        showInlineWarning(t("temp_mail_password_missing_warning"));
        return;
      }
    }

    actionInFlight = true;
    render(lastState);
    try {
      if (lastState?.running || lastState?.stopping) {
        await api("/admin/temp-mail/stop", { method: "POST" });
      } else {
        const payload = buildPayload();
        saveFormToStorage();
        await api("/admin/temp-mail/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
      }
      await refreshState(true);
    } catch (err) {
      if (isPasswordRequiredError(err)) {
        showInlineWarning(t("temp_mail_password_missing_warning"));
        return;
      }
      const summaryEl = $("tempMailSummary");
      if (summaryEl instanceof HTMLElement) {
        summaryEl.className = "result temp-mail-summary bad";
        summaryEl.textContent =
          lastState?.running || lastState?.stopping
            ? tt("temp_mail_stop_failed", { message: err.message })
            : tt("temp_mail_start_failed", { message: err.message });
      }
    } finally {
      actionInFlight = false;
      render(lastState);
    }
  }

  function summarizeHead() {
    if (!lastState) return { text: t("hero_temp_idle"), tone: "neutral" };
    if (lastState.stopping) return { text: t("hero_temp_stopping"), tone: "warn" };
    if (lastState.running) {
      return {
        text: tt("hero_temp_running", {
          success: lastState.progress?.success ?? 0,
          total: lastState.progress?.total ?? 0
        }),
        tone: "accent"
      };
    }
    if (lastState.lastError) return { text: t("hero_temp_error"), tone: "bad" };
    if (lastState.lastResult?.summary) {
      return {
        text: tt("hero_temp_done", {
          success: lastState.lastResult.summary.success ?? 0,
          total: lastState.lastResult.summary.total ?? 0
        }),
        tone: "ok"
      };
    }
    return { text: t("hero_temp_idle"), tone: "neutral" };
  }

  return {
    getState: () => (lastState && typeof lastState === "object" ? { ...lastState } : null),
    loadFormFromStorage,
    render,
    saveFormToStorage,
    summarizeHead,
    syncWorkersDisabled,
    toggleRun
  };
}
