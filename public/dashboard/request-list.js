// @ts-check

export function createRequestListUi(deps) {
  const {
    $,
    t,
    escapeHtml,
    fmtToken,
    formatDateTime,
    readStoredBool,
    writeStoredString,
    recordingStorageKey
  } = deps;

  let recordingEnabled = readStoredBool(recordingStorageKey) !== false;

  function getTransportLabel(row) {
    const method = safeString(row?.method, "").trim().toUpperCase();
    const transport = safeString(row?.transportType, "").trim().toLowerCase();
    if (transport === "websocket" || method === "WS") return "WebSocket";
    if (transport === "http") return method ? `HTTP ${method}` : "HTTP";
    return method || "-";
  }

  function toPositiveInteger(value) {
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      const parsed = Number(value.trim());
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
  }

  function toNonNegativeInteger(value) {
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      const parsed = Number(value.trim());
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
  }

  function toStatusCode(value) {
    if (typeof value === "number") {
      return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
    }
    if (typeof value === "string" && /^[1-5]\d{2}$/.test(value)) {
      return Number(value);
    }
    return null;
  }

  function formatStatus(value) {
    const statusCode = toStatusCode(value);
    return statusCode === null ? "-" : String(statusCode);
  }

  function formatDurationMs(value) {
    const duration = toNonNegativeInteger(value);
    return duration === null ? "-" : `${duration} ms`;
  }

  function formatRequestTimeFallback(value) {
    const timestamp = toPositiveInteger(value);
    if (timestamp === null) return "-";
    try {
      const date = new Date(timestamp);
      return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : "-";
    } catch {
      return "-";
    }
  }

  function formatRequestTime(value) {
    if (typeof formatDateTime === "function") {
      try {
        const formatted = formatDateTime(value, { dateStyle: undefined, timeStyle: "medium" });
        return typeof formatted === "string" && formatted ? formatted : "-";
      } catch {}
    }
    return formatRequestTimeFallback(value);
  }

  function safeString(value, fallback = "") {
    try {
      return String(value ?? fallback);
    } catch {
      return fallback;
    }
  }

  function getRequestId(row, index) {
    const explicitId = safeString(row?.id).trim();
    if (explicitId) return explicitId;
    const timestamp = toPositiveInteger(row?.ts);
    return timestamp === null ? `request-${index}` : `${timestamp}-${index}`;
  }

  function renderRecordingToggle() {
    const button = $("ignoreReqBtn");
    const label = $("ignoreReqBtnLabel");
    if (!(button instanceof HTMLButtonElement) || !(label instanceof HTMLElement)) return;
    recordingEnabled = readStoredBool(recordingStorageKey) !== false;
    button.classList.toggle("is-recording", recordingEnabled);
    button.classList.toggle("is-ignoring", !recordingEnabled);
    button.setAttribute("aria-pressed", recordingEnabled ? "false" : "true");
    label.textContent = recordingEnabled ? t("recent_requests_record") : t("recent_requests_ignore");
  }

  function toggleRecording() {
    recordingEnabled = !recordingEnabled;
    writeStoredString(recordingStorageKey, recordingEnabled ? "1" : "0");
    renderRecordingToggle();
    return recordingEnabled;
  }

  function renderRows(rows) {
    const requestDetailMap = new Map();
    const visibleIds = new Set();
    $("reqTable").innerHTML = rows
      .map((row, index) => {
        const requestId = getRequestId(row, index);
        visibleIds.add(requestId);
        requestDetailMap.set(requestId, row);
        const requestTime = formatRequestTime(row?.ts);
        const statusCode = toStatusCode(row.status);
        const statusClass = statusCode !== null && statusCode >= 400 ? "req-status-bad" : "req-status-ok";
        const requestedModel = safeString(row?.requestedModel, "").trim();
        const mappedModel = safeString(row?.mappedModel, "").trim();
        const routeText = requestedModel && mappedModel ? `${escapeHtml(requestedModel)} → ${escapeHtml(mappedModel)}` : "";
        return `<tr class="req-row" tabindex="0" data-req-id="${escapeHtml(requestId)}">
          <td>${escapeHtml(requestTime)}</td>
          <td>${escapeHtml(getTransportLabel(row))}</td>
          <td class="mono">${escapeHtml(safeString(row?.path, ""))}${routeText ? `<br><span class="req-route">${routeText}</span>` : ""}</td>
          <td>${escapeHtml(fmtToken(row.inputTokens))}</td>
          <td>${escapeHtml(fmtToken(row.cachedInputTokens))}</td>
          <td>${escapeHtml(fmtToken(row.outputTokens))}</td>
          <td>${escapeHtml(fmtToken(row.totalTokens))}</td>
          <td class="${statusClass}">${escapeHtml(formatStatus(row.status))}</td>
          <td>${escapeHtml(formatDurationMs(row.durationMs))}</td>
        </tr>`;
      })
      .join("");

    return {
      requestDetailMap,
      visibleIds
    };
  }

  return {
    renderRows,
    renderRecordingToggle,
    toggleRecording,
    isRecordingEnabled() {
      return recordingEnabled;
    }
  };
}
