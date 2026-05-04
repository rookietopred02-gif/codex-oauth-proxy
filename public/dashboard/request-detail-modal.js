// @ts-check

const REQUEST_DETAIL_PREVIEW_LIMIT = 64 * 1024;
const REQUEST_DETAIL_RENDER_CHUNK_CHARS = 16 * 1024;
const REQUEST_DETAIL_PACKET_FIELDS = {
  requestPacket: {
    contentTypeKey: "requestContentType",
    metaId: "reqDetailReqMeta",
    codeId: "reqDetailReqCode",
    loadBtnId: "reqDetailReqLoadBtn",
    copyBtnId: "reqDetailReqCopyBtn"
  },
  responsePacket: {
    contentTypeKey: "responseContentType",
    metaId: "reqDetailResMeta",
    codeId: "reqDetailResCode",
    loadBtnId: "reqDetailResLoadBtn",
    copyBtnId: "reqDetailResCopyBtn"
  }
};

export function createRequestDetailModal(deps) {
  const {
    $,
    api,
    t,
    tt,
    escapeHtml,
    fmtToken,
    formatDateTime,
    copyTextToClipboard,
    showCopyError,
    resolveProtocolLabel,
    resolveModelDisplay,
    resolveAccountDisplay,
    resolveCompatibilityHint,
    getRequestRowById
  } = deps;

  const requestDetailCopyResetTimers = new Map();
  const requestDetailRenderTokens = new Map();
  const requestDetailCache = new Map();
  let activeRequestDetailId = "";

  function scheduleNextFrame(callback) {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(callback);
      return;
    }
    setTimeout(callback, 0);
  }

  function safeCodeText(value) {
    const text = typeof value === "string" ? value : "";
    return text.length > 0 ? text : t("request_detail_empty");
  }

  function formatPacketBytes(bytes) {
    const size = Number(bytes || 0);
    if (!Number.isFinite(size) || size <= 0) return "0 B";
    if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
    if (size >= 1024) return `${(size / 1024).toFixed(size >= 10 * 1024 ? 0 : 1)} KB`;
    return `${size} B`;
  }

  function getPacketDescriptor(field) {
    return REQUEST_DETAIL_PACKET_FIELDS[field] || null;
  }

  function getRequestDetailCacheEntry(requestId) {
    const id = String(requestId || "").trim();
    if (!id) return null;
    const existing = requestDetailCache.get(id);
    if (existing) return existing;
    const created = {
      detail: null,
      packets: {}
    };
    requestDetailCache.set(id, created);
    return created;
  }

  function getPacketCacheEntry(cacheEntry, field) {
    if (!cacheEntry) return null;
    if (!cacheEntry.packets[field]) {
      cacheEntry.packets[field] = {
        previewText: "",
        fullText: "",
        previewLoaded: false,
        fullLoaded: false,
        totalChars: 0,
        totalBytes: 0,
        truncated: false,
        loadingPreview: false,
        loadingFull: false,
        error: ""
      };
    }
    return cacheEntry.packets[field];
  }

  function setRequestDetailCodeText(codeId, text) {
    const codeBlock = $(codeId);
    if (!(codeBlock instanceof HTMLElement)) return;
    const nextText = typeof text === "string" ? text : "";
    const token = Symbol(codeId);
    requestDetailRenderTokens.set(codeId, token);
    codeBlock.replaceChildren();
    if (nextText.length === 0) {
      codeBlock.textContent = t("request_detail_empty");
      return;
    }

    let cursor = 0;
    const appendChunk = () => {
      if (requestDetailRenderTokens.get(codeId) !== token) return;
      const nextChunk = nextText.slice(cursor, cursor + REQUEST_DETAIL_RENDER_CHUNK_CHARS);
      codeBlock.append(document.createTextNode(nextChunk));
      cursor += nextChunk.length;
      if (cursor < nextText.length) {
        scheduleNextFrame(appendChunk);
      }
    };

    appendChunk();
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

  async function copyRequestDetailLog(field, buttonId) {
    const requestId = activeRequestDetailId;
    const descriptor = getPacketDescriptor(field);
    if (!requestId || !descriptor) return;

    const button = $(buttonId);
    if (button instanceof HTMLButtonElement) {
      resetRequestDetailCopyButton(buttonId);
      button.textContent = t("request_detail_copying");
    }

    try {
      const packet = await loadRequestDetailPacket(requestId, field, { full: true });
      const text = packet?.fullLoaded ? packet.fullText : packet?.previewText || "";
      if (!text) return;
      await copyTextToClipboard(text);
      markRequestDetailCopySuccess(buttonId);
    } catch (err) {
      resetRequestDetailCopyButton(buttonId);
      showCopyError(err);
    }
  }

  function buildReqDetailMetaItems(row) {
    const timeText =
      row?.ts && typeof formatDateTime === "function"
        ? formatDateTime(row.ts, { dateStyle: "medium", timeStyle: "medium" })
        : row?.ts
          ? new Date(Number(row.ts)).toLocaleString()
          : "-";
    const latencyText = Number.isFinite(Number(row?.durationMs)) ? `${Number(row.durationMs)} ms` : "-";
    const tokenText = tt("token_usage_format", {
      input: fmtToken(row?.inputTokens),
      cachedInput: fmtToken(row?.cachedInputTokens),
      output: fmtToken(row?.outputTokens)
    });
    const totalText = fmtToken(row?.totalTokens);
    const protocolText = resolveProtocolLabel(row);
    const transportText = formatRequestTransport(row);
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
      { key: t("req_meta_transport"), value: transportText },
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

  function formatRequestTransport(row) {
    const method = String(row?.method || "").trim().toUpperCase();
    const transport = String(row?.transportType || "").trim().toLowerCase();
    if (transport === "websocket" || method === "WS") return "WebSocket";
    if (transport === "http") return method ? `HTTP ${method}` : "HTTP";
    return method || "-";
  }

  function renderRequestDetailMeta(row) {
    const metaItems = buildReqDetailMetaItems(row);
    $("reqDetailMetaGrid").innerHTML = metaItems
      .map(
        (item) =>
          `<div class="req-detail-meta-item"><div class="k">${escapeHtml(item.key)}</div><div class="v">${escapeHtml(
            item.value
          )}</div></div>`
      )
      .join("");
  }

  function renderRequestDetailLoading() {
    for (const field of Object.keys(REQUEST_DETAIL_PACKET_FIELDS)) {
      const descriptor = getPacketDescriptor(field);
      if (!descriptor) continue;
      $(descriptor.metaId).textContent = tt("request_detail_content_type", { type: "-" });
      setRequestDetailCodeText(descriptor.codeId, t("request_detail_loading"));
      const loadButton = $(descriptor.loadBtnId);
      if (loadButton instanceof HTMLButtonElement) {
        loadButton.hidden = true;
        loadButton.disabled = true;
        loadButton.textContent = t("request_detail_load_full");
      }
      const copyButton = $(descriptor.copyBtnId);
      if (copyButton instanceof HTMLButtonElement) {
        copyButton.disabled = true;
        resetRequestDetailCopyButton(descriptor.copyBtnId);
      }
    }
  }

  function renderRequestDetailPacketState(requestId, field) {
    if (activeRequestDetailId !== requestId) return;
    const descriptor = getPacketDescriptor(field);
    const cacheEntry = getRequestDetailCacheEntry(requestId);
    const packet = getPacketCacheEntry(cacheEntry, field);
    if (!descriptor || !cacheEntry || !packet) return;

    const detail = cacheEntry.detail;
    const type = String(detail?.[descriptor.contentTypeKey] || "").trim() || "-";
    const totalBytes =
      Number.isFinite(Number(packet.totalBytes)) && Number(packet.totalBytes) > 0
        ? Number(packet.totalBytes)
        : Number(detail?.packetInfo?.[field]?.bytes || 0);
    const mode = packet.fullLoaded ? t("request_detail_packet_full") : t("request_detail_packet_preview");
    $(descriptor.metaId).textContent = tt("request_detail_packet_meta", {
      type,
      size: formatPacketBytes(totalBytes),
      mode
    });

    const loadButton = $(descriptor.loadBtnId);
    if (loadButton instanceof HTMLButtonElement) {
      if (packet.loadingFull) {
        loadButton.hidden = false;
        loadButton.disabled = true;
        loadButton.textContent = t("request_detail_loading_full");
      } else if (packet.fullLoaded) {
        loadButton.hidden = false;
        loadButton.disabled = true;
        loadButton.textContent = t("request_detail_loaded_full");
      } else if (packet.truncated) {
        loadButton.hidden = false;
        loadButton.disabled = false;
        loadButton.textContent = t("request_detail_load_full");
      } else {
        loadButton.hidden = true;
        loadButton.disabled = true;
        loadButton.textContent = t("request_detail_load_full");
      }
    }

    const copyButton = $(descriptor.copyBtnId);
    if (copyButton instanceof HTMLButtonElement) {
      copyButton.disabled = !(packet.previewLoaded || packet.fullLoaded);
    }
  }

  async function fetchRequestDetailSummary(requestId) {
    const data = await api(`/admin/requests/${encodeURIComponent(requestId)}`);
    const detail = data?.request && typeof data.request === "object" ? data.request : null;
    if (!detail) {
      throw new Error(t("request_detail_empty"));
    }
    const cacheEntry = getRequestDetailCacheEntry(requestId);
    if (!cacheEntry) return null;
    cacheEntry.detail = detail;
    for (const field of Object.keys(REQUEST_DETAIL_PACKET_FIELDS)) {
      const packet = getPacketCacheEntry(cacheEntry, field);
      packet.totalChars = Number(detail?.packetInfo?.[field]?.chars || packet.totalChars || 0);
      packet.totalBytes = Number(detail?.packetInfo?.[field]?.bytes || packet.totalBytes || 0);
    }
    return detail;
  }

  async function fetchRequestDetailPacket(requestId, field, limit) {
    const search = new URLSearchParams({
      field,
      offset: "0",
      limit: String(limit)
    });
    const data = await api(`/admin/requests/${encodeURIComponent(requestId)}/packet?${search.toString()}`);
    return data?.packet && typeof data.packet === "object" ? data.packet : null;
  }

  async function loadRequestDetailPacket(requestId, field, options = {}) {
    const descriptor = getPacketDescriptor(field);
    const cacheEntry = getRequestDetailCacheEntry(requestId);
    const packet = getPacketCacheEntry(cacheEntry, field);
    if (!descriptor || !cacheEntry || !packet) return null;

    const wantsFull = options.full === true;
    if (wantsFull && packet.fullLoaded) return packet;
    if (!wantsFull && packet.previewLoaded) return packet;
    if (wantsFull && packet.loadingFull) return packet;
    if (!wantsFull && packet.loadingPreview) return packet;

    if (wantsFull) {
      packet.loadingFull = true;
    } else {
      packet.loadingPreview = true;
      if (!packet.previewLoaded && !packet.fullLoaded) {
        setRequestDetailCodeText(descriptor.codeId, t("request_detail_loading"));
      }
    }
    renderRequestDetailPacketState(requestId, field);

    try {
      const knownChars = Number(cacheEntry.detail?.packetInfo?.[field]?.chars || packet.totalChars || 0);
      const packetPayload = await fetchRequestDetailPacket(
        requestId,
        field,
        wantsFull ? Math.max(knownChars, REQUEST_DETAIL_PREVIEW_LIMIT) : REQUEST_DETAIL_PREVIEW_LIMIT
      );
      if (!packetPayload || activeRequestDetailId !== requestId) return packet;

      packet.totalChars = Number(packetPayload.totalChars || 0);
      packet.totalBytes = Number(packetPayload.totalBytes || 0);
      packet.truncated = packetPayload.truncated === true;
      packet.error = "";

      if (wantsFull) {
        packet.fullText = typeof packetPayload.text === "string" ? packetPayload.text : "";
        packet.fullLoaded = packet.truncated !== true;
        if (!packet.previewLoaded) {
          packet.previewText = packet.fullText.slice(0, REQUEST_DETAIL_PREVIEW_LIMIT);
          packet.previewLoaded = true;
        }
        setRequestDetailCodeText(descriptor.codeId, safeCodeText(packet.fullText));
      } else {
        packet.previewText = typeof packetPayload.text === "string" ? packetPayload.text : "";
        packet.previewLoaded = true;
        setRequestDetailCodeText(descriptor.codeId, safeCodeText(packet.previewText));
      }

      return packet;
    } catch (err) {
      packet.error = String(err?.message || err || "request_detail_load_failed");
      if (!packet.previewLoaded && !packet.fullLoaded && activeRequestDetailId === requestId) {
        setRequestDetailCodeText(descriptor.codeId, tt("request_detail_load_failed", { message: packet.error }));
      }
      throw err;
    } finally {
      packet.loadingPreview = false;
      packet.loadingFull = false;
      renderRequestDetailPacketState(requestId, field);
    }
  }

  async function openRequestDetailModal(requestId) {
    const id = String(requestId || "").trim();
    if (!id) return;
    const row = getRequestRowById(id);
    if (!row) return;

    activeRequestDetailId = id;
    $("reqDetailTitle").textContent = tt("request_detail_title_fmt", {
      method: String(row.method || "-"),
      path: String(row.path || "-")
    });
    renderRequestDetailMeta(row);

    resetRequestDetailCopyButton("reqDetailReqCopyBtn");
    resetRequestDetailCopyButton("reqDetailResCopyBtn");

    const backdrop = $("reqDetailBackdrop");
    backdrop.hidden = false;
    document.body.style.overflow = "hidden";

    const cacheEntry = getRequestDetailCacheEntry(id);
    if (cacheEntry?.detail) {
      for (const field of Object.keys(REQUEST_DETAIL_PACKET_FIELDS)) {
        const descriptor = getPacketDescriptor(field);
        const packet = getPacketCacheEntry(cacheEntry, field);
        if (!descriptor || !packet) continue;
        renderRequestDetailPacketState(id, field);
        if (packet.fullLoaded) {
          setRequestDetailCodeText(descriptor.codeId, safeCodeText(packet.fullText));
        } else if (packet.previewLoaded) {
          setRequestDetailCodeText(descriptor.codeId, safeCodeText(packet.previewText));
        } else {
          setRequestDetailCodeText(descriptor.codeId, t("request_detail_loading"));
        }
      }
    } else {
      renderRequestDetailLoading();
    }

    try {
      if (!cacheEntry?.detail) {
        await fetchRequestDetailSummary(id);
      }
      if (activeRequestDetailId !== id) return;
      renderRequestDetailPacketState(id, "requestPacket");
      renderRequestDetailPacketState(id, "responsePacket");
      await loadRequestDetailPacket(id, "responsePacket");
      queueMicrotask(() => {
        if (activeRequestDetailId !== id) return;
        loadRequestDetailPacket(id, "requestPacket").catch(() => {});
      });
    } catch (err) {
      if (activeRequestDetailId !== id) return;
      setRequestDetailCodeText("reqDetailReqCode", tt("request_detail_load_failed", { message: err.message }));
      setRequestDetailCodeText("reqDetailResCode", tt("request_detail_load_failed", { message: err.message }));
    }
  }

  function closeRequestDetailModal() {
    activeRequestDetailId = "";
    resetRequestDetailCopyButton("reqDetailReqCopyBtn");
    resetRequestDetailCopyButton("reqDetailResCopyBtn");
    $("reqDetailBackdrop").hidden = true;
    document.body.style.overflow = "";
  }

  function pruneRequestDetailCache(visibleIds) {
    const nextCache = new Map(
      Array.from(requestDetailCache.entries()).filter(([requestId]) => visibleIds.has(requestId))
    );
    requestDetailCache.clear();
    for (const [requestId, entry] of nextCache) {
      requestDetailCache.set(requestId, entry);
    }
  }

  return {
    openRequestDetailModal,
    closeRequestDetailModal,
    copyRequestDetailLog,
    pruneRequestDetailCache,
    async loadRequestDetailFullPacket(field) {
      const requestId = activeRequestDetailId;
      if (!requestId) return;
      await loadRequestDetailPacket(requestId, field, { full: true });
    },
    hasOpenDetail() {
      return activeRequestDetailId.length > 0;
    },
    async reopenActiveDetail() {
      if (activeRequestDetailId) {
        await openRequestDetailModal(activeRequestDetailId);
      }
    }
  };
}
