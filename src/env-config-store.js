import fs from "node:fs/promises";
import path from "node:path";

function formatEnvValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = String(value);
  if (text.length === 0) return "";
  if (!/[\s\r\n]/.test(text)) return text;
  return JSON.stringify(text);
}

export function buildProxyConfigEnvEntries(config) {
  const modelMappings =
    config?.modelRouter?.customMappings && typeof config.modelRouter.customMappings === "object"
      ? config.modelRouter.customMappings
      : {};
  const runtimePort = Number(config?.runtimePort || config?.port || 8787);

  return {
    PORT: runtimePort,
    UPSTREAM_MODE: String(config?.upstreamMode || "codex-chatgpt").trim().toLowerCase(),
    UPSTREAM_BASE_URL: String(config?.upstreamBaseUrl || "").trim(),
    GEMINI_BASE_URL: String(config?.gemini?.baseUrl || "").trim(),
    ANTHROPIC_BASE_URL: String(config?.anthropic?.baseUrl || "").trim(),
    CODEX_DEFAULT_MODEL: String(config?.codex?.defaultModel || "").trim(),
    CODEX_DEFAULT_INSTRUCTIONS: String(config?.codex?.defaultInstructions || ""),
    CODEX_DEFAULT_SERVICE_TIER: String(config?.codex?.defaultServiceTier || "default").trim().toLowerCase(),
    CODEX_DEFAULT_REASONING_EFFORT: String(config?.codex?.defaultReasoningEffort || "adaptive").trim().toLowerCase(),
    CODEX_MULTI_ACCOUNT_ENABLED: config?.codexOAuth?.multiAccountEnabled === true,
    CODEX_MULTI_ACCOUNT_STRATEGY: String(config?.codexOAuth?.multiAccountStrategy || "smart").trim().toLowerCase(),
    CODEX_AUTO_LOGOUT_EXPIRED_ACCOUNTS: config?.expiredAccountCleanup?.enabled === true,
    MODEL_ROUTER_ENABLED: config?.modelRouter?.enabled !== false,
    MODEL_ROUTER_MAPPINGS: Object.keys(modelMappings).length > 0 ? JSON.stringify(modelMappings) : "",
    CLOUDFLARED_MODE: String(config?.publicAccess?.defaultMode || "quick").trim().toLowerCase(),
    CLOUDFLARED_USE_HTTP2: config?.publicAccess?.defaultUseHttp2 !== false,
    CLOUDFLARED_AUTO_INSTALL: config?.publicAccess?.autoInstall !== false,
    CLOUDFLARED_TUNNEL_TOKEN: String(config?.publicAccess?.defaultTunnelToken || ""),
    CLOUDFLARED_LOCAL_PORT: runtimePort
  };
}

export async function upsertEnvFileEntries(filePath, entries) {
  const targetPath = path.resolve(filePath);
  let raw = "";
  try {
    raw = await fs.readFile(targetPath, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }

  const inputLines = raw.length > 0 ? raw.split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(entries || {}));
  const outputLines = inputLines.map((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) return line;
    const key = match[1];
    if (!remaining.has(key)) return line;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${formatEnvValue(value)}`;
  });

  if (remaining.size > 0) {
    if (outputLines.length > 0 && outputLines[outputLines.length - 1] !== "") {
      outputLines.push("");
    }
    for (const [key, value] of remaining) {
      outputLines.push(`${key}=${formatEnvValue(value)}`);
    }
  }

  const nextText = `${outputLines.join("\n").replace(/\n*$/, "")}\n`;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, nextText, "utf8");
}

export async function persistProxyConfigEnv(filePath, config) {
  const entries = buildProxyConfigEnvEntries(config);
  await upsertEnvFileEntries(filePath, entries);
  return {
    filePath: path.resolve(filePath),
    updatedKeys: Object.keys(entries)
  };
}
