// @ts-check

import { createRequestDetailModal } from "./request-detail-modal.js";
import { createRequestListUi } from "./request-list.js";

export function createRecentRequestsUi(deps) {
  let requestDetailMap = new Map();

  const requestListUi = createRequestListUi(deps);
  const requestDetailModal = createRequestDetailModal({
    ...deps,
    getRequestRowById(requestId) {
      return requestDetailMap.get(String(requestId || "").trim()) || null;
    }
  });

  return {
    renderRows(rows) {
      const rendered = requestListUi.renderRows(rows);
      requestDetailMap = rendered.requestDetailMap;
      requestDetailModal.pruneRequestDetailCache(rendered.visibleIds);
    },
    renderRecordingToggle: requestListUi.renderRecordingToggle,
    toggleRecording: requestListUi.toggleRecording,
    openRequestDetailModal: requestDetailModal.openRequestDetailModal,
    closeRequestDetailModal: requestDetailModal.closeRequestDetailModal,
    copyRequestDetailLog: requestDetailModal.copyRequestDetailLog,
    loadRequestDetailFullPacket: requestDetailModal.loadRequestDetailFullPacket,
    isRecordingEnabled() {
      return requestListUi.isRecordingEnabled();
    },
    hasOpenDetail: requestDetailModal.hasOpenDetail,
    reopenActiveDetail: requestDetailModal.reopenActiveDetail
  };
}
