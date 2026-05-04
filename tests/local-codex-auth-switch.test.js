import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexLocalAuthSwitchService } from "../src/services/codex-local-auth-switch.js";
import { normalizeToken } from "../src/server/store-utils.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-local-auth-switch-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("switchLocalCodexToChatgptAccount rewrites local auth.json and config.toml for ChatGPT auth", async () => {
  await withTempDir(async (dir) => {
    const service = createCodexLocalAuthSwitchService({
      extractOpenAICodexAccountId() {
        return "acct_from_access";
      }
    });
    const authJsonPath = path.join(dir, "auth.json");
    const configTomlPath = path.join(dir, "config.toml");

    await fs.writeFile(
      authJsonPath,
      JSON.stringify(
        {
          auth_mode: "apikey",
          OPENAI_API_KEY: "sk-test",
          tokens: {
            access_token: "old_access",
            refresh_token: "old_refresh",
            id_token: "old_id",
            account_id: "acct_other"
          }
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(configTomlPath, 'forced_login_method = "api"\nmodel = "gpt-5.4"\n', "utf8");

    const result = await service.switchLocalCodexToChatgptAccount({
      token: {
        access_token: "new_access",
        refresh_token: "new_refresh",
        id_token: "new_id",
        token_type: "bearer",
        scope: "openid profile email offline_access",
        expires_at: 1777777777
      },
      accountId: "acct_switch",
      paths: { authJsonPath, configTomlPath },
      now: new Date("2026-04-18T12:34:56.000Z")
    });

    const savedAuth = JSON.parse(await fs.readFile(authJsonPath, "utf8"));
    const savedConfig = await fs.readFile(configTomlPath, "utf8");

    assert.equal(result.ok, true);
    assert.equal(result.accountId, "acct_switch");
    assert.equal(savedAuth.auth_mode, "chatgpt");
    assert.equal(savedAuth.OPENAI_API_KEY, undefined);
    assert.equal(savedAuth.tokens.access_token, "new_access");
    assert.equal(savedAuth.tokens.refresh_token, "new_refresh");
    assert.equal(savedAuth.tokens.id_token, "new_id");
    assert.equal(savedAuth.tokens.account_id, "acct_switch");
    assert.equal(savedAuth.last_refresh, "2026-04-18T12:34:56.000Z");
    assert.match(savedConfig, /^forced_login_method = "chatgpt"$/m);
    assert.match(savedConfig, /^cli_auth_credentials_store = "file"$/m);
  });
});

test("switchLocalCodexToChatgptAccount can reuse the existing local id_token when the selected account matches", async () => {
  await withTempDir(async (dir) => {
    const service = createCodexLocalAuthSwitchService({
      extractOpenAICodexAccountId(accessToken) {
        return accessToken === "existing_access" ? "acct_match" : "";
      }
    });
    const authJsonPath = path.join(dir, "auth.json");
    const configTomlPath = path.join(dir, "config.toml");

    await fs.writeFile(
      authJsonPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: {
            access_token: "existing_access",
            refresh_token: "existing_refresh",
            id_token: "existing_id",
            account_id: "acct_match"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await service.switchLocalCodexToChatgptAccount({
      token: {
        access_token: "pool_access",
        refresh_token: "pool_refresh"
      },
      accountId: "acct_match",
      paths: { authJsonPath, configTomlPath }
    });

    const savedAuth = JSON.parse(await fs.readFile(authJsonPath, "utf8"));
    assert.equal(result.usedExistingIdTokenFallback, true);
    assert.equal(savedAuth.tokens.id_token, "existing_id");
    assert.equal(savedAuth.tokens.access_token, "pool_access");
    assert.equal(savedAuth.tokens.refresh_token, "existing_refresh");
  });
});

test("switchLocalCodexToChatgptAccount rejects accounts without any usable id_token", async () => {
  await withTempDir(async (dir) => {
    const service = createCodexLocalAuthSwitchService({
      extractOpenAICodexAccountId() {
        return "acct_target";
      }
    });
    const authJsonPath = path.join(dir, "auth.json");
    await fs.writeFile(
      authJsonPath,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: {
            access_token: "other_access",
            refresh_token: "other_refresh",
            id_token: "other_id",
            account_id: "acct_other"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    await assert.rejects(
      () =>
        service.switchLocalCodexToChatgptAccount({
          token: {
            access_token: "pool_access",
            refresh_token: "pool_refresh"
          },
          accountId: "acct_target",
          paths: { authJsonPath, configTomlPath: path.join(dir, "config.toml") }
        }),
      /reusable ChatGPT token bundle|reusable ChatGPT session/i
    );
  });
});

test("normalizeToken preserves id_token across stored pool tokens", () => {
  const normalized = normalizeToken(
    {
      access_token: "access_next",
      refresh_token: "refresh_next",
      id_token: "id_next",
      expires_in: 3600
    },
    {
      access_token: "access_old",
      refresh_token: "refresh_old",
      id_token: "id_old"
    }
  );
  assert.equal(normalized.id_token, "id_next");

  const preserved = normalizeToken(
    {
      access_token: "access_next",
      refresh_token: "refresh_next",
      expires_in: 3600
    },
    {
      access_token: "access_old",
      refresh_token: "refresh_old",
      id_token: "id_old"
    }
  );
  assert.equal(preserved.id_token, "id_old");
});
