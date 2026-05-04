import assert from "node:assert/strict";
import test from "node:test";

import { createCodexAccountIdentityHelpers } from "../src/runtime/codex-account-identity.js";

function encodeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString("base64url");
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${body}.signature`;
}

test("codex account identity helpers extract account, principal, plan, and email from JWT payloads", () => {
  const helpers = createCodexAccountIdentityHelpers({
    jwtClaimPath: "https://api.openai.com/auth"
  });
  const token = encodeJwt({
    sub: "sub_fallback",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_account_user_id: "principal_456",
      chatgpt_plan_type: "Pro Team"
    },
    "https://api.openai.com/profile": {
      email: "User@example.com"
    }
  });

  assert.deepEqual(helpers.decodeJwtPayload(token), {
    sub: "sub_fallback",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_account_user_id: "principal_456",
      chatgpt_plan_type: "Pro Team"
    },
    "https://api.openai.com/profile": {
      email: "User@example.com"
    }
  });
  assert.deepEqual(helpers.extractOpenAICodexAuthClaim(token), {
    chatgpt_account_id: "acct_123",
    chatgpt_account_user_id: "principal_456",
    chatgpt_plan_type: "Pro Team"
  });
  assert.equal(helpers.extractOpenAICodexAccountId(token), "acct_123");
  assert.equal(helpers.extractOpenAICodexPrincipalId(token), "principal_456");
  assert.equal(helpers.extractOpenAICodexPlanType(token), "pro-team");
  assert.equal(helpers.extractOpenAICodexEmail(token), "User@example.com");
  assert.deepEqual(helpers.extractOpenAICodexOrganizationIds(token), []);
});

test("codex account identity helpers fall back to subject or email-derived principal ids", () => {
  const helpers = createCodexAccountIdentityHelpers({
    jwtClaimPath: "https://api.openai.com/auth"
  });
  const subjectToken = encodeJwt({
    sub: "sub_123",
    "https://api.openai.com/auth": {},
    "https://api.openai.com/profile": {}
  });
  const emailToken = encodeJwt({
    "https://api.openai.com/auth": {},
    "https://api.openai.com/profile": {
      email: "Fallback@example.com"
    }
  });

  assert.equal(helpers.extractOpenAICodexPrincipalId(subjectToken), "sub_123");
  assert.equal(helpers.extractOpenAICodexPrincipalId(emailToken), "email:fallback@example.com");
  assert.equal(helpers.extractOpenAICodexPlanType(subjectToken), null);
});

test("codex account identity helpers read top-level id_token email claims", () => {
  const helpers = createCodexAccountIdentityHelpers({
    jwtClaimPath: "https://api.openai.com/auth"
  });
  const token = encodeJwt({
    sub: "id_sub",
    email: "id-token@example.com",
    name: "ID Token User"
  });

  assert.equal(helpers.extractOpenAICodexEmail(token), "id-token@example.com");
  assert.equal(helpers.extractOpenAICodexPrincipalId(token), "id_sub");
});

test("codex account identity helpers extract organization ids from JWT payloads", () => {
  const helpers = createCodexAccountIdentityHelpers({
    jwtClaimPath: "https://api.openai.com/auth"
  });
  const token = encodeJwt({
    sub: "sub_orgs",
    organizations: [{ id: "acct_team" }, { id: "acct_free" }, { id: "acct_team" }],
    "https://api.openai.com/auth": {
      organizations: [{ id: "acct_auth_team" }, { account_id: "acct_auth_plus" }]
    }
  });

  assert.deepEqual(helpers.extractOpenAICodexOrganizationIds(token), [
    "acct_team",
    "acct_free",
    "acct_auth_team",
    "acct_auth_plus"
  ]);
});

test("codex account identity helpers return null-safe fallbacks for malformed tokens", () => {
  const helpers = createCodexAccountIdentityHelpers({
    jwtClaimPath: "https://api.openai.com/auth"
  });

  assert.equal(helpers.decodeJwtPayload("not-a-jwt"), null);
  assert.equal(helpers.extractOpenAICodexAuthClaim("not-a-jwt"), null);
  assert.equal(helpers.extractOpenAICodexAccountId("not-a-jwt"), null);
  assert.equal(helpers.extractOpenAICodexPrincipalId("not-a-jwt"), null);
  assert.equal(helpers.extractOpenAICodexPlanType("not-a-jwt"), null);
  assert.equal(helpers.extractOpenAICodexEmail("not-a-jwt"), null);
  assert.deepEqual(helpers.extractOpenAICodexOrganizationIds("not-a-jwt"), []);
  assert.equal(helpers.normalizeOpenAICodexPlanType("  Pro / Team  "), "pro-team");
});
