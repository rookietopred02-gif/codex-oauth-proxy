import assert from "node:assert/strict";
import test from "node:test";

import { createDashboardI18n } from "../public/app/i18n.js";
import { formatDashboardDateTime, getDashboardDateLocale } from "../public/dashboard/date-time.js";

class FakeDateTimeFormat {
  constructor(locale, options = {}) {
    this.locale = locale;
    this.options = options;
  }

  format(date) {
    return [
      this.locale,
      String(this.options.hour12),
      String(this.options.dateStyle || ""),
      String(this.options.timeStyle || ""),
      String(date.getTime())
    ].join("|");
  }
}

class ThrowingDateTimeFormat {
  constructor() {
    throw new Error("date formatter unavailable");
  }
}

test("getDashboardDateLocale maps dashboard languages to Intl locales", () => {
  assert.equal(getDashboardDateLocale("zh-hans"), "zh-CN");
  assert.equal(getDashboardDateLocale("zh-hant"), "zh-TW");
  assert.equal(getDashboardDateLocale("zh-CN"), "zh-CN");
  assert.equal(getDashboardDateLocale("ZH_HANS"), "zh-CN");
  assert.equal(getDashboardDateLocale("zh-TW"), "zh-TW");
  assert.equal(getDashboardDateLocale("zh-Hant"), "zh-TW");
  assert.equal(getDashboardDateLocale("en"), "en-US");
  assert.equal(getDashboardDateLocale("en-GB"), "en-US");
  assert.equal(getDashboardDateLocale("unknown"), "en-US");
});

test("formatDashboardDateTime uses the selected dashboard language", () => {
  const ts = Date.UTC(2026, 3, 14, 10, 30, 0);

  assert.equal(
    formatDashboardDateTime(ts, "zh-hans", { dateStyle: "medium", timeStyle: "short" }, FakeDateTimeFormat),
    `zh-CN|false|medium|short|${ts}`
  );
  assert.equal(
    formatDashboardDateTime(new Date(ts), "zh-hant", { dateStyle: "short" }, FakeDateTimeFormat),
    `zh-TW|false|short||${ts}`
  );
  assert.equal(
    formatDashboardDateTime(ts, "en", { timeStyle: "medium" }, FakeDateTimeFormat),
    `en-US|true||medium|${ts}`
  );
  assert.equal(
    formatDashboardDateTime(ts, "unknown", { timeStyle: "short" }, FakeDateTimeFormat),
    `en-US|true||short|${ts}`
  );
});

test("formatDashboardDateTime respects i18n-normalized language aliases", () => {
  const ts = Date.UTC(2026, 3, 14, 10, 30, 0);

  for (const [alias, expected] of [
    ["zh_tw", "zh-TW"],
    ["zh-cn", "zh-CN"],
    ["sc", "zh-CN"]
  ]) {
    const i18n = createDashboardI18n();
    i18n.setLanguage(alias);

    assert.equal(
      formatDashboardDateTime(ts, i18n.getLanguage(), { timeStyle: "short" }, FakeDateTimeFormat),
      `${expected}|false||short|${ts}`
    );
  }
});

test("formatDashboardDateTime preserves explicit option overrides and invalid fallback", () => {
  const ts = Date.UTC(2026, 3, 14, 10, 30, 0);

  assert.equal(formatDashboardDateTime("not-a-date", "en", {}, FakeDateTimeFormat), "-");
  assert.equal(formatDashboardDateTime("1770000000123.5", "en", {}, FakeDateTimeFormat), "-");
  assert.equal(formatDashboardDateTime(1770000000123.5, "en", {}, FakeDateTimeFormat), "-");
  assert.equal(formatDashboardDateTime("-1", "en", {}, FakeDateTimeFormat), "-");
  assert.equal(formatDashboardDateTime(-1, "en", {}, FakeDateTimeFormat), "-");
  assert.equal(formatDashboardDateTime(true, "en", {}, FakeDateTimeFormat), "-");
  assert.equal(formatDashboardDateTime(Symbol("bad-date"), "en", {}, FakeDateTimeFormat), "-");
  assert.equal(
    formatDashboardDateTime(
      {
        valueOf() {
          return ts;
        }
      },
      "en",
      {},
      FakeDateTimeFormat
    ),
    "-"
  );
  assert.equal(
    formatDashboardDateTime(
      {
        valueOf() {
          throw new Error("coercion failed");
        }
      },
      "en",
      {},
      FakeDateTimeFormat
    ),
    "-"
  );
  assert.equal(
    formatDashboardDateTime(ts, "en", { hour12: false, timeStyle: "short" }, FakeDateTimeFormat),
    `en-US|false||short|${ts}`
  );
  assert.equal(formatDashboardDateTime(ts, "en", { timeStyle: "short" }, ThrowingDateTimeFormat), "-");
});
