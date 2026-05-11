import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function ensurePlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toNonNegativeIntegerNumber(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readOptionalText(fsImpl, filePath) {
  try {
    return await fsImpl.readFile(filePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

function parseOptionalJson(text, filePath) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  try {
    return ensurePlainObject(JSON.parse(raw));
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${err?.message || err}`);
  }
}

function resolveExistingAuthAccountId(existingAuth, extractOpenAICodexAccountId) {
  const tokens = ensurePlainObject(existingAuth?.tokens);
  const explicit = String(tokens.account_id || existingAuth?.account_id || "").trim();
  if (explicit) return explicit;
  const accessToken = String(tokens.access_token || "").trim();
  if (!accessToken) return "";
  return String(extractOpenAICodexAccountId(accessToken) || "").trim();
}

function resolveExistingMatchingTokens(existingAuth, accountId, extractOpenAICodexAccountId) {
  const existingTokens = ensurePlainObject(existingAuth?.tokens);
  const existingAccountId = resolveExistingAuthAccountId(existingAuth, extractOpenAICodexAccountId);
  if (!existingAccountId || existingAccountId !== String(accountId || "").trim()) {
    return null;
  }
  return existingTokens;
}

function resolveIdTokenForAccount({ token, existingAuth, accountId, extractOpenAICodexAccountId }) {
  const direct = String(token?.id_token || "").trim();
  if (direct) {
    return {
      idToken: direct,
      usedExistingIdTokenFallback: false
    };
  }

  const existingTokens = ensurePlainObject(existingAuth?.tokens);
  const existingIdToken = String(existingTokens.id_token || "").trim();
  if (!existingIdToken) {
    const err = new Error(
      "This account cannot be switched locally yet because the pool does not contain a reusable ChatGPT token bundle for it. Re-login that account and import/store the resulting id_token first."
    );
    err.code = "missing_reusable_chatgpt_bundle";
    throw err;
  }

  const existingAccountId = resolveExistingAuthAccountId(existingAuth, extractOpenAICodexAccountId);
  if (!existingAccountId || existingAccountId !== String(accountId || "").trim()) {
    const err = new Error(
      "This account cannot be switched locally yet because your current ~/.codex/auth.json does not already contain a reusable ChatGPT session for the same account. Re-login that exact account with codex login first."
    );
    err.code = "missing_reusable_chatgpt_bundle";
    throw err;
  }

  return {
    idToken: existingIdToken,
    usedExistingIdTokenFallback: true
  };
}

function upsertTopLevelTomlString(text, key, value) {
  const source = String(text || "");
  const serialized = JSON.stringify(String(value || ""));
  const line = `${key} = ${serialized}`;
  const keyPattern = new RegExp(`^(\\s*)${escapeRegex(key)}\\s*=.*$`, "m");
  if (keyPattern.test(source)) {
    return source.replace(keyPattern, `${line}`);
  }

  const tablePattern = /^\s*\[[^\]]+\]\s*$/m;
  const match = tablePattern.exec(source);
  if (!match) {
    const trimmed = source.trimEnd();
    return trimmed.length > 0 ? `${trimmed}\n${line}\n` : `${line}\n`;
  }

  const before = source.slice(0, match.index).trimEnd();
  const after = source.slice(match.index);
  return `${before}\n${line}\n\n${after.replace(/^\n+/, "")}`;
}

export function createCodexLocalAuthSwitchService(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const osImpl = options.osImpl || os;
  const pathImpl = options.pathImpl || path;
  const extractOpenAICodexAccountId =
    typeof options.extractOpenAICodexAccountId === "function" ? options.extractOpenAICodexAccountId : () => "";

  function resolveCodexCliPaths(explicitPaths = {}) {
    const codexHome =
      String(explicitPaths.codexHome || process.env.CODEX_HOME || "").trim() ||
      pathImpl.join(osImpl.homedir(), ".codex");
    return {
      codexHome,
      authJsonPath: explicitPaths.authJsonPath || pathImpl.join(codexHome, "auth.json"),
      configTomlPath: explicitPaths.configTomlPath || pathImpl.join(codexHome, "config.toml")
    };
  }

  async function switchLocalCodexToChatgptAccount(input = {}) {
    const token = ensurePlainObject(input.token);
    const accessToken = String(token.access_token || "").trim();
    const refreshToken = String(token.refresh_token || "").trim();
    if (!accessToken) {
      const err = new Error("Selected account has no access_token.");
      err.code = "missing_access_token";
      throw err;
    }
    if (!refreshToken) {
      const err = new Error("Selected account has no refresh_token, so local ChatGPT auth cannot be seeded.");
      err.code = "missing_refresh_token";
      throw err;
    }

    const accountId =
      String(input.accountId || "").trim() || String(extractOpenAICodexAccountId(accessToken) || "").trim();
    if (!accountId) {
      const err = new Error("Could not resolve account_id from the selected pooled token.");
      err.code = "missing_account_id";
      throw err;
    }

    const nowIso = input.now instanceof Date ? input.now.toISOString() : new Date().toISOString();
    const paths = resolveCodexCliPaths(input.paths);
    const authJsonText = await readOptionalText(fsImpl, paths.authJsonPath);
    const configTomlText = await readOptionalText(fsImpl, paths.configTomlPath);
    const existingAuth = parseOptionalJson(authJsonText, paths.authJsonPath);
    const existingMatchingTokens = resolveExistingMatchingTokens(existingAuth, accountId, extractOpenAICodexAccountId);
    const idTokenResolution = resolveIdTokenForAccount({
      token,
      existingAuth,
      accountId,
      extractOpenAICodexAccountId
    });
    const resolvedRefreshToken =
      String(existingMatchingTokens?.refresh_token || "").trim() || refreshToken;
    const expiresAt = toNonNegativeIntegerNumber(token.expires_at);

    const nextAuth = {
      ...existingAuth,
      auth_mode: "chatgpt",
      tokens: {
        ...ensurePlainObject(existingAuth.tokens),
        access_token: accessToken,
        refresh_token: resolvedRefreshToken,
        id_token: idTokenResolution.idToken,
        account_id: accountId,
        ...(token.token_type ? { token_type: token.token_type } : {}),
        ...(token.scope ? { scope: token.scope } : {}),
        ...(expiresAt !== null ? { expires_at: expiresAt } : {})
      },
      last_refresh: nowIso
    };
    delete nextAuth.OPENAI_API_KEY;

    let nextConfigToml = upsertTopLevelTomlString(configTomlText, "forced_login_method", "chatgpt");
    nextConfigToml = upsertTopLevelTomlString(nextConfigToml, "cli_auth_credentials_store", "file");

    await fsImpl.mkdir(pathImpl.dirname(paths.authJsonPath), { recursive: true });
    await fsImpl.mkdir(pathImpl.dirname(paths.configTomlPath), { recursive: true });
    await fsImpl.writeFile(paths.authJsonPath, JSON.stringify(nextAuth, null, 2), "utf8");
    await fsImpl.writeFile(paths.configTomlPath, nextConfigToml, "utf8");

    return {
      ok: true,
      authMode: "chatgpt",
      forcedLoginMethod: "chatgpt",
      credentialStore: "file",
      accountId,
      authJsonPath: paths.authJsonPath,
      configTomlPath: paths.configTomlPath,
      usedExistingIdTokenFallback: idTokenResolution.usedExistingIdTokenFallback
    };
  }

  return {
    resolveCodexCliPaths,
    switchLocalCodexToChatgptAccount,
    upsertTopLevelTomlString
  };
}
