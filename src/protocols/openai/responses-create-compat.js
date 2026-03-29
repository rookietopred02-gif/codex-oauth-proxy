const MATRIX = Object.freeze({
  background: Object.freeze({ official: true, codexResponses: "passthrough" }),
  context_management: Object.freeze({ official: true, codexResponses: "passthrough" }),
  conversation: Object.freeze({ official: true, codexResponses: "passthrough" }),
  include: Object.freeze({ official: true, codexResponses: "passthrough" }),
  input: Object.freeze({ official: true, codexResponses: "passthrough" }),
  instructions: Object.freeze({ official: true, codexResponses: "passthrough" }),
  max_output_tokens: Object.freeze({ official: true, codexResponses: "passthrough" }),
  max_tool_calls: Object.freeze({ official: true, codexResponses: "passthrough" }),
  metadata: Object.freeze({ official: true, codexResponses: "passthrough", anthropicNativeCompat: "mapped" }),
  model: Object.freeze({ official: true, codexResponses: "passthrough", anthropicNativeCompat: "mapped" }),
  parallel_tool_calls: Object.freeze({ official: true, codexResponses: "passthrough" }),
  previous_response_id: Object.freeze({ official: true, codexResponses: "local_transform" }),
  prompt: Object.freeze({ official: true, codexResponses: "passthrough" }),
  prompt_cache_key: Object.freeze({ official: true, codexResponses: "passthrough" }),
  prompt_cache_retention: Object.freeze({ official: true, codexResponses: "passthrough" }),
  reasoning: Object.freeze({ official: true, codexResponses: "passthrough" }),
  safety_identifier: Object.freeze({ official: true, codexResponses: "passthrough" }),
  service_tier: Object.freeze({ official: true, codexResponses: "passthrough" }),
  store: Object.freeze({ official: true, codexResponses: "forced_value" }),
  stream: Object.freeze({ official: true, codexResponses: "forced_value", anthropicNativeCompat: "mapped" }),
  stream_options: Object.freeze({ official: true, codexResponses: "passthrough" }),
  temperature: Object.freeze({ official: true, codexResponses: "drop", anthropicNativeCompat: "drop" }),
  text: Object.freeze({ official: true, codexResponses: "passthrough" }),
  tool_choice: Object.freeze({ official: true, codexResponses: "passthrough", anthropicNativeCompat: "mapped" }),
  tools: Object.freeze({ official: true, codexResponses: "passthrough", anthropicNativeCompat: "mapped" }),
  top_logprobs: Object.freeze({ official: true, codexResponses: "passthrough" }),
  top_p: Object.freeze({ official: true, codexResponses: "drop", anthropicNativeCompat: "drop" }),
  truncation: Object.freeze({ official: true, codexResponses: "passthrough" }),
  user: Object.freeze({ official: true, codexResponses: "passthrough" }),
  messages: Object.freeze({ official: false, codexResponses: "alias" }),
  reasoning_effort: Object.freeze({ official: false, codexResponses: "alias" })
});

export const RESPONSES_CREATE_FIELD_MATRIX = MATRIX;
export const OFFICIAL_RESPONSES_CREATE_FIELDS = Object.freeze(
  Object.keys(MATRIX).filter((fieldName) => MATRIX[fieldName]?.official === true)
);
export const RESPONSES_CREATE_ALIAS_FIELDS = Object.freeze(
  Object.keys(MATRIX).filter((fieldName) => MATRIX[fieldName]?.official !== true)
);

export function getResponsesCreateFieldPolicy(fieldName, surface = "codexResponses") {
  const key = String(fieldName || "").trim();
  if (!key) return null;
  const descriptor = MATRIX[key];
  if (!descriptor) return null;
  return typeof descriptor[surface] === "string" ? descriptor[surface] : null;
}

export function assertResponsesCreateFieldMapped(fieldName, surface, surfaceLabel) {
  const policy = getResponsesCreateFieldPolicy(fieldName, surface);
  if (policy === "mapped" || policy === "passthrough" || policy === "local_transform" || policy === "forced_value") {
    return policy;
  }

  const err = new Error(
    `Responses field "${fieldName}" is not supported in ${surfaceLabel} because it cannot be equivalently mapped to Codex/OpenAI Responses upstream.`
  );
  err.statusCode = 400;
  err.code = "unsupported_parameter";
  err.param = fieldName;
  throw err;
}

export function assertResponsesCreateFieldSupported(fieldName, surface, surfaceLabel) {
  const policy = getResponsesCreateFieldPolicy(fieldName, surface);
  if (policy && policy !== "unsupported") {
    return policy;
  }

  const err = new Error(
    `Responses field "${fieldName}" is not supported in ${surfaceLabel} because the configured upstream does not accept it.`
  );
  err.statusCode = 400;
  err.code = "unsupported_parameter";
  err.param = fieldName;
  throw err;
}

export function parseFiniteResponsesNumericField(fieldName, rawValue, { min = -Infinity, max = Infinity, surfaceLabel } = {}) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    const err = new Error(`${surfaceLabel} ${fieldName} must be a finite number.`);
    err.statusCode = 400;
    err.code = "invalid_request";
    err.param = fieldName;
    throw err;
  }
  if (value < min || value > max) {
    const err = new Error(`${surfaceLabel} ${fieldName} must be between ${min} and ${max}.`);
    err.statusCode = 400;
    err.code = "invalid_request";
    err.param = fieldName;
    throw err;
  }
  return value;
}

export function applyAdditionalResponsesCreateFields(target, extraFields = {}) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return target;
  if (!extraFields || typeof extraFields !== "object" || Array.isArray(extraFields)) return target;

  for (const [fieldName, value] of Object.entries(extraFields)) {
    if (value === undefined) continue;
    if (fieldName in target) continue;
    if (getResponsesCreateFieldPolicy(fieldName, "codexResponses") !== "passthrough") continue;
    target[fieldName] = structuredClone(value);
  }
  return target;
}
