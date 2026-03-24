export function createAccountLeaseRegistry() {
  const leases = new Map();

  function normalizeRef(ref) {
    const value = String(ref || "").trim();
    return value || "";
  }

  function getLeaseCount(ref) {
    const normalizedRef = normalizeRef(ref);
    if (!normalizedRef) return 0;
    return Number(leases.get(normalizedRef) || 0);
  }

  function isLeased(ref) {
    return getLeaseCount(ref) > 0;
  }

  function acquire(ref) {
    const normalizedRef = normalizeRef(ref);
    if (!normalizedRef) {
      return () => {};
    }

    leases.set(normalizedRef, getLeaseCount(normalizedRef) + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const nextCount = getLeaseCount(normalizedRef) - 1;
      if (nextCount > 0) {
        leases.set(normalizedRef, nextCount);
      } else {
        leases.delete(normalizedRef);
      }
    };
  }

  function snapshot() {
    return Object.fromEntries(leases.entries());
  }

  return {
    acquire,
    isLeased,
    getLeaseCount,
    snapshot
  };
}
