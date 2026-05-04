import assert from "node:assert/strict";
import test from "node:test";

import {
  mapResponsesUsageToChatUsage,
  mergeNormalizedTokenUsage,
  normalizeTokenUsage,
  toChatUsageFromNormalizedTokenUsage
} from "../src/http/token-usage.js";

test("normalizes cached input tokens from Responses usage details", () => {
  assert.deepEqual(
    normalizeTokenUsage({
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      input_tokens_details: {
        cached_tokens: 80
      }
    }),
    {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cachedInputTokens: 80
    }
  );
});

test("normalizes cached input tokens from chat-style camelCase details", () => {
  assert.deepEqual(
    normalizeTokenUsage({
      promptTokens: 20,
      completionTokens: 5,
      promptTokensDetails: {
        cachedTokens: 12
      }
    }),
    {
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      cachedInputTokens: 12
    }
  );
});

test("merges cached input tokens without losing current usage fields", () => {
  assert.deepEqual(
    mergeNormalizedTokenUsage(
      {
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
        cachedInputTokens: 4
      },
      {
        outputTokens: 2,
        totalTokens: 12
      }
    ),
    {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cachedInputTokens: 4
    }
  );
});

test("preserves cached input token details in chat-compatible usage", () => {
  assert.deepEqual(
    toChatUsageFromNormalizedTokenUsage({
      inputTokens: 99,
      outputTokens: 7,
      totalTokens: 106,
      cachedInputTokens: 64
    }),
    {
      prompt_tokens: 99,
      completion_tokens: 7,
      total_tokens: 106,
      prompt_tokens_details: {
        cached_tokens: 64
      }
    }
  );

  assert.deepEqual(
    mapResponsesUsageToChatUsage({
      input_tokens: 40,
      output_tokens: 6,
      total_tokens: 46,
      input_tokens_details: {
        cached_tokens: 32
      }
    }),
    {
      prompt_tokens: 40,
      completion_tokens: 6,
      total_tokens: 46,
      prompt_tokens_details: {
        cached_tokens: 32
      }
    }
  );
});
