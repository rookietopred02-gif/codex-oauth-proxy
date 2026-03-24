function normalizeAccountRef(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

export function createAccountLeaseTracker() {
  const leases = new Map();

  function acquire(accountRef, metadata = {}) {
    const ref = normalizeAccountRef(accountRef);
    if (!ref) {
      return {
        ref: "",
        release() {}
      };
    }

    const count = Number(leases.get(ref)?.count || 0) + 1;
    leases.set(ref, {
      count,
      lastAcquiredAt: Date.now(),
      metadata
    });

    let released = false;

    return {
      ref,
      release() {
        if (released) return;
        released = true;
        const current = leases.get(ref);
        if (!current) return;
        if (Number(current.count || 0) <= 1) {
          leases.delete(ref);
          return;
        }
        leases.set(ref, {
          ...current,
          count: Number(current.count || 0) - 1
        });
      }
    };
  }

  function isLeased(accountRef) {
    const ref = normalizeAccountRef(accountRef);
    if (!ref) return false;
    return Number(leases.get(ref)?.count || 0) > 0;
  }

  function snapshot() {
    return [...leases.entries()].map(([ref, entry]) => ({
      ref,
      count: Number(entry?.count || 0),
      lastAcquiredAt: Number(entry?.lastAcquiredAt || 0) || 0
    }));
  }

  return {
    acquire,
    isLeased,
    snapshot
  };
}
