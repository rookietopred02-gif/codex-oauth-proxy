// @ts-check

export function createRequestListUi(deps) {
  const {
    $,
    t,
    escapeHtml,
    fmtToken,
    readStoredBool,
    writeStoredString,
    recordingStorageKey
  } = deps;

  let recordingEnabled = readStoredBool(recordingStorageKey) !== false;

  function getTransportLabel(row) {
    const method = String(row?.method || "").trim().toUpperCase();
    const transport = String(row?.transportType || "").trim().toLowerCase();
    if (transport === "websocket" || method === "WS") return "WebSocket";
    if (transport === "http") return method ? `HTTP ${method}` : "HTTP";
    return method || "-";
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
        const requestId = String(row?.id || `${row?.ts || Date.now()}-${index}`);
        visibleIds.add(requestId);
        requestDetailMap.set(requestId, row);
        const requestTime = new Date(row.ts).toLocaleTimeString();
        const statusClass = row.status >= 400 ? "req-status-bad" : "req-status-ok";
        const routeText =
          row.requestedModel && row.mappedModel
            ? `${escapeHtml(row.requestedModel)} → ${escapeHtml(row.mappedModel)}`
            : "";
        return `<tr class="req-row" tabindex="0" data-req-id="${escapeHtml(requestId)}">
          <td>${requestTime}</td>
          <td>${escapeHtml(getTransportLabel(row))}</td>
          <td class="mono">${escapeHtml(row.path)}${routeText ? `<br><span class="req-route">${routeText}</span>` : ""}</td>
          <td>${fmtToken(row.inputTokens)}</td>
          <td>${fmtToken(row.cachedInputTokens)}</td>
          <td>${fmtToken(row.outputTokens)}</td>
          <td>${fmtToken(row.totalTokens)}</td>
          <td class="${statusClass}">${row.status}</td>
          <td>${row.durationMs} ms</td>
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
