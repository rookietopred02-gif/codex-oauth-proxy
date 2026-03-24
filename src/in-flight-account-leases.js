function normalizeAccountRef(value) {
  const text = String(value || "").trim();
  return text || "";
}

export function createInFlightAccountLeaseTracker() {
  const leases = new Map();

  function getLeaseCount(accountRef = "") {
    const ref = normalizeAccountRef(accountRef);
    if (!ref) return 0;
    return Number(leases.get(ref) || 0);
  }

  function isLeased(accountRef = "") {
    return getLeaseCount(accountRef) > 0;
  }

  function acquire(accountRef = "") {
    const ref = normalizeAccountRef(accountRef);
    if (!ref) {
      return () => {};
    }
    leases.set(ref, getLeaseCount(ref) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const nextCount = getLeaseCount(ref) - 1;
      if (nextCount > 0) {
        leases.set(ref, nextCount);
      } else {
        leases.delete(ref);
      }
    };
  }

  function getState() {
    return [...leases.entries()]
      .map(([accountRef, count]) => ({
        accountRef,
        count: Number(count || 0)
      }))
      .filter((entry) => entry.count > 0);
  }

  return {
    acquire,
    getLeaseCount,
    isLeased,
    getState
  };
}
