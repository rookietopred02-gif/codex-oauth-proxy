function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBooleanLike(value) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return null;
  if (["true", "1", "yes", "y", "on", "enabled"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off", "disabled"].includes(normalized)) return false;
  return null;
}

function normalizeIntegerLike(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function normalizeImportFieldName(value) {
  const normalized = normalizeString(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!normalized) return "";
  if (["accesstoken", "token", "bearer"].includes(normalized)) return "access_token";
  if (normalized === "idtoken") return "id_token";
  if (["refreshtoken", "refresh"].includes(normalized)) return "refresh_token";
  if (["tokentype", "type"].includes(normalized)) return "token_type";
  if (["expiresat", "expireat", "expiry", "expiryat", "exp"].includes(normalized)) return "expires_at";
  if (["expiresin", "expirein", "ttl"].includes(normalized)) return "expires_in";
  if (["accountid", "chatgptaccountid"].includes(normalized)) return "account_id";
  if (["entryid", "identityid", "principalid"].includes(normalized)) return "entry_id";
  if (["plantype", "plan"].includes(normalized)) return "plan_type";
  if (["usagesnapshot", "usage"].includes(normalized)) return "usage_snapshot";
  if (["slot", "index", "position"].includes(normalized)) return "slot";
  if (["label", "name", "nickname", "title"].includes(normalized)) return "label";
  if (["email", "mail", "username", "user"].includes(normalized)) return "email";
  if (["enabled", "active"].includes(normalized)) return "enabled";
  if (["force", "replace"].includes(normalized)) return "force";
  if (["scope"].includes(normalized)) return "scope";
  if (["password", "pass"].includes(normalized)) return "password";
  return "";
}

function looksLikeJwt(value) {
  const normalized = normalizeString(value);
  return normalized.length >= 60 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(normalized);
}

function looksLikeOpaqueToken(value) {
  const normalized = normalizeString(value);
  return normalized.length >= 24 && /^[A-Za-z0-9._~+/=-]+$/.test(normalized);
}

function looksLikeAccessToken(value) {
  return looksLikeJwt(value) || normalizeString(value).startsWith("eyJ");
}

function looksLikeRefreshToken(value) {
  const normalized = normalizeString(value);
  return looksLikeOpaqueToken(normalized) && !looksLikeAccessToken(normalized);
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeString(value));
}

function basenameWithoutExtension(name) {
  const normalized = normalizeString(name);
  if (!normalized) return "";
  return normalized.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
}

function parseMaybeJsonObject(value) {
  if (isPlainObject(value)) return value;
  const text = normalizeString(value);
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return null;
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractPortableMetadata(source) {
  if (!isPlainObject(source)) return {};
  const metadata = {};
  const label =
    normalizeString(source.label) ||
    normalizeString(source.name) ||
    normalizeString(source.email) ||
    normalizeString(source.username);
  if (label) metadata.label = label;

  const email = normalizeString(source.email);
  if (email) metadata.email = email;

  const accountId = normalizeString(source.account_id || source.accountId);
  if (accountId) metadata.account_id = accountId;

  const entryId = normalizeString(
    source.entry_id || source.entryId || source.identity_id || source.identityId || source.principal_id
  );
  if (entryId) metadata.entry_id = entryId;

  const slot = normalizeIntegerLike(source.slot);
  if (slot !== null) metadata.slot = slot;

  const enabled = normalizeBooleanLike(source.enabled);
  if (enabled !== null) metadata.enabled = enabled;

  const force = normalizeBooleanLike(source.force);
  if (force !== null) metadata.force = force;

  const planType =
    normalizeString(source.plan_type || source.planType) ||
    normalizeString(source.usage_snapshot?.plan_type || source.usageSnapshot?.plan_type);
  if (planType) metadata.plan_type = planType;

  const usageSnapshot =
    parseMaybeJsonObject(source.usage_snapshot || source.usageSnapshot) ||
    (isPlainObject(source.usage_snapshot) ? source.usage_snapshot : null) ||
    (isPlainObject(source.usageSnapshot) ? source.usageSnapshot : null);
  if (usageSnapshot) metadata.usage_snapshot = usageSnapshot;

  const expiresAt = normalizeIntegerLike(source.expires_at || source.expiresAt);
  if (expiresAt !== null) metadata.expires_at = expiresAt;

  const expiresIn = normalizeIntegerLike(source.expires_in || source.expiresIn);
  if (expiresIn !== null) metadata.expires_in = expiresIn;

  return metadata;
}

function normalizeParsedTokenCandidate(raw, fallbackLabel = "") {
  if (!isPlainObject(raw)) return null;

  const accessToken = normalizeString(raw.access_token || raw.accessToken);
  if (!accessToken) return null;

  const candidate = {
    access_token: accessToken
  };

  const refreshToken = normalizeString(raw.refresh_token || raw.refreshToken);
  if (refreshToken) candidate.refresh_token = refreshToken;

  const tokenType = normalizeString(raw.token_type || raw.tokenType);
  if (tokenType) candidate.token_type = tokenType;

  const scope = normalizeString(raw.scope);
  if (scope) candidate.scope = scope;

  const label =
    normalizeString(raw.label) ||
    normalizeString(raw.email) ||
    normalizeString(raw.name) ||
    normalizeString(fallbackLabel);
  if (label) candidate.label = label;

  const accountId = normalizeString(raw.account_id || raw.accountId);
  if (accountId) candidate.account_id = accountId;

  const entryId = normalizeString(raw.entry_id || raw.entryId || raw.identity_id || raw.identityId);
  if (entryId) candidate.entry_id = entryId;

  const planType = normalizeString(raw.plan_type || raw.planType);
  if (planType) candidate.plan_type = planType;

  const slot = normalizeIntegerLike(raw.slot);
  if (slot !== null) candidate.slot = slot;

  const enabled = normalizeBooleanLike(raw.enabled);
  if (enabled !== null) candidate.enabled = enabled;

  const force = normalizeBooleanLike(raw.force);
  if (force !== null) candidate.force = force;

  const expiresAt = normalizeIntegerLike(raw.expires_at || raw.expiresAt);
  if (expiresAt !== null) candidate.expires_at = expiresAt;

  const expiresIn = normalizeIntegerLike(raw.expires_in || raw.expiresIn);
  if (expiresIn !== null) candidate.expires_in = expiresIn;

  const usageSnapshot =
    parseMaybeJsonObject(raw.usage_snapshot || raw.usageSnapshot) ||
    (isPlainObject(raw.usage_snapshot) ? raw.usage_snapshot : null) ||
    (isPlainObject(raw.usageSnapshot) ? raw.usageSnapshot : null);
  if (usageSnapshot) candidate.usage_snapshot = usageSnapshot;

  const idToken = normalizeString(raw.id_token || raw.idToken);
  if (idToken) candidate.id_token = idToken;

  return candidate;
}

function pushNormalizedCandidate(out, raw, fallbackLabel = "") {
  const normalized = normalizeParsedTokenCandidate(raw, fallbackLabel);
  if (normalized) out.push(normalized);
}

function collectTokenCandidatesFromValue(value, out, metadata = {}, seen = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectTokenCandidatesFromValue(entry, out, metadata, seen);
    }
    return;
  }
  if (!isPlainObject(value) || seen.has(value)) return;
  seen.add(value);

  const nextMetadata = { ...metadata, ...extractPortableMetadata(value) };
  pushNormalizedCandidate(out, { ...nextMetadata, ...value }, nextMetadata.label || "");

  const nestedObjects = ["payload", "token", "credentials", "auth", "oauth", "data"];
  for (const key of nestedObjects) {
    if (isPlainObject(value[key])) {
      collectTokenCandidatesFromValue(value[key], out, nextMetadata, seen);
    }
  }

  const nestedCollections = ["tokens", "accounts", "items", "data", "records", "rows"];
  for (const key of nestedCollections) {
    if (Array.isArray(value[key])) {
      collectTokenCandidatesFromValue(value[key], out, nextMetadata, seen);
    }
  }
}

function flattenTokenCandidates(items) {
  const out = [];
  collectTokenCandidatesFromValue(Array.isArray(items) ? items : [], out);
  return out;
}

const DEFAULT_USAGE_PROBE_CONCURRENCY = 4;

function clampConcurrency(value, fallback = DEFAULT_USAGE_PROBE_CONCURRENCY) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(12, Math.floor(n)));
}

async function runWithConcurrency(items, concurrency, worker) {
  const queue = Array.isArray(items) ? items : [];
  if (queue.length === 0) return;

  let cursor = 0;
  const workerCount = Math.min(queue.length, clampConcurrency(concurrency));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < queue.length) {
        const index = cursor;
        cursor += 1;
        await worker(queue[index], index);
      }
    })
  );
}

function splitCsvRow(text, delimiter) {
  const out = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\"") {
      const nextChar = text[i + 1];
      if (inQuotes && nextChar === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === delimiter && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.map((value) => value.trim());
}

function parseDelimitedRows(text, delimiter) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => splitCsvRow(line, delimiter));
}

function parseCsvTokenCandidates(text, fileName = "") {
  const firstLine = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return [];

  const delimiterCandidates = [",", ";", "\t", "|"];
  const delimiter = delimiterCandidates
    .map((candidate) => ({
      candidate,
      score: firstLine.split(candidate).length - 1
    }))
    .sort((left, right) => right.score - left.score)[0];

  if (!delimiter || delimiter.score <= 0) return [];

  const rows = parseDelimitedRows(text, delimiter.candidate);
  if (rows.length < 2) return [];

  const headers = rows[0].map((header) => normalizeImportFieldName(header));
  if (!headers.some(Boolean)) return [];

  const out = [];
  for (const row of rows.slice(1)) {
    const record = {};
    for (let index = 0; index < headers.length; index += 1) {
      const key = headers[index];
      if (!key) continue;
      const value = row[index];
      if (!normalizeString(value)) continue;
      record[key] = value;
    }
    pushNormalizedCandidate(out, record, basenameWithoutExtension(fileName));
  }
  return out;
}

function parseKeyValueTokenBlocks(text, fileName = "") {
  const blocks = String(text || "")
    .split(/\r?\n\s*\r?\n/g)
    .map((block) => block.trim())
    .filter(Boolean);
  const out = [];

  for (const block of blocks) {
    const record = {};
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*[:=]\s*(.+?)\s*$/);
      if (!match) continue;
      const key = normalizeImportFieldName(match[1]);
      if (!key) continue;
      record[key] = match[2];
    }
    pushNormalizedCandidate(out, record, basenameWithoutExtension(fileName));
  }

  return out;
}

function parseFlatDelimitedTokenLines(text, fileName = "") {
  const out = [];
  const separators = ["----", "|", "\t", ",", ":"];

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    let parts = null;
    for (const separator of separators) {
      const next = line.split(separator).map((part) => part.trim()).filter(Boolean);
      if (next.length >= 2) {
        parts = next;
        break;
      }
    }
    if (!parts || parts.length < 2) continue;

    let accessToken = parts.find((part) => looksLikeAccessToken(part)) || "";
    if (!accessToken) {
      const fallbackCandidates = parts.filter((part) => looksLikeOpaqueToken(part));
      accessToken = fallbackCandidates.sort((left, right) => right.length - left.length)[0] || "";
    }
    if (!accessToken) continue;

    const refreshToken =
      parts.find((part) => part !== accessToken && looksLikeRefreshToken(part)) ||
      parts.find((part) => part !== accessToken && looksLikeOpaqueToken(part)) ||
      "";
    const email = parts.find((part) => looksLikeEmail(part)) || "";
    const planType = parts.find((part) => /^(free|plus|pro|team|enterprise)$/i.test(part)) || "";

    pushNormalizedCandidate(
      out,
      {
        label: email || basenameWithoutExtension(fileName),
        email,
        plan_type: planType,
        access_token: accessToken,
        refresh_token: refreshToken
      },
      basenameWithoutExtension(fileName)
    );
  }

  return out;
}

function extractCodexOAuthImportItems({ items = [], files = [] } = {}) {
  const out = [...flattenTokenCandidates(items)];

  for (const rawFile of Array.isArray(files) ? files : []) {
    const fileName = normalizeString(rawFile?.name || rawFile?.fileName);
    const content = typeof rawFile?.content === "string" ? rawFile.content : "";
    const trimmed = content.trim();
    if (!trimmed) continue;

    let parsedFromFile = [];
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        parsedFromFile = flattenTokenCandidates([JSON.parse(trimmed)]);
      } catch {
        parsedFromFile = [];
      }
    }
    if (parsedFromFile.length === 0) {
      parsedFromFile = parseCsvTokenCandidates(content, fileName);
    }
    if (parsedFromFile.length === 0) {
      parsedFromFile = parseKeyValueTokenBlocks(content, fileName);
    }
    if (parsedFromFile.length === 0) {
      parsedFromFile = parseFlatDelimitedTokenLines(content, fileName);
    }
    for (const candidate of parsedFromFile) {
      out.push(candidate);
    }
  }

  return out;
}

export async function importCodexOAuthTokens({
  store,
  items,
  replace = false,
  probeUsage = true,
  probeUsageConcurrency = DEFAULT_USAGE_PROBE_CONCURRENCY,
  ensureStoreShape,
  normalizeToken,
  upsertAccount,
  findAccountByRef,
  refreshUsageSnapshot,
  normalizePlanType,
  parseSlotValue
}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("tokens[] is required.");
  }

  if (typeof ensureStoreShape !== "function") throw new Error("ensureStoreShape is required.");
  if (typeof normalizeToken !== "function") throw new Error("normalizeToken is required.");
  if (typeof upsertAccount !== "function") throw new Error("upsertAccount is required.");
  if (typeof findAccountByRef !== "function") throw new Error("findAccountByRef is required.");
  if (typeof refreshUsageSnapshot !== "function") throw new Error("refreshUsageSnapshot is required.");
  if (typeof normalizePlanType !== "function") throw new Error("normalizePlanType is required.");
  if (typeof parseSlotValue !== "function") throw new Error("parseSlotValue is required.");

  const normalized = ensureStoreShape(store);
  const nextStore = normalized?.store || { token: null, accounts: [] };

  if (replace) {
    nextStore.accounts = [];
    nextStore.active_account_id = null;
    nextStore.rotation = { next_index: 0 };
    nextStore.token = null;
  }

  let imported = 0;
  const importedRefs = [];
  for (const raw of flattenTokenCandidates(items)) {
    if (!raw || typeof raw !== "object") continue;

    const accessToken = String(raw.access_token || raw.accessToken || "").trim();
    if (!accessToken) continue;

    const rawUsageSnapshot =
      raw.usage_snapshot && typeof raw.usage_snapshot === "object"
        ? raw.usage_snapshot
        : raw.usageSnapshot && typeof raw.usageSnapshot === "object"
          ? raw.usageSnapshot
          : null;

    const upsert = upsertAccount(
      nextStore,
      normalizeToken(
        {
          access_token: accessToken,
          refresh_token: raw.refresh_token || raw.refreshToken || null,
          token_type: raw.token_type || raw.tokenType || "Bearer",
          scope: raw.scope || null,
          expires_at: raw.expires_at || raw.expiresAt || null,
          expires_in: raw.expires_in || raw.expiresIn || null
        },
        raw
      ),
      {
        label:
          (typeof raw.label === "string" && raw.label.trim()) ||
          (typeof raw.email === "string" && raw.email.trim()) ||
          (typeof raw.name === "string" && raw.name.trim()) ||
          "",
        slot: parseSlotValue(raw.slot),
        force: raw.force === true,
        planType:
          normalizePlanType(raw.plan_type) ||
          normalizePlanType(raw.planType) ||
          normalizePlanType(rawUsageSnapshot?.plan_type),
        usageSnapshot: rawUsageSnapshot,
        skipSlotNormalization: true
      }
    );

    if (raw.enabled === false) {
      const importedAccount = findAccountByRef(nextStore.accounts, upsert.entryId);
      if (importedAccount) importedAccount.enabled = false;
    }

    if (upsert.entryId) importedRefs.push(String(upsert.entryId));
    imported += 1;
  }

  if (imported === 0) {
    throw new Error("No valid token entries in tokens[].");
  }

  let usageProbed = 0;
  let usageProbeFailed = 0;
  const usageProbeErrors = [];
  if (probeUsage) {
    const probeTargets = [...new Set(importedRefs.filter(Boolean))]
      .map((ref) => ({ ref, account: findAccountByRef(nextStore.accounts, ref) }))
      .filter((entry) => entry.account && entry.account.enabled !== false);
    await runWithConcurrency(probeTargets, probeUsageConcurrency, async ({ ref }) => {
      try {
        const probe = await refreshUsageSnapshot(nextStore, ref);
        if (probe?.ok) {
          usageProbed += 1;
        } else {
          usageProbeFailed += 1;
          usageProbeErrors.push({
            entryId: probe?.entryId || ref,
            error: String(probe?.error || probe?.skipped || "usage_probe_failed")
          });
        }
      } catch (err) {
        usageProbeFailed += 1;
        usageProbeErrors.push({
          entryId: ref,
          error: String(err?.message || err || "usage_probe_failed")
        });
      }
    });
  }

  const renormalized = ensureStoreShape(nextStore);
  return {
    store: renormalized?.store || nextStore,
    imported,
    accountPoolSize: Array.isArray(nextStore.accounts) ? nextStore.accounts.length : 0,
    importedRefs,
    usageProbe: {
      enabled: probeUsage,
      probed: usageProbed,
      failed: usageProbeFailed,
      errors: usageProbeErrors
    }
  };
}

export { extractCodexOAuthImportItems, flattenTokenCandidates };
