import assert from "node:assert/strict";
import test from "node:test";

import { createDashboardI18n } from "../public/app/i18n.js";

test("dashboard i18n keeps quota refresh text localized for zh-hans", () => {
  const i18n = createDashboardI18n();

  assert.equal(i18n.normalizeUiLang("zh-cn"), "zh-hans");
  i18n.setLanguage("zh-hans");

  assert.equal(i18n.tt("quota_refresh_at", { time: "2026-04-14 10:00" }), "刷新时间 2026-04-14 10:00");
});
