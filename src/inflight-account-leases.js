export function createInFlightAccountLeaseStore() {
  const activeLeases = new Map();

  function normalizeRef(ref = "") {
    const value = String(ref || "").trim();
    return value || "";
  }

  function acquire(ref) {
    const key = normalizeRef(ref);
    if (!key) {
      return {
        ref: "",
        active: false,
        release() {}
      };
    }

    const nextCount = Number(activeLeases.get(key) || 0) + 1;
    activeLeases.set(key, nextCount);
    let released = false;

    return {
      ref: key,
      active: true,
      release() {
        if (released) return;
        released = true;
        const currentCount = Number(activeLeases.get(key) || 0);
        if (currentCount <= 1) {
          activeLeases.delete(key);
          return;
        }
        activeLeases.set(key, currentCount - 1);
      }
    };
  }

  function isLeased(ref) {
    const key = normalizeRef(ref);
    if (!key) return false;
    return Number(activeLeases.get(key) || 0) > 0;
  }

  function snapshot() {
    return [...activeLeases.entries()].map(([ref, count]) => ({ ref, count }));
  }

  return {
    acquire,
    isLeased,
    snapshot
  };
}
