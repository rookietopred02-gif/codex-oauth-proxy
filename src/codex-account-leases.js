function normalizeAccountRef(ref) {
  return typeof ref === "string" ? ref.trim() : "";
}

export function createCodexAccountLeaseRegistry() {
  const activeLeases = new Map();

  function getActiveLeaseCount(accountRef) {
    const ref = normalizeAccountRef(accountRef);
    if (!ref) return 0;
    return Number(activeLeases.get(ref) || 0);
  }

  function isLeased(accountRef) {
    return getActiveLeaseCount(accountRef) > 0;
  }

  function acquire(accountRef) {
    const ref = normalizeAccountRef(accountRef);
    if (!ref) {
      return {
        accountRef: "",
        release() {}
      };
    }

    activeLeases.set(ref, getActiveLeaseCount(ref) + 1);
    let released = false;

    return {
      accountRef: ref,
      release() {
        if (released) return;
        released = true;
        const nextCount = Math.max(0, getActiveLeaseCount(ref) - 1);
        if (nextCount > 0) activeLeases.set(ref, nextCount);
        else activeLeases.delete(ref);
      }
    };
  }

  function snapshot() {
    return [...activeLeases.entries()].map(([accountRef, count]) => ({
      accountRef,
      count
    }));
  }

  return {
    acquire,
    isLeased,
    getActiveLeaseCount,
    snapshot
  };
}
