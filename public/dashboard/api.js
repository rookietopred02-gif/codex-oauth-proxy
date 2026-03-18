export async function api(path, init = {}) {
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.message || data?.error || text || `HTTP ${res.status}`;
    const error = new Error(msg);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}
