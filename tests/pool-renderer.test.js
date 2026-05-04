import assert from "node:assert/strict";
import test from "node:test";

import { createPoolRenderer } from "../public/app/renderers/pool.js";

function createRenderer() {
  return createPoolRenderer({
    t(key) {
      return key;
    },
    tt(key, vars = {}) {
      if (key === "quota_refresh_at") {
        return `quota_refresh_at:${vars.time}`;
      }
      return key;
    },
    escapeHtml(value) {
      return String(value || "");
    },
    fmtUnixSec(value) {
      return String(value || 0);
    },
    fmtCooldown(value) {
      return String(value || 0);
    },
    shortId(value) {
      return String(value || "");
    }
  });
}

test("pool renderer keeps switch-to-this-account enabled for disabled accounts to allow force switching", () => {
  const renderer = createRenderer();
  const html = renderer.buildAccountCardHtml(
    {
      entryId: "entry_disabled",
      accountId: "acct_disabled",
      label: "Disabled account",
      enabled: false,
      healthStatus: "disabled",
      cooldownUntil: 0,
      failureCount: 5,
      lastError: "token_invalidated"
    },
    "entry_active",
    true
  );

  assert.match(html, /data-switch-entry="entry_disabled"/);
  assert.match(html, /class="secondary account-switch-btn"[\s\S]*title="account_title_switch_tooltip_enabled"/);
  assert.doesNotMatch(html, /class="secondary account-switch-btn"[\s\S]*?\sdisabled(\s|>)/);
});

test("pool renderer shows distinct 5h and weekly quota refresh times", () => {
  const renderer = createRenderer();
  const html = renderer.buildAccountCardHtml(
    {
      entryId: "entry_team",
      accountId: "acct_team",
      label: "Team account",
      enabled: true,
      usageSnapshot: {
        plan_type: "team",
        fetched_at: 100,
        primary: {
          remaining_percent: 80,
          window_minutes: 300,
          reset_at: 111
        },
        secondary: {
          remaining_percent: 65,
          window_minutes: 10080,
          reset_at: 222
        }
      }
    },
    "entry_other",
    true
  );

  assert.match(html, /limit_5h/);
  assert.match(html, /limit_weekly/);
  assert.match(html, /quota_refresh_at:111/);
  assert.match(html, /quota_refresh_at:222/);
});

test("pool renderer derives quota refresh time from reset_after_seconds when reset_at is absent", () => {
  const renderer = createRenderer();
  const usageView = renderer.resolveUsageWindows({
    usageUpdatedAt: 500,
    usageSnapshot: {
      plan_type: "team",
      primary: {
        remaining_percent: 70,
        window_minutes: 300,
        reset_after_seconds: 3600
      }
    }
  });

  assert.equal(usageView.primaryRefreshAt, 4100);
});

test("pool renderer collapses free plans to a single weekly refresh window", () => {
  const renderer = createRenderer();
  const usageView = renderer.resolveUsageWindows({
    usageUpdatedAt: 500,
    usageSnapshot: {
      plan_type: "free",
      primary: {
        remaining_percent: 40,
        window_minutes: 300,
        reset_at: 111
      },
      secondary: {
        remaining_percent: 90,
        window_minutes: 10080,
        reset_at: 222
      }
    }
  });

  assert.equal(usageView.singleWindowMode, true);
  assert.equal(usageView.primaryLabel, "limit_weekly");
  assert.equal(usageView.primaryRefreshAt, 222);
  assert.equal(usageView.secondaryRefreshAt, null);
});
