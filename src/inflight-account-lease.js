function normalizeRef(value) {
  const ref = typeof value === "string" ? value.trim() : "";
  return ref || "";
}

export function collectLeaseRefs(source) {
  if (!source) return [];
  if (Array.isArray(source)) {
    return [...new Set(source.map((item) => normalizeRef(item)).filter(Boolean))];
  }

  const refs = [
    source.poolEntryId,
    source.poolAccountId,
    source.entryId,
    source.account_id,
    source.accountId,
    source.ref
  ];
  return [...new Set(refs.map((item) => normalizeRef(item)).filter(Boolean))];
}

export function createInFlightAccountLeaseTracker() {
  const counts = new Map();

  function retain(refsInput) {
    const refs = collectLeaseRefs(refsInput);
    for (const ref of refs) {
      counts.set(ref, Number(counts.get(ref) || 0) + 1);
    }

    let released = false;
    return {
      refs,
      release() {
        if (released) return;
        released = true;
        for (const ref of refs) {
          const nextCount = Number(counts.get(ref) || 0) - 1;
          if (nextCount > 0) counts.set(ref, nextCount);
          else counts.delete(ref);
        }
      }
    };
  }

  function isLeased(refsInput) {
    const refs = collectLeaseRefs(refsInput);
    return refs.some((ref) => Number(counts.get(ref) || 0) > 0);
  }

  function snapshot() {
    return [...counts.entries()]
      .map(([ref, count]) => ({ ref, count: Number(count || 0) }))
      .filter((entry) => entry.count > 0);
  }

  return {
    retain,
    isLeased,
    snapshot
  };
}
