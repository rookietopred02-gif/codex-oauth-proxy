// @ts-check

function toErrorMessageText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      toErrorMessageText(data?.message) ||
      toErrorMessageText(data?.error) ||
      text.trim() ||
      `HTTP ${res.status}`;
    if (
      typeof window !== "undefined" &&
      res.status === 401 &&
      /^dashboard_auth/.test(String(data?.error || ""))
    ) {
      window.dispatchEvent(
        new CustomEvent("dashboard-auth-required", {
          detail: {
            path,
            status: res.status,
            error: String(data?.error || ""),
            message: msg
          }
        })
      );
    }
    /** @type {Error & { status?: number; data?: unknown }} */
    const error = new Error(msg);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}
