import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, "../tests/fixtures");

const openapiContract = {
  generated_at: new Date().toISOString().slice(0, 10),
  sources: [
    "https://developers.openai.com/api/reference/resources/responses/methods/create",
    "https://developers.openai.com/api/reference/resources/responses/methods/retrieve",
    "https://developers.openai.com/api/reference/resources/responses/methods/cancel",
    "https://developers.openai.com/api/reference/resources/responses/subresources/input_items/methods/list",
    "https://api.openai.com/v1/responses/compact",
    "https://api.openai.com/v1/responses/input_tokens"
  ],
  methods: [
    {
      id: "create",
      method: "POST",
      path: "/v1/responses",
      sample_original_url: "/v1/responses",
      expected_upstream_url: "https://example.test/codex/responses",
      expects_create_normalization: true
    },
    {
      id: "retrieve",
      method: "GET",
      path: "/v1/responses/{response_id}",
      sample_original_url: "/v1/responses/resp_123?include=reasoning.encrypted_content&include=message.output_text.logprobs",
      expected_upstream_url:
        "https://example.test/codex/responses/resp_123?include=reasoning.encrypted_content&include=message.output_text.logprobs",
      expects_create_normalization: false
    },
    {
      id: "list_input_items",
      method: "GET",
      path: "/v1/responses/{response_id}/input_items",
      sample_original_url: "/v1/responses/resp_abc123/input_items?after=item_123&limit=20",
      expected_upstream_url: "https://example.test/codex/responses/resp_abc123/input_items?after=item_123&limit=20",
      expects_create_normalization: false
    },
    {
      id: "cancel",
      method: "POST",
      path: "/v1/responses/{response_id}/cancel",
      sample_original_url: "/v1/responses/resp_123/cancel",
      expected_upstream_url: "https://example.test/codex/responses/resp_123/cancel",
      sample_body: null,
      expects_create_normalization: false
    },
    {
      id: "compact",
      method: "POST",
      path: "/v1/responses/compact",
      sample_original_url: "/v1/responses/compact",
      expected_upstream_url: "https://example.test/codex/responses/compact",
      sample_body: {
        response_id: "resp_123",
        summary: "short"
      },
      expects_create_normalization: false
    },
    {
      id: "input_tokens",
      method: "POST",
      path: "/v1/responses/input_tokens",
      sample_original_url: "/v1/responses/input_tokens",
      expected_upstream_url: "https://example.test/codex/responses/input_tokens",
      sample_body: {
        model: "gpt-5",
        input: "Tell me a joke."
      },
      expects_create_normalization: false
    }
  ],
  create: {
    covered_passthrough_cases: [
      {
        id: "base_request_fields",
        source_lines: [
          "https://developers.openai.com/api/reference/resources/responses/methods/create/#L773-L776",
          "https://developers.openai.com/api/reference/resources/responses/methods/create/#L807-L833",
          "https://developers.openai.com/api/reference/resources/responses/methods/create/#L2924-L2958"
        ],
        sample: {
          background: true,
          include: ["message.output_text.logprobs"],
          instructions: "Use the latest weather guidance.",
          max_tool_calls: 3,
          max_output_tokens: 256,
          metadata: {
            trace_id: "trace_123"
          },
          parallel_tool_calls: false,
          previous_response_id: "resp_prev_123",
          prompt_cache_key: "prompt-cache-key",
          prompt_cache_retention: "24h",
          reasoning: {
            effort: "high",
            summary: "concise"
          },
          safety_identifier: "user_hash_123",
          service_tier: "flex",
          store: true,
          temperature: 0.2,
          text: {
            format: {
              type: "text"
            },
            verbosity: "low"
          },
          tool_choice: "auto",
          tools: [
            {
              type: "function",
              name: "lookup_weather",
              parameters: {
                type: "object",
                properties: {
                  city: {
                    type: "string"
                  }
                }
              }
            }
          ],
          top_logprobs: 5,
          top_p: 0.9,
          truncation: "auto",
          user: "user-1234"
        }
      },
      {
        id: "context_management",
        source_lines: [
          "https://developers.openai.com/api/reference/resources/responses/methods/create/#L777-L789"
        ],
        sample: {
          context_management: [
            {
              type: "compaction",
              compact_threshold: 1200
            }
          ]
        }
      },
      {
        id: "conversation_string",
        source_lines: [
          "https://developers.openai.com/api/reference/resources/responses/methods/create/#L790-L799"
        ],
        sample: {
          conversation: "conv_123"
        }
      },
      {
        id: "conversation_object",
        source_lines: [
          "https://developers.openai.com/api/reference/resources/responses/methods/create/#L800-L805"
        ],
        sample: {
          conversation: {
            id: "conv_456"
          }
        }
      },
      {
        id: "prompt_template_reference",
        source_lines: [
          "https://developers.openai.com/api/reference/resources/responses/methods/create/#L8360-L8437"
        ],
        sample: {
          prompt: {
            id: "pmpt_123",
            version: "3",
            variables: {
              locale: "zh-TW",
              summary_request: {
                type: "input_text",
                text: "請摘要"
              },
              image: {
                type: "input_image",
                image_url: "https://example.test/example.png",
                detail: "low"
              },
              attachment: {
                type: "input_file",
                file_url: "https://example.test/example.pdf",
                filename: "example.pdf"
              }
            }
          }
        }
      },
      {
        id: "stream_options",
        source_lines: [
          "https://developers.openai.com/api/reference/resources/responses/methods/create/#L2951-L2956"
        ],
        request_overrides: {
          stream: true
        },
        sample: {
          stream_options: {
            include_obfuscation: false
          }
        }
      }
    ],
    normalized_fields: ["model", "stream", "input", "reasoning", "messages", "reasoning_effort"]
  }
};

const eventContract = {
  generated_at: new Date().toISOString().slice(0, 10),
  sources: [
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.completed",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.done",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.incomplete",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.failed",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.content_part.added",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.content_part.done",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.output_text.delta",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.output_text.done",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.output_text.annotation.added",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.reasoning_summary_part.added",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.reasoning_summary_part.done",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.reasoning_summary_text.delta",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.reasoning_summary_text.done",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.reasoning_text.delta",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.reasoning_text.done",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.refusal.delta",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.refusal.done",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.output_item.added",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.function_call_arguments.delta",
    "https://developers.openai.com/api/reference/resources/responses/streaming-events/#response.function_call_arguments.done"
  ],
  terminal_events: {
    success: [
      {
        type: "response.completed",
        response_status: "completed",
        chat_finish_reason: "stop"
      },
      {
        type: "response.done",
        response_status: "completed",
        chat_finish_reason: "stop"
      },
      {
        type: "response.incomplete",
        response_status: "incomplete",
        chat_finish_reason: "length"
      }
    ],
    failure: ["response.failed"]
  },
  text_events: {
    delta: "response.output_text.delta",
    done: "response.output_text.done"
  },
  content_part_events: [
    "response.content_part.added",
    "response.content_part.done"
  ],
  annotation_events: [
    "response.output_text.annotation.added"
  ],
  reasoning_events: [
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_part.done",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_text.delta",
    "response.reasoning_text.done"
  ],
  refusal_events: [
    "response.refusal.delta",
    "response.refusal.done"
  ],
  function_events: [
    "response.output_item.added",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done"
  ]
};

await mkdir(fixtureDir, { recursive: true });
await writeFile(
  path.join(fixtureDir, "openai-responses-openapi.json"),
  `${JSON.stringify(openapiContract, null, 2)}\n`,
  "utf8"
);
await writeFile(
  path.join(fixtureDir, "openai-responses-events.json"),
  `${JSON.stringify(eventContract, null, 2)}\n`,
  "utf8"
);

process.stdout.write(`Wrote OpenAI Responses contract fixtures to ${fixtureDir}\n`);
