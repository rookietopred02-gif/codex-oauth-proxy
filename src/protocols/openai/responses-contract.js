export const OFFICIAL_RESPONSES_METHOD_CONTRACT = Object.freeze([
  Object.freeze({ id: "create", method: "POST", path: "/v1/responses" }),
  Object.freeze({ id: "retrieve", method: "GET", path: "/v1/responses/{response_id}" }),
  Object.freeze({ id: "delete", method: "DELETE", path: "/v1/responses/{response_id}" }),
  Object.freeze({ id: "list_input_items", method: "GET", path: "/v1/responses/{response_id}/input_items" }),
  Object.freeze({ id: "cancel", method: "POST", path: "/v1/responses/{response_id}/cancel" })
]);

export const RESPONSES_EXTENSION_METHOD_CONTRACT = Object.freeze([
  Object.freeze({ id: "compact", method: "POST", path: "/v1/responses/compact" }),
  Object.freeze({ id: "input_tokens", method: "POST", path: "/v1/responses/input_tokens" })
]);

export const RESPONSES_METHOD_CONTRACT = Object.freeze([
  ...OFFICIAL_RESPONSES_METHOD_CONTRACT,
  ...RESPONSES_EXTENSION_METHOD_CONTRACT
]);

export const RESPONSES_SUCCESS_TERMINAL_EVENT_TYPES = Object.freeze([
  "response.completed",
  "response.done",
  "response.incomplete"
]);

export const RESPONSES_FAILURE_TERMINAL_EVENT_TYPES = Object.freeze(["response.failed", "error"]);

const RESPONSES_SUCCESS_TERMINAL_EVENT_TYPE_SET = new Set(RESPONSES_SUCCESS_TERMINAL_EVENT_TYPES);
const RESPONSES_FAILURE_TERMINAL_EVENT_TYPE_SET = new Set(RESPONSES_FAILURE_TERMINAL_EVENT_TYPES);

export function isResponsesCreatePath(pathname) {
  return /^\/v1(?:\/codex)?\/responses\/?$/.test(String(pathname || ""));
}

export function isResponsesSuccessTerminalEventType(type) {
  return RESPONSES_SUCCESS_TERMINAL_EVENT_TYPE_SET.has(type);
}

export function isResponsesFailureEventType(type) {
  return RESPONSES_FAILURE_TERMINAL_EVENT_TYPE_SET.has(type);
}

export function isResponsesTerminalEventType(type) {
  return isResponsesFailureEventType(type) || isResponsesSuccessTerminalEventType(type);
}
