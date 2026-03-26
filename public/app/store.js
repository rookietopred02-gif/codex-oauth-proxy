// @ts-check

export function createDashboardStore(initialState = {}) {
  let state = { ...(initialState || {}) };

  return {
    get(key) {
      return state[key];
    },
    set(key, value) {
      state[key] = value;
      return value;
    },
    patch(partial) {
      state = { ...state, ...(partial || {}) };
      return { ...state };
    },
    snapshot() {
      return { ...state };
    }
  };
}

export function readStoredString(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readStoredBool(key) {
  const raw = readStoredString(key);
  if (raw === null) return null;
  return raw === "1";
}

export function writeStoredString(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore storage errors
  }
}

export function readStoredNumber(key, fallback, min, max) {
  const raw = readStoredString(key);
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
