import assert from "node:assert/strict";
import test from "node:test";

import { extractCodexOAuthImportItems } from "../src/codex-auth-pool-import.js";

const ACCESS_TOKEN_A = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0X2EiLCJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIn0",
  "signaturea"
].join(".");
const ACCESS_TOKEN_B = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0X2IiLCJlbWFpbCI6ImJvYkBleGFtcGxlLmNvbSJ9",
  "signatureb"
].join(".");
const ID_TOKEN_A = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJzdWIiOiJhbGljZS1pZC10b2tlbiIsImVtYWlsIjoiYWxpY2VAZXhhbXBsZS5jb20ifQ",
  "idtokena"
].join(".");
const ID_TOKEN_B = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJzdWIiOiJib2ItaWQtdG9rZW4iLCJlbWFpbCI6ImJvYkBleGFtcGxlLmNvbSJ9",
  "idtokenb"
].join(".");
const REFRESH_TOKEN_A = "refresh_token_value_a_abcdefghijklmnopqrstuvwxyz0123456789";
const REFRESH_TOKEN_B = "refresh_token_value_b_abcdefghijklmnopqrstuvwxyz0123456789";

test("extractCodexOAuthImportItems reads exported json payload files", () => {
  const items = extractCodexOAuthImportItems({
    files: [
      {
        name: "slot-1.json",
        content: JSON.stringify({
          payload: {
            label: "Alice",
            access_token: ACCESS_TOKEN_A,
            refresh_token: REFRESH_TOKEN_A,
            expires_at: 1711111111
          }
        })
      }
    ]
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].label, "Alice");
  assert.equal(items[0].access_token, ACCESS_TOKEN_A);
  assert.equal(items[0].refresh_token, REFRESH_TOKEN_A);
  assert.equal(items[0].expires_at, 1711111111);
});

test("extractCodexOAuthImportItems reads sub2api account bundles", () => {
  const items = extractCodexOAuthImportItems({
    files: [
      {
        name: "sub2api.json",
        content: JSON.stringify({
          type: "sub2api-data",
          accounts: [
            {
              label: "Bob",
              enabled: false,
              slot: 4,
              usage_snapshot: { plan_type: "plus" },
              credentials: {
                access_token: ACCESS_TOKEN_B,
                refresh_token: REFRESH_TOKEN_B,
                expires_at: 1722222222
              }
            }
          ]
        })
      }
    ]
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].label, "Bob");
  assert.equal(items[0].enabled, false);
  assert.equal(items[0].slot, 4);
  assert.equal(items[0].plan_type, "plus");
  assert.deepEqual(items[0].usage_snapshot, { plan_type: "plus" });
  assert.equal(items[0].access_token, ACCESS_TOKEN_B);
});

test("extractCodexOAuthImportItems reads csv rows with token fields", () => {
  const items = extractCodexOAuthImportItems({
    files: [
      {
        name: "tokens.csv",
        content: [
          "label,access_token,id_token,refresh_token,enabled,slot,plan_type",
          `Carol,${ACCESS_TOKEN_A},${ID_TOKEN_A},${REFRESH_TOKEN_A},false,2,pro`
        ].join("\n")
      }
    ]
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].label, "Carol");
  assert.equal(items[0].enabled, false);
  assert.equal(items[0].slot, 2);
  assert.equal(items[0].plan_type, "pro");
  assert.equal(items[0].access_token, ACCESS_TOKEN_A);
  assert.equal(items[0].id_token, ID_TOKEN_A);
});

test("extractCodexOAuthImportItems reads CPA style delimited text rows", () => {
  const items = extractCodexOAuthImportItems({
    files: [
      {
        name: "accounts.cpa",
        content: `dave@example.com----hunter2----${ACCESS_TOKEN_A}----${REFRESH_TOKEN_A}`
      }
    ]
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].label, "dave@example.com");
  assert.equal(items[0].refresh_token, REFRESH_TOKEN_A);
  assert.equal(items[0].access_token, ACCESS_TOKEN_A);
});

test("extractCodexOAuthImportItems reads single-file key value credentials", () => {
  const items = extractCodexOAuthImportItems({
    files: [
      {
        name: "single.txt",
        content: [
          "label = Eve",
          `access_token = ${ACCESS_TOKEN_B}`,
          `id_token = ${ID_TOKEN_B}`,
          `refresh_token = ${REFRESH_TOKEN_B}`,
          "enabled = true",
          "slot = 7"
        ].join("\n")
      }
    ]
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].label, "Eve");
  assert.equal(items[0].enabled, true);
  assert.equal(items[0].slot, 7);
  assert.equal(items[0].access_token, ACCESS_TOKEN_B);
  assert.equal(items[0].id_token, ID_TOKEN_B);
});

test("extractCodexOAuthImportItems ignores id_token-only key value credentials", () => {
  const items = extractCodexOAuthImportItems({
    files: [
      {
        name: "id-token-only.txt",
        content: [
          "label = Frank",
          `id_token = ${ID_TOKEN_A}`,
          `refresh_token = ${REFRESH_TOKEN_A}`
        ].join("\n")
      }
    ]
  });

  assert.deepEqual(items, []);
});
