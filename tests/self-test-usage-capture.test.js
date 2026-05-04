import assert from "node:assert/strict";
import test from "node:test";

test("direct self-test captures codex usage headers back into the pooled account store", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init = {}) => {
      assert.equal(init?.headers?.["accept-encoding"], "identity");
      return new Response(
        'event: response.completed\n' +
          'data: {"type":"response.completed","response":{"id":"resp_self_test","status":"completed","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n',
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "x-codex-plan-type": "team",
            "x-codex-primary-used-percent": "25",
            "x-codex-primary-reset-at": "1710000000",
            "x-codex-primary-window-minutes": "300",
            "x-codex-secondary-used-percent": "60",
            "x-codex-secondary-reset-at": "1710600000",
            "x-codex-secondary-window-minutes": "10080"
          }
        }
      );
    };

    const serverModule = await import(`../src/server.js?self-test-usage=${Date.now()}`);
    const testing = serverModule.__testing;
    const previousConfig = {
      authMode: testing.config.authMode,
      upstreamMode: testing.config.upstreamMode,
      multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
      multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy,
      multiAccountPoolFilter: testing.config.codexOAuth.multiAccountPoolFilter,
      defaultModel: testing.config.codex.defaultModel
    };

    try {
      testing.config.authMode = "codex-oauth";
      testing.config.upstreamMode = "codex-chatgpt";
      testing.config.codexOAuth.multiAccountEnabled = true;
      testing.config.codexOAuth.multiAccountStrategy = "sticky";
      testing.config.codexOAuth.multiAccountPoolFilter = "all";
      testing.config.codex.defaultModel = "gpt-5.4";

      testing.setCodexOAuthStore({
        token: {
          access_token: "token_a",
          expires_at: Math.floor(Date.now() / 1000) + 3600
        },
        accounts: [
          {
            identity_id: "entry_a",
            account_id: "acct_a",
            enabled: true,
            token: {
              access_token: "token_a",
              expires_at: Math.floor(Date.now() / 1000) + 3600
            },
            usage_snapshot: null,
            usage_updated_at: 0
          }
        ],
        active_account_id: "entry_a",
        rotation: { next_index: 0 }
      });

      const result = await testing.runDirectChatCompletionTest("Say hi.");
      const store = testing.getCodexOAuthStore();
      const account = Array.isArray(store?.accounts) ? store.accounts[0] : null;

      assert.equal(result.status, "completed");
      assert.equal(result.preview, "done");
      assert.equal(account?.usage_snapshot?.plan_type, "team");
      assert.equal(account?.usage_snapshot?.primary?.used_percent, 25);
      assert.equal(account?.usage_snapshot?.primary?.remaining_percent, 75);
      assert.equal(account?.usage_snapshot?.primary?.window_minutes, 300);
      assert.equal(account?.usage_snapshot?.secondary?.used_percent, 60);
      assert.equal(account?.usage_snapshot?.secondary?.remaining_percent, 40);
      assert.equal(account?.usage_snapshot?.secondary?.window_minutes, 10080);
    } finally {
      testing.config.authMode = previousConfig.authMode;
      testing.config.upstreamMode = previousConfig.upstreamMode;
      testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
      testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
      testing.config.codexOAuth.multiAccountPoolFilter = previousConfig.multiAccountPoolFilter;
      testing.config.codex.defaultModel = previousConfig.defaultModel;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
