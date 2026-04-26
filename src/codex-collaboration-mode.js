import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_COLLABORATION_MODE = "default";
const PLAN_COLLABORATION_MODE = "plan";
const TURN_METADATA_KEY = "x-codex-turn-metadata";
const DEFAULT_TURN_MODE_RESOLVE_TIMEOUT_MS = 500;
const TURN_MODE_RESOLVE_POLL_MS = 25;

function normalizeSettingObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeCodexCollaborationMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === PLAN_COLLABORATION_MODE) return PLAN_COLLABORATION_MODE;
  if (normalized === DEFAULT_COLLABORATION_MODE) return DEFAULT_COLLABORATION_MODE;
  return "";
}

function resolveCodexHome(env = process.env) {
  const configured = String(env?.CODEX_HOME || "").trim();
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), ".codex");
}

function safeJsonParse(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function extractCodexTurnMetadata(requestBody) {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
    return {
      sessionId: "",
      turnId: ""
    };
  }

  const clientMetadata = normalizeSettingObject(requestBody.client_metadata);
  const rawTurnMetadata = typeof clientMetadata?.[TURN_METADATA_KEY] === "string" ? clientMetadata[TURN_METADATA_KEY] : "";
  const parsedTurnMetadata = safeJsonParse(rawTurnMetadata);
  const sessionId =
    String(parsedTurnMetadata?.session_id || parsedTurnMetadata?.sessionId || requestBody.prompt_cache_key || "").trim();
  const turnId = String(parsedTurnMetadata?.turn_id || parsedTurnMetadata?.turnId || "").trim();
  return {
    sessionId,
    turnId
  };
}

function getExplicitRequestCollaborationMode(requestBody) {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return "";
  const directMode = normalizeCodexCollaborationMode(requestBody.collaborationMode || requestBody.collaboration_mode);
  if (directMode) return directMode;
  const settings = normalizeSettingObject(requestBody.settings);
  return normalizeCodexCollaborationMode(settings?.collaborationMode || settings?.collaboration_mode);
}

function hasExplicitDeveloperInstructions(requestBody) {
  const settings = normalizeSettingObject(requestBody?.settings);
  return Boolean(settings && Object.prototype.hasOwnProperty.call(settings, "developer_instructions"));
}

function matchesSessionFileName(fileName, sessionId) {
  const normalizedFileName = String(fileName || "").trim();
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedFileName.endsWith(".jsonl") || !normalizedSessionId) return false;
  return normalizedFileName === `${normalizedSessionId}.jsonl` || normalizedFileName.endsWith(`-${normalizedSessionId}.jsonl`);
}

function getSessionFileRolloutKey(fileName, sessionId) {
  const normalizedFileName = String(fileName || "").trim();
  const normalizedSessionId = String(sessionId || "").trim();
  const suffix = `-${normalizedSessionId}.jsonl`;
  if (!normalizedSessionId || !normalizedFileName.startsWith("rollout-") || !normalizedFileName.endsWith(suffix)) {
    return "";
  }
  return normalizedFileName.slice("rollout-".length, -suffix.length);
}

function compareSessionFileCandidates(left, right) {
  const leftRolloutKey = String(left?.rolloutKey || "");
  const rightRolloutKey = String(right?.rolloutKey || "");
  if (leftRolloutKey !== rightRolloutKey) {
    if (!leftRolloutKey) return -1;
    if (!rightRolloutKey) return 1;
    return leftRolloutKey.localeCompare(rightRolloutKey);
  }

  const leftMtimeMs = Number(left?.mtimeMs || 0);
  const rightMtimeMs = Number(right?.mtimeMs || 0);
  if (leftMtimeMs !== rightMtimeMs) {
    return leftMtimeMs < rightMtimeMs ? -1 : 1;
  }

  return String(left?.filePath || "").localeCompare(String(right?.filePath || ""));
}

async function walkForSessionFile(rootDir, sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) return null;

  const stack = [rootDir];
  let bestMatch = null;
  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!matchesSessionFileName(entry.name, normalizedSessionId)) continue;

      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }

      const candidate = {
        filePath: fullPath,
        mtimeMs: Number(stat.mtimeMs || 0),
        rolloutKey: getSessionFileRolloutKey(entry.name, normalizedSessionId)
      };
      if (!bestMatch || compareSessionFileCandidates(bestMatch, candidate) < 0) {
        bestMatch = candidate;
      }
    }
  }
  return bestMatch;
}

async function readSessionStateFromFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const turnModes = new Map();
  let latestTurnId = "";
  let latestTurnMode = "";
  let baseInstructions = "";

  function rememberTurnMode(turnId, collaborationMode) {
    const normalizedTurnId = String(turnId || "").trim();
    const normalizedMode = normalizeCodexCollaborationMode(collaborationMode);
    if (!normalizedMode) return;
    if (normalizedTurnId) {
      turnModes.set(normalizedTurnId, normalizedMode);
      latestTurnId = normalizedTurnId;
    }
    latestTurnMode = normalizedMode;
  }

  for (const line of lines) {
    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    const recordType = String(parsed.type || "").trim();
    const payload = normalizeSettingObject(parsed.payload);
    if (!payload) continue;

    if (recordType === "session_meta") {
      const candidateBaseInstructions = typeof payload.base_instructions?.text === "string" ? payload.base_instructions.text : "";
      if (candidateBaseInstructions) {
        baseInstructions = candidateBaseInstructions;
      }
      continue;
    }

    if (recordType === "turn_context") {
      const turnId = String(payload.turn_id || payload.turnId || "").trim();
      const collaborationMode = normalizeCodexCollaborationMode(
        normalizeSettingObject(payload.collaboration_mode)?.mode ||
          payload.collaboration_mode_kind ||
          payload.collaborationMode ||
          payload.collaboration_mode
      );
      rememberTurnMode(turnId, collaborationMode);
      continue;
    }

    if (recordType !== "event_msg") continue;
    if (String(payload.type || "").trim() !== "task_started") continue;

    const turnId = String(payload.turn_id || payload.turnId || "").trim();
    const collaborationMode = normalizeCodexCollaborationMode(
      payload.collaboration_mode_kind || payload.collaborationMode || payload.collaboration_mode
    );
    rememberTurnMode(turnId, collaborationMode);
  }

  return {
    baseInstructions,
    latestTurnId,
    latestTurnMode,
    turnModes
  };
}

export function createCodexCollaborationModeResolver(options = {}) {
  const codexHome = path.resolve(options.codexHome || resolveCodexHome(options.env));
  const sessionRoots = [
    path.join(codexHome, "sessions"),
    path.join(codexHome, "archived_sessions")
  ];
  const sessionStateCache = new Map();
  const turnModeResolveTimeoutMs = Math.max(0, Number(
    options.turnModeResolveTimeoutMs ?? DEFAULT_TURN_MODE_RESOLVE_TIMEOUT_MS
  ) || 0);

  async function findSessionFile(sessionId) {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) return "";

    let bestMatch = null;
    for (const rootDir of sessionRoots) {
      const match = await walkForSessionFile(rootDir, normalizedSessionId);
      if (match && (!bestMatch || compareSessionFileCandidates(bestMatch, match) < 0)) {
        bestMatch = match;
      }
    }

    return bestMatch?.filePath || "";
  }

  async function loadSessionState(sessionId) {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) return null;

    const filePath = await findSessionFile(normalizedSessionId);
    if (!filePath) {
      sessionStateCache.delete(normalizedSessionId);
      return null;
    }

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      sessionStateCache.delete(normalizedSessionId);
      return null;
    }

    const cached = sessionStateCache.get(normalizedSessionId);
    if (
      cached &&
      cached.filePath === filePath &&
      cached.size === Number(stat.size || 0) &&
      cached.mtimeMs === Number(stat.mtimeMs || 0)
    ) {
      return cached.state;
    }

    const state = await readSessionStateFromFile(filePath);
    sessionStateCache.set(normalizedSessionId, {
      filePath,
      size: Number(stat.size || 0),
      mtimeMs: Number(stat.mtimeMs || 0),
      state
    });
    return state;
  }

  async function resolveTurnMode(requestBody) {
    const { sessionId, turnId } = extractCodexTurnMetadata(requestBody);
    if (!sessionId) return null;

    const startedAt = Date.now();
    let lastResult = {
      mode: "",
      sessionId,
      turnId,
      baseInstructions: ""
    };
    let initialLatestSnapshot = null;

    while (true) {
      const sessionState = await loadSessionState(sessionId);
      const exactMode = turnId ? normalizeCodexCollaborationMode(sessionState?.turnModes?.get(turnId) || "") : "";
      const latestTurnId = String(sessionState?.latestTurnId || "");
      const latestMode = !turnId ? normalizeCodexCollaborationMode(sessionState?.latestTurnMode || "") : "";
      const mode = exactMode || latestMode;
      lastResult = {
        mode,
        sessionId,
        turnId: turnId || latestTurnId,
        baseInstructions: typeof sessionState?.baseInstructions === "string" ? sessionState.baseInstructions : ""
      };
      if (turnId && mode) return lastResult;

      if (!turnId) {
        if (latestMode === PLAN_COLLABORATION_MODE) {
          return lastResult;
        }

        if (initialLatestSnapshot === null) {
          initialLatestSnapshot = {
            latestTurnId,
            latestMode
          };
        } else if (
          latestMode &&
          (latestTurnId !== initialLatestSnapshot.latestTurnId || latestMode !== initialLatestSnapshot.latestMode)
        ) {
          return lastResult;
        }
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed >= turnModeResolveTimeoutMs) {
        if (!turnId && latestMode !== PLAN_COLLABORATION_MODE) {
          return {
            ...lastResult,
            mode: ""
          };
        }
        return lastResult;
      }
      await delay(Math.min(TURN_MODE_RESOLVE_POLL_MS, turnModeResolveTimeoutMs - elapsed));
    }
  }

  async function bridgeRequest(requestBody) {
    if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
      return requestBody;
    }

    const explicitMode = getExplicitRequestCollaborationMode(requestBody);
    const resolvedTurnMode = await resolveTurnMode(requestBody);
    const bridgedMode = explicitMode || normalizeCodexCollaborationMode(resolvedTurnMode?.mode || "");
    if (!bridgedMode) return structuredClone(requestBody);

    const bridged = structuredClone(requestBody);
    if (!explicitMode) {
      bridged.collaborationMode = bridgedMode;
    }

    const requestInstructions = typeof bridged.instructions === "string" ? bridged.instructions : "";
    const settings = normalizeSettingObject(bridged.settings) ? { ...bridged.settings } : {};
    if (
      !hasExplicitDeveloperInstructions(bridged) &&
      requestInstructions === String(resolvedTurnMode?.baseInstructions || "")
    ) {
      settings.developer_instructions = null;
      bridged.settings = settings;
    }

    return bridged;
  }

  return {
    bridgeRequest,
    extractCodexTurnMetadata,
    findSessionFile,
    loadSessionState,
    resolveTurnMode
  };
}
