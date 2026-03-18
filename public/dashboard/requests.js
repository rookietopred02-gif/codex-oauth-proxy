export function createRecentRequestsUi(deps) {
  const {
    $,
    t,
    tt,
    escapeHtml,
    fmtToken,
    copyTextToClipboard,
    showCopyError,
    readStoredBool,
    writeStoredString,
    panelStorageKey,
    resolveProtocolLabel,
    resolveModelDisplay,
    resolveAccountDisplay,
    resolveCompatibilityHint
  } = deps;

  const requestDetailCopyResetTimers = new Map();
  let requestDetailMap = new Map();
  let activeRequestDetailId = "";

  function safeCodeText(value) {
    const text = String(value || "");
    return text.length > 0 ? text : t("request_detail_empty");
  }

  function resetRequestDetailCopyButton(buttonId) {
    const button = $(buttonId);
    if (!(button instanceof HTMLButtonElement)) return;
    button.textContent = t("request_detail_copy");
    button.classList.remove("is-copied");
    const timerId = requestDetailCopyResetTimers.get(buttonId);
    if (timerId) {
      clearTimeout(timerId);
      requestDetailCopyResetTimers.delete(buttonId);
    }
  }

  function markRequestDetailCopySuccess(buttonId) {
    const button = $(buttonId);
    if (!(button instanceof HTMLButtonElement)) return;
    resetRequestDetailCopyButton(buttonId);
    button.textContent = t("request_detail_copied");
    button.classList.add("is-copied");
    const timerId = setTimeout(() => resetRequestDetailCopyButton(buttonId), 1400);
    requestDetailCopyResetTimers.set(buttonId, timerId);
  }

  async function copyRequestDetailLog(codeId, buttonId) {
    const codeBlock = $(codeId);
    if (!(codeBlock instanceof HTMLElement)) return;
    const text = String(codeBlock.textContent || "");
    if (!text || text === t("request_detail_empty")) return;
    try {
      await copyTextToClipboard(text);
      markRequestDetailCopySuccess(buttonId);
    } catch (err) {
      showCopyError(err);
    }
  }

  function buildReqDetailMetaItems(row) {
    const timeText = row?.ts ? new Date(Number(row.ts)).toLocaleString() : "-";
    const latencyText = Number.isFinite(Number(row?.durationMs)) ? `${Number(row.durationMs)} ms` : "-";
    const tokenText = tt("token_usage_format", {
      input: fmtToken(row?.inputTokens),
      output: fmtToken(row?.outputTokens)
    });
    const totalText = fmtToken(row?.totalTokens);
    const protocolText = resolveProtocolLabel(row);
    const modelText = resolveModelDisplay(row);
    const accountText = resolveAccountDisplay(row);
    const pathText = `${String(row?.method || "-")} ${String(row?.path || "-")}`;
    const statusText = String(row?.status ?? "-");
    const retryCount = Math.max(0, Number(row?.upstreamRetryCount || 0));
    const transportErrorCode = String(row?.upstreamErrorCode || "").trim();
    const transportErrorDetail = String(row?.upstreamErrorDetail || "").trim();
    const compatibilityText = resolveCompatibilityHint(row?.compatibilityHint);

    const items = [
      { key: t("req_meta_request_time"), value: timeText },
      { key: t("req_meta_latency"), value: latencyText },
      { key: t("req_meta_token_usage"), value: tokenText },
      { key: t("req_meta_total_tokens"), value: totalText },
      { key: t("req_meta_protocol"), value: protocolText },
      { key: t("req_meta_model"), value: modelText },
      { key: t("req_meta_account"), value: accountText },
      { key: t("req_meta_path"), value: pathText },
      { key: t("req_meta_status"), value: statusText }
    ];
    if (retryCount > 0) {
      items.push({ key: t("req_meta_upstream_retries"), value: String(retryCount) });
    }
    if (transportErrorCode) {
      items.push({ key: t("req_meta_transport_error_code"), value: transportErrorCode });
    }
    if (transportErrorDetail) {
      items.push({ key: t("req_meta_transport_error_detail"), value: transportErrorDetail });
    }
    if (compatibilityText !== "-") {
      items.push({ key: t("req_meta_compatibility"), value: compatibilityText });
    }
    return items;
  }

  function openRequestDetailModal(requestId) {
    const id = String(requestId || "").trim();
    if (!id) return;
    const row = requestDetailMap.get(id);
    if (!row) return;

    activeRequestDetailId = id;
    $("reqDetailTitle").textContent = tt("request_detail_title_fmt", {
      method: String(row.method || "-"),
      path: String(row.path || "-")
    });
    const metaItems = buildReqDetailMetaItems(row);
    $("reqDetailMetaGrid").innerHTML = metaItems
      .map(
        (item) =>
          `<div class="req-detail-meta-item"><div class="k">${escapeHtml(item.key)}</div><div class="v">${escapeHtml(
            item.value
          )}</div></div>`
      )
      .join("");

    const reqCt = String(row?.requestContentType || "").trim();
    const resCt = String(row?.responseContentType || "").trim();
    $("reqDetailReqMeta").textContent = tt("request_detail_content_type", { type: reqCt || "-" });
    $("reqDetailResMeta").textContent = tt("request_detail_content_type", { type: resCt || "-" });
    $("reqDetailReqCode").textContent = safeCodeText(row?.requestPacket);
    $("reqDetailResCode").textContent = safeCodeText(row?.responsePacket);
    resetRequestDetailCopyButton("reqDetailReqCopyBtn");
    resetRequestDetailCopyButton("reqDetailResCopyBtn");

    const backdrop = $("reqDetailBackdrop");
    backdrop.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeRequestDetailModal() {
    activeRequestDetailId = "";
    resetRequestDetailCopyButton("reqDetailReqCopyBtn");
    resetRequestDetailCopyButton("reqDetailResCopyBtn");
    $("reqDetailBackdrop").hidden = true;
    document.body.style.overflow = "";
  }

  function renderToggle() {
    const button = $("requestsToggleBtn");
    const body = $("requestsSectionBody");
    if (!(button instanceof HTMLButtonElement) || !(body instanceof HTMLElement)) return;
    const expanded = readStoredBool(panelStorageKey) !== false;
    body.hidden = !expanded;
    button.textContent = expanded ? t("recent_requests_toggle_hide") : t("recent_requests_toggle_show");
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function togglePanel() {
    const expanded = readStoredBool(panelStorageKey) !== false;
    writeStoredString(panelStorageKey, expanded ? "0" : "1");
    renderToggle();
  }

  function renderRows(rows) {
    requestDetailMap = new Map();
    $("reqTable").innerHTML = rows
      .map((row, index) => {
        const requestId = String(row?.id || `${row?.ts || Date.now()}-${index}`);
        requestDetailMap.set(requestId, row);
        const requestTime = new Date(row.ts).toLocaleTimeString();
        const statusClass = row.status >= 400 ? "req-status-bad" : "req-status-ok";
        const routeText =
          row.requestedModel && row.mappedModel
            ? `${escapeHtml(row.requestedModel)} → ${escapeHtml(row.mappedModel)}`
            : "";
        return `<tr class="req-row" tabindex="0" data-req-id="${escapeHtml(requestId)}">
          <td>${requestTime}</td>
          <td>${row.method}</td>
          <td class="mono">${escapeHtml(row.path)}${routeText ? `<br><span class="req-route">${routeText}</span>` : ""}</td>
          <td>${fmtToken(row.inputTokens)}</td>
          <td>${fmtToken(row.outputTokens)}</td>
          <td>${fmtToken(row.totalTokens)}</td>
          <td class="${statusClass}">${row.status}</td>
          <td>${row.durationMs} ms</td>
        </tr>`;
      })
      .join("");
  }

  return {
    renderRows,
    renderToggle,
    togglePanel,
    openRequestDetailModal,
    closeRequestDetailModal,
    copyRequestDetailLog,
    hasOpenDetail() {
      return activeRequestDetailId.length > 0;
    },
    reopenActiveDetail() {
      if (activeRequestDetailId) {
        openRequestDetailModal(activeRequestDetailId);
      }
    }
  };
}
