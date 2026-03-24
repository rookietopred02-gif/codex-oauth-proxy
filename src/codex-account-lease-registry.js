export function createCodexAccountLeaseRegistry() {
  const leases = new Map();

  function normalizeRef(ref) {
    const value = String(ref || "").trim();
    return value || "";
  }

  function acquire(ref, metadata = {}) {
    const normalizedRef = normalizeRef(ref);
    if (!normalizedRef) {
      return {
        ref: "",
        release() {},
        released: true
      };
    }

    const now = Date.now();
    const record = leases.get(normalizedRef) || {
      count: 0,
      firstAcquiredAt: now,
      lastAcquiredAt: now,
      holders: []
    };
    record.count += 1;
    record.lastAcquiredAt = now;
    if (record.count === 1) {
      record.firstAcquiredAt = now;
    }
    if (metadata && typeof metadata === "object" && Object.keys(metadata).length > 0) {
      record.holders.push({
        ...metadata,
        acquiredAt: now
      });
    }
    leases.set(normalizedRef, record);

    let released = false;
    return {
      ref: normalizedRef,
      get released() {
        return released;
      },
      release() {
        if (released) return;
        released = true;
        const current = leases.get(normalizedRef);
        if (!current) return;
        current.count = Math.max(0, Number(current.count || 0) - 1);
        if (current.count === 0) {
          leases.delete(normalizedRef);
          return;
        }
        if (Array.isArray(current.holders) && current.holders.length > 0) {
          current.holders.pop();
        }
        leases.set(normalizedRef, current);
      }
    };
  }

  function isLeased(ref) {
    const normalizedRef = normalizeRef(ref);
    if (!normalizedRef) return false;
    return Number(leases.get(normalizedRef)?.count || 0) > 0;
  }

  function getLeaseCount(ref) {
    const normalizedRef = normalizeRef(ref);
    if (!normalizedRef) return 0;
    return Number(leases.get(normalizedRef)?.count || 0);
  }

  function snapshot() {
    return [...leases.entries()].map(([ref, record]) => ({
      ref,
      count: Number(record?.count || 0),
      firstAcquiredAt: Number(record?.firstAcquiredAt || 0),
      lastAcquiredAt: Number(record?.lastAcquiredAt || 0)
    }));
  }

  return {
    acquire,
    isLeased,
    getLeaseCount,
    snapshot
  };
}
