function normalizeLeaseRefs(values) {
  const refs = Array.isArray(values) ? values : [values];
  return [...new Set(refs.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function createCodexAccountLeaseStore() {
  const leases = new Map();

  function acquire(refs) {
    const normalizedRefs = normalizeLeaseRefs(refs);
    for (const ref of normalizedRefs) {
      leases.set(ref, Number(leases.get(ref) || 0) + 1);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const ref of normalizedRefs) {
        const nextCount = Number(leases.get(ref) || 0) - 1;
        if (nextCount > 0) {
          leases.set(ref, nextCount);
        } else {
          leases.delete(ref);
        }
      }
    };
  }

  function isLeased(refs) {
    return normalizeLeaseRefs(refs).some((ref) => Number(leases.get(ref) || 0) > 0);
  }

  return {
    acquire,
    isLeased
  };
}
