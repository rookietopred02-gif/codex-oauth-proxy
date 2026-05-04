export function isSafeExternalUrl(rawUrl, { allowedProtocols = ["https:"] } = {}) {
  try {
    const url = new URL(String(rawUrl || ""));
    return allowedProtocols.includes(url.protocol);
  } catch {
    return false;
  }
}

export function isTrustedBackendNavigationUrl(rawUrl, backendUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    const backend = new URL(String(backendUrl || ""));
    return url.origin === backend.origin;
  } catch {
    return false;
  }
}
