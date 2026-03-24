export function createCodexAccountLeaseRegistry() {
  const leases = new Map();
  let sequence = 0;

  function normalizeRef(ref) {
    const value = String(ref || "").trim();
    return value || "";
  }

  function getLeaseCount(ref) {
    const normalizedRef = normalizeRef(ref);
    if (!normalizedRef) return 0;
    return Number(leases.get(normalizedRef)?.count || 0);
  }

  function isLeased(ref) {
    return getLeaseCount(ref) > 0;
  }

  function acquire(ref, metadata = {}) {
    const normalizedRef = normalizeRef(ref);
    if (!normalizedRef) {
      return {
        ref: "",
        token: "",
        release() {}
      };
    }

    const token = `${normalizedRef}#${Date.now().toString(36)}_${(sequence += 1).toString(36)}`;
    const current = leases.get(normalizedRef) || {
      count: 0,
      holders: new Map()
    };
    current.count += 1;
    current.holders.set(token, {
      acquiredAt: Date.now(),
      metadata: metadata && typeof metadata === "object" ? { ...metadata } : {}
    });
    leases.set(normalizedRef, current);

    let released = false;
    return {
      ref: normalizedRef,
      token,
      release() {
        if (released) return false;
        released = true;
        const active = leases.get(normalizedRef);
        if (!active) return false;
        if (!active.holders.delete(token)) return false;
        active.count = Math.max(0, active.count - 1);
        if (active.count === 0 || active.holders.size === 0) {
          leases.delete(normalizedRef);
        } else {
          leases.set(normalizedRef, active);
        }
        return true;
      }
    };
  }

  function snapshot() {
    return [...leases.entries()].map(([ref, value]) => ({
      ref,
      count: Number(value?.count || 0),
      holders: [...(value?.holders?.values?.() || [])].map((holder) => ({
        acquiredAt: Number(holder?.acquiredAt || 0) || 0,
        metadata: holder?.metadata && typeof holder.metadata === "object" ? { ...holder.metadata } : {}
      }))
    }));
  }

  return {
    acquire,
    getLeaseCount,
    isLeased,
    snapshot
  };
}
