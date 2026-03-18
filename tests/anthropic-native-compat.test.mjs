import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
process.env.PROVIDER_UPSTREAM_ALLOW_REQUEST_KEYS = "1";

const { __testing } = await import("../src/server.js");

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmwAAAABJRU5ErkJggg==";

function createMockResponse() {
  return {
    locals: {},
    headers: new Map(),
    body: "",
    statusCode: 200,
    writableEnded: false,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers.set(String(name).toLowerCase(), value);
    },
    getHeader(name) {
      return this.headers.get(String(name).toLowerCase());
    },
    write(chunk) {
      this.headersSent = true;
      this.body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    end(chunk = "") {
      if (chunk) {
        this.body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      }
      this.writableEnded = true;
    },
    json(payload) {
      this.setHeader("content-type", "application/json");
      this.body = JSON.stringify(payload);
      this.writableEnded = true;
      return this;
    }
  };
}

test("normalizeCherryAnthropicAgentOriginalUrl rewrites Cherry agent alias paths", () => {
  assert.equal(
    __testing.normalizeCherryAnthropicAgentOriginalUrl("/v1/chat/completions/v1/messages"),
    "/v1/messages"
  );
  assert.equal(
    __testing.normalizeCherryAnthropicAgentOriginalUrl("/v1/chat/completions/v1/messages/count_tokens?foo=1"),
    "/v1/messages/count_tokens?foo=1"
  );
  assert.equal(__testing.normalizeCherryAnthropicAgentOriginalUrl("/v1/chat/completions"), null);
});

test("parseAnthropicNativeBody preserves agent-mode request fields and tool exchanges", () => {
  const rawBody = Buffer.from(
    JSON.stringify({
      model: "claude-sonnet-4-6-latest",
      system: [{ type: "text", text: "You are a coding agent." }],
      thinking: { type: "enabled", budget_tokens: 4096 },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Read the repo." }]
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { file_path: "README.md" }
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "README contents" }]
            }
          ]
        }
      ],
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: {
              file_path: { type: "string" }
            }
          }
        }
      ],
      tool_choice: { type: "tool", name: "Read" },
      metadata: { source: "test" },
      documents: [{ id: "doc_1" }],
      stream: true,
      max_tokens: 256,
      temperature: 0.2,
      top_p: 0.9,
      stop_sequences: ["DONE"]
    }),
    "utf8"
  );

  const parsed = __testing.parseAnthropicNativeBody(rawBody);
  assert.equal(parsed.systemText, "You are a coding agent.");
  assert.equal(parsed.stream, true);
  assert.equal(parsed.max_tokens, 256);
  assert.equal(parsed.temperature, 0.2);
  assert.equal(parsed.top_p, 0.9);
  assert.deepEqual(parsed.stop, ["DONE"]);
  assert.deepEqual(parsed.thinking, { type: "enabled", budget_tokens: 4096 });
  assert.equal(parsed.messages.length, 3);
  assert.equal(parsed.messages[1].content[0].type, "tool_use");
  assert.equal(parsed.messages[2].content[0].type, "tool_result");

  const tools = __testing.normalizeAnthropicNativeTools(parsed.tools);
  assert.deepEqual(tools, [
    {
      type: "function",
      name: "Read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" }
        }
      }
    }
  ]);
  assert.deepEqual(__testing.normalizeAnthropicNativeToolChoice(parsed.tool_choice), {
    type: "function",
    name: "Read"
  });

  const input = __testing.toResponsesInputFromAnthropicMessages(parsed.messages);
  assert.equal(input.length, 3);
  assert.equal(input[0].role, "user");
  assert.equal(input[1].type, "function_call");
  assert.equal(input[1].call_id, "toolu_1");
  assert.equal(input[2].type, "function_call_output");
  assert.equal(input[2].call_id, "toolu_1");
  assert.equal(input[2].output, "README contents");
});

test("toResponsesInputFromAnthropicMessages accepts image tool_result blocks in local compatibility mode", () => {
  const arrayInput = __testing.toResponsesInputFromAnthropicMessages([
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_image_array",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
            { type: "text", text: "OCR unavailable" }
          ]
        }
      ]
    }
  ]);

  assert.equal(arrayInput[0].type, "function_call_output");
  assert.equal(arrayInput[0].call_id, "toolu_image_array");
  assert.equal(arrayInput[0].output, "[image]\nOCR unavailable");

  const objectInput = __testing.toResponsesInputFromAnthropicMessages([
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_image_object",
          content: { type: "image", source: { type: "base64", media_type: "image/png", data: "xyz" } }
        }
      ]
    }
  ]);

  assert.equal(objectInput[0].output, "[image]");
});

test("parseAnthropicNativeBody promotes Cherry attached image manifests into multimodal user content", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-pro-max-image-"));
  const imagePath = path.join(tempDir, "attachment.png");

  try {
    await writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    const rawBody = Buffer.from(
      JSON.stringify({
        model: "claude-sonnet-4-6-latest",
        messages: [
          {
            role: "user",
            content: `Describe this image in one sentence.\n\nAttached files:\n${imagePath}`
          }
        ]
      }),
      "utf8"
    );

    const parsed = __testing.parseAnthropicNativeBody(rawBody);
    assert.deepEqual(parsed.messages[0].content, [
      { type: "text", text: "Describe this image in one sentence.\n" },
      {
        type: "image",
        source: {
          type: "file",
          file_path: imagePath,
          media_type: "image/png"
        }
      }
    ]);

    const input = __testing.toResponsesInputFromAnthropicMessages(parsed.messages);
    assert.equal(input[0].role, "user");
    assert.deepEqual(input[0].content, [{ type: "input_text", text: "Describe this image in one sentence.\n" }]);
    assert.equal(input[1].role, "user");
    assert.equal(input[1].content[0].type, "input_image");
    assert.match(input[1].content[0].image_url, /^data:image\/png;base64,/);

    const request = __testing.buildCodexResponsesRequestBody({
      model: "claude-sonnet-4-6-latest",
      upstreamModel: "gpt-5.4",
      instructions: "",
      input
    });
    assert.equal(request.body.input[1].content[0].type, "input_image");
    assert.match(request.body.input[1].content[0].image_url, /^data:image\/png;base64,/);
    assert.doesNotMatch(JSON.stringify(request.body.input), /Attached files:/);
    assert.doesNotMatch(JSON.stringify(request.body.input), /attachment\.png/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parseAnthropicNativeBody leaves missing or non-image attached files as text", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-pro-max-image-"));
  const notePath = path.join(tempDir, "attachment.txt");
  const missingPath = path.join(tempDir, "missing.png");

  try {
    await writeFile(notePath, "not an image", "utf8");

    const noteBody = Buffer.from(
      JSON.stringify({
        model: "claude-sonnet-4-6-latest",
        messages: [
          {
            role: "user",
            content: `Summarize the attachment.\n\nAttached files:\n${notePath}`
          }
        ]
      }),
      "utf8"
    );
    const missingBody = Buffer.from(
      JSON.stringify({
        model: "claude-sonnet-4-6-latest",
        messages: [
          {
            role: "user",
            content: `Describe the missing file.\n\nAttached files:\n${missingPath}`
          }
        ]
      }),
      "utf8"
    );

    const noteParsed = __testing.parseAnthropicNativeBody(noteBody);
    const missingParsed = __testing.parseAnthropicNativeBody(missingBody);

    assert.deepEqual(noteParsed.messages[0].content, [
      {
        type: "text",
        text: `Summarize the attachment.\n\nAttached files:\n${notePath}`
      }
    ]);
    assert.deepEqual(missingParsed.messages[0].content, [
      {
        type: "text",
        text: `Describe the missing file.\n\nAttached files:\n${missingPath}`
      }
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parseAnthropicNativeBody rejects unsupported attached image formats", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-pro-max-image-"));
  const imagePath = path.join(tempDir, "attachment.svg");

  try {
    await writeFile(imagePath, "<svg></svg>", "utf8");

    const rawBody = Buffer.from(
      JSON.stringify({
        model: "claude-sonnet-4-6-latest",
        messages: [
          {
            role: "user",
            content: `Describe this image.\n\nAttached files:\n${imagePath}`
          }
        ]
      }),
      "utf8"
    );

    assert.throws(
      () => __testing.parseAnthropicNativeBody(rawBody),
      /Unsupported attached image format "\.svg"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parseAnthropicNativeBody accepts adaptive thinking and normalizes it to enabled", () => {
  const rawBody = Buffer.from(
    JSON.stringify({
      model: "claude-sonnet-4-6-latest",
      thinking: { type: "adaptive", budget_tokens: 8192 },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Think first, then answer." }]
        }
      ]
    }),
    "utf8"
  );

  const parsed = __testing.parseAnthropicNativeBody(rawBody);
  assert.deepEqual(parsed.thinking, { type: "adaptive", budget_tokens: 8192 });
});

test("resolveAnthropicNativeReasoningSummary treats adaptive according to target model requirements", () => {
  assert.equal(__testing.resolveAnthropicNativeReasoningSummary(undefined), "detailed");
  assert.equal(__testing.resolveAnthropicNativeReasoningSummary({ type: "enabled" }), "detailed");
  assert.equal(__testing.resolveAnthropicNativeReasoningSummary({ type: "enabled", budget_tokens: 4096 }), "detailed");
  assert.equal(__testing.resolveAnthropicNativeReasoningSummary({ type: "disabled" }), undefined);
  assert.equal(
    __testing.resolveAnthropicNativeReasoningSummary(
      { type: "adaptive" },
      "gpt-5.4",
      {
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        tools: [],
        tool_choice: "auto",
        instructions: ""
      }
    ),
    undefined
  );
  assert.equal(
    __testing.resolveAnthropicNativeReasoningSummary(
      { type: "adaptive" },
      "gpt-5.4-codex",
      {
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        tools: [],
        tool_choice: "auto",
        instructions: ""
      }
    ),
    "detailed"
  );
});

test("parseAnthropicNativeBody accepts real Anthropic user image blocks and converts them to input_image", () => {
  const rawBody = Buffer.from(
    JSON.stringify({
      model: "claude-sonnet-4-6-latest",
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG_BASE64 } }]
        }
      ]
    }),
    "utf8"
  );

  const parsed = __testing.parseAnthropicNativeBody(rawBody);
  assert.equal(parsed.messages[0].content[0].type, "image");

  const input = __testing.toResponsesInputFromAnthropicMessages(parsed.messages);
  assert.equal(input[0].role, "user");
  assert.equal(input[0].content[0].type, "input_image");
  assert.match(input[0].content[0].image_url, /^data:image\/png;base64,/);
});

test("parseAnthropicNativeBody still rejects assistant image blocks in local compatibility mode", () => {
  const rawBody = Buffer.from(
    JSON.stringify({
      model: "claude-sonnet-4-6-latest",
      messages: [
        {
          role: "assistant",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG_BASE64 } }]
        }
      ]
    }),
    "utf8"
  );

  assert.throws(() => __testing.parseAnthropicNativeBody(rawBody), /Anthropic image blocks are only supported in user messages/);
});

test("parseAnthropicNativeBody still rejects unsupported thinking types", () => {
  const rawBody = Buffer.from(
    JSON.stringify({
      model: "claude-sonnet-4-6-latest",
      thinking: { type: "mystery" },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }]
        }
      ]
    }),
    "utf8"
  );

  assert.throws(
    () => __testing.parseAnthropicNativeBody(rawBody),
    /Unsupported Anthropic thinking.type value "mystery"/
  );
});

test("parseAnthropicNativeBody accepts Anthropic web search assistant history blocks", () => {
  const rawBody = Buffer.from(
    JSON.stringify({
      model: "claude-sonnet-4-6-latest",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_1",
              name: "web_search",
              input: {
                query: "openai codex cli docs"
              }
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_1",
              content: [
                {
                  type: "web_search_result",
                  url: "https://developers.openai.com/codex/cli",
                  title: "developers.openai.com/codex/cli",
                  encrypted_content: "ZW5jcnlwdGVk"
                }
              ]
            },
            {
              type: "text",
              text: "Found the official CLI docs."
            }
          ]
        }
      ]
    }),
    "utf8"
  );

  const parsed = __testing.parseAnthropicNativeBody(rawBody);
  assert.equal(parsed.messages[0].content[0].type, "server_tool_use");
  assert.equal(parsed.messages[0].content[1].type, "web_search_tool_result");

  const input = __testing.toResponsesInputFromAnthropicMessages(parsed.messages);
  assert.equal(input.length, 1);
  assert.equal(input[0].role, "assistant");
  assert.match(input[0].content[0].text, /openai codex cli docs/i);
  assert.match(input[0].content[1].text, /developers\.openai\.com\/codex\/cli/i);
});

test("parseAnthropicNativeBody accepts assistant thinking blocks and strips them from upstream input", () => {
  const rawBody = Buffer.from(
    JSON.stringify({
      model: "claude-sonnet-4-6-latest",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Need to compare the two approaches."
            },
            {
              type: "text",
              text: "I will compare them."
            }
          ]
        }
      ]
    }),
    "utf8"
  );

  const parsed = __testing.parseAnthropicNativeBody(rawBody);
  assert.equal(parsed.messages[0].content[0].type, "thinking");

  const input = __testing.toResponsesInputFromAnthropicMessages(parsed.messages);
  assert.equal(input.length, 1);
  assert.equal(input[0].role, "assistant");
  assert.deepEqual(input[0].content, [{ type: "output_text", text: "I will compare them." }]);
});

test("normalizeAnthropicNativeTools maps custom WebSearch and WebFetch to one native web_search tool", () => {
  assert.deepEqual(
    __testing.normalizeAnthropicNativeTools([
      {
        name: "WebSearch",
        description: "Search the web",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string" }
          }
        }
      },
      {
        name: "WebFetch",
        description: "Fetch a URL",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string" },
            prompt: { type: "string" }
          }
        }
      },
      {
        name: "Read",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" }
          }
        }
      }
    ]),
    [
      {
        type: "web_search"
      },
      {
        type: "function",
        name: "Read",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" }
          }
        }
      }
    ]
  );
});

test("normalizeAnthropicNativeToolChoice routes custom web tool choices to native web_search", () => {
  const tools = __testing.normalizeAnthropicNativeTools([
    {
      name: "WebSearch",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" }
        }
      }
    }
  ]);

  assert.equal(
    __testing.normalizeAnthropicNativeToolChoice({ type: "tool", name: "WebSearch" }, tools),
    "required"
  );
  assert.equal(
    __testing.normalizeAnthropicNativeToolChoice({ type: "tool", name: "WebFetch" }, tools),
    "required"
  );
});

test("buildAnthropicMessageFromResponsesResponse converts reasoning summaries into thinking blocks", () => {
  const message = __testing.buildAnthropicMessageFromResponsesResponse({
    id: "resp_1",
    model: "gpt-5.4",
    status: "completed",
    usage: {
      input_tokens: 10,
      output_tokens: 20
    },
    output: [
      {
        id: "rs_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "First compare the available branches." }]
      },
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Use the main branch." }]
      }
    ]
  });

  assert.deepEqual(message.content, [
    {
      type: "thinking",
      thinking: "First compare the available branches."
    },
    {
      type: "text",
      text: "Use the main branch."
    }
  ]);
});

test("renderAnthropicMessageSseEvents emits thinking deltas", () => {
  const events = __testing.renderAnthropicMessageSseEvents({
    id: "msg_1",
    model: "gpt-5.4",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 2
    },
    content: [
      {
        type: "thinking",
        thinking: "Compare both options."
      },
      {
        type: "text",
        text: "Choose option A."
      }
    ]
  });

  const thinkingStart = events.find(
    (event) => event.event === "content_block_start" && event.data.content_block.type === "thinking"
  );
  const thinkingDelta = events.find(
    (event) => event.event === "content_block_delta" && event.data.delta.type === "thinking_delta"
  );

  assert.ok(thinkingStart);
  assert.ok(thinkingDelta);
  assert.equal(thinkingDelta.data.delta.thinking, "Compare both options.");
});

test("normalizeAnthropicToolUseInput narrows risky Windows Glob home-directory scans", () => {
  const userHome = process.env.USERPROFILE;
  assert.ok(userHome);

  assert.deepEqual(
    __testing.normalizeAnthropicToolUseInput("Glob", {
      pattern: ".codex/**",
      path: userHome
    }),
    {
      pattern: "**/*",
      path: `${userHome}\\.codex`
    }
  );

  assert.deepEqual(
    __testing.normalizeAnthropicToolUseInput("Glob", {
      pattern: "AppData/Roaming/**/auth.json",
      path: userHome
    }),
    {
      pattern: "**/auth.json",
      path: `${userHome}\\AppData\\Roaming`
    }
  );

  const workspaceRoot = path.dirname(process.cwd());
  const directLiteralTarget = __testing.normalizeAnthropicToolUseInput("Glob", {
    pattern: "**/codex-pro-max/package.json",
    path: workspaceRoot
  });
  assert.equal(
    directLiteralTarget.path.replace(/\\/g, "/").toLowerCase(),
    `${workspaceRoot}/codex-pro-max`.replace(/\\/g, "/").toLowerCase()
  );
  assert.equal(directLiteralTarget.pattern, "package.json");
});

test("normalizeAnthropicToolUseInput aligns Edit old_string to a unique multiline file match", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-pro-max-edit-"));
  try {
    const filePath = path.join(tempDir, "dashboard.js");
    const fileText = [
      "function renderState(state) {",
      "  document.getElementById('recentRequestsBody').innerHTML = state.recentRequests.length === 0",
      "    ? '<tr><td colspan=\"6\" class=\"hint\">No requests recorded yet.</td></tr>'",
      "    : state.recentRequests.map((item, index) => {",
      "        return item.path;",
      "      }).join('');",
      "}"
    ].join("\n");
    await writeFile(filePath, fileText, "utf8");

    const normalized = __testing.normalizeAnthropicToolUseInput("Edit", {
      file_path: filePath,
      old_string:
        "document.getElementById('recentRequestsBody').innerHTML = state.recentRequests.length === 0 ? '<tr><td colspan=\"6\" class=\"hint\">No requests recorded yet.</td></tr>' : state.recentRequests.map((item, index) => { return item.path; }).join('');",
      new_string: "document.getElementById('recentRequestsBody').textContent = 'ok';"
    });

    assert.equal(
      normalized.old_string,
      [
        "document.getElementById('recentRequestsBody').innerHTML = state.recentRequests.length === 0",
        "    ? '<tr><td colspan=\"6\" class=\"hint\">No requests recorded yet.</td></tr>'",
        "    : state.recentRequests.map((item, index) => {",
        "        return item.path;",
        "      }).join('');"
      ].join("\n")
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("normalizeAnthropicToolUseInput leaves Edit old_string unchanged when normalized matches are ambiguous", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-pro-max-edit-"));
  try {
    const filePath = path.join(tempDir, "dup.js");
    const fileText = [
      "const value = foo(",
      "  bar,",
      "  baz",
      ");",
      "",
      "const other = foo(",
      "  bar,",
      "  baz",
      ");"
    ].join("\n");
    await writeFile(filePath, fileText, "utf8");

    const collapsed = "foo( bar, baz );";
    const normalized = __testing.normalizeAnthropicToolUseInput("Edit", {
      file_path: filePath,
      old_string: collapsed,
      new_string: "foo(bar, baz);"
    });

    assert.equal(normalized.old_string, collapsed);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("normalizeAnthropicNativeTools maps built-in web search tools to Codex web_search", () => {
  const tools = __testing.normalizeAnthropicNativeTools([
    {
      type: "web_search_20250305",
      name: "web_search",
      allowed_domains: ["developers.openai.com", "github.com"],
      blocked_domains: ["example.com"]
    }
  ]);

  assert.deepEqual(tools, [
    {
      type: "web_search",
      filters: {
        allowed_domains: ["developers.openai.com", "github.com"],
        blocked_domains: ["example.com"]
      }
    }
  ]);

  assert.equal(
    __testing.normalizeAnthropicNativeToolChoice({ type: "tool", name: "web_search" }, tools),
    "required"
  );
});

test("normalizeAnthropicNativeExecutionConfig keeps metadata local and rejects unsupported controls", () => {
  assert.deepEqual(
    __testing.normalizeAnthropicNativeExecutionConfig({
      metadata: { source: "sdk" },
      temperature: 1,
      top_p: 1
    }),
    {
      metadata: { source: "sdk" }
    }
  );

  assert.throws(
    () =>
      __testing.normalizeAnthropicNativeExecutionConfig({
        temperature: 0.2
      }),
    /Anthropic temperature is not supported/
  );

  assert.throws(
    () =>
      __testing.normalizeAnthropicNativeExecutionConfig({
        top_p: 0.9
      }),
    /Anthropic top_p is not supported/
  );

  assert.throws(
    () =>
      __testing.normalizeAnthropicNativeExecutionConfig({
        documents: [{ id: "doc_1" }]
      }),
    /Anthropic documents are not yet supported/
  );
});

test("buildAnthropicMessageFromResponsesResponse creates a valid plain text message", () => {
  const message = __testing.buildAnthropicMessageFromResponsesResponse(
    {
      id: "resp_text",
      model: "gpt-5.4",
      status: "completed",
      usage: {
        input_tokens: 11,
        output_tokens: 7
      },
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }]
        }
      ]
    },
    "claude-sonnet-4-6-latest"
  );

  assert.equal(message.id, "resp_text");
  assert.equal(message.model, "claude-sonnet-4-6-latest");
  assert.deepEqual(message.content, [{ type: "text", text: "Done." }]);
  assert.equal(message.stop_reason, "end_turn");
  assert.deepEqual(message.usage, { input_tokens: 11, output_tokens: 7 });
});

test("renderAnthropicMessageSseEvents emits documented text streaming sequence", () => {
  const events = __testing.renderAnthropicMessageSseEvents({
    id: "msg_text",
    model: "claude-sonnet-4-6-latest",
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 3 }
  });

  assert.deepEqual(
    events.map((item) => item.event),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]
  );
  assert.equal(events[2].data.delta.type, "text_delta");
  assert.equal(events[2].data.delta.text, "Hello");
});

test("buildAnthropicMessageFromResponsesResponse and SSE rendering support tool_use blocks", () => {
  const message = __testing.buildAnthropicMessageFromResponsesResponse(
    {
      id: "resp_tool",
      model: "gpt-5.4",
      status: "completed",
      usage: {
        input_tokens: 20,
        output_tokens: 9
      },
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "Read",
          arguments: "{\"file_path\":\"README.md\"}"
        }
      ]
    },
    "claude-sonnet-4-6-latest"
  );

  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.content, [
    {
      type: "tool_use",
      id: "call_1",
      name: "Read",
      input: { file_path: "README.md" }
    }
  ]);

  const events = __testing.renderAnthropicMessageSseEvents(message);
  assert.deepEqual(
    events.map((item) => item.event),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]
  );
  assert.equal(events[1].data.content_block.type, "tool_use");
  assert.equal(events[2].data.delta.type, "input_json_delta");
  assert.equal(events[2].data.delta.partial_json, "{\"file_path\":\"README.md\"}");
});

test("buildAnthropicMessageFromResponsesResponse normalizes WebSearch domain filters", () => {
  const message = __testing.buildAnthropicMessageFromResponsesResponse(
    {
      id: "resp_websearch",
      model: "gpt-5.4",
      status: "completed",
      usage: {
        input_tokens: 10,
        output_tokens: 4
      },
      output: [
        {
          type: "function_call",
          call_id: "call_websearch",
          name: "WebSearch",
          arguments:
            "{\"query\":\"taiwan beef noodles 2026\",\"allowed_domains\":[\"ifoodie.tw\"],\"blocked_domains\":[]}"
        }
      ]
    },
    "claude-sonnet-4-6-latest"
  );

  assert.deepEqual(message.content, [
    {
      type: "tool_use",
      id: "call_websearch",
      name: "WebSearch",
      input: {
        query: "taiwan beef noodles 2026",
        allowed_domains: ["ifoodie.tw"]
      }
    }
  ]);

  const events = __testing.renderAnthropicMessageSseEvents(message);
  assert.equal(
    events[2].data.delta.partial_json,
    "{\"query\":\"taiwan beef noodles 2026\",\"allowed_domains\":[\"ifoodie.tw\"]}"
  );
});

test("buildAnthropicMessageFromResponsesResponse strips empty optional tool args", () => {
  const message = __testing.buildAnthropicMessageFromResponsesResponse(
    {
      id: "resp_sanitized_tools",
      model: "gpt-5.4",
      status: "completed",
      usage: {
        input_tokens: 10,
        output_tokens: 4
      },
      output: [
        {
          type: "function_call",
          call_id: "call_read",
          name: "Read",
          arguments: "{\"file_path\":\"C:/Users/fi/CLAUDE.md\",\"offset\":0,\"limit\":2000,\"pages\":\"\"}"
        }
      ]
    },
    "claude-sonnet-4-6-latest"
  );

  assert.deepEqual(message.content, [
    {
      type: "tool_use",
      id: "call_read",
      name: "Read",
      input: {
        file_path: "C:/Users/fi/CLAUDE.md",
        offset: 0,
        limit: 2000
      }
    }
  ]);
});

test("buildAnthropicMessageFromResponsesResponse preserves Edit empty replacement strings", () => {
  const message = __testing.buildAnthropicMessageFromResponsesResponse(
    {
      id: "resp_edit_delete",
      model: "gpt-5.4",
      status: "completed",
      usage: {
        input_tokens: 10,
        output_tokens: 4
      },
      output: [
        {
          type: "function_call",
          call_id: "call_edit",
          name: "Edit",
          arguments:
            "{\"file_path\":\"C:/Users/fi/Desktop/gay.txt\",\"old_string\":\"delete me\\n\",\"new_string\":\"\"}"
        }
      ]
    },
    "claude-sonnet-4-6-latest"
  );

  assert.deepEqual(message.content, [
    {
      type: "tool_use",
      id: "call_edit",
      name: "Edit",
      input: {
        file_path: "C:/Users/fi/Desktop/gay.txt",
        old_string: "delete me\n",
        new_string: ""
      }
    }
  ]);
});

test("buildAnthropicMessageFromResponsesResponse preserves significant tool string whitespace", () => {
  const message = __testing.buildAnthropicMessageFromResponsesResponse(
    {
      id: "resp_write",
      model: "gpt-5.4",
      status: "completed",
      usage: {
        input_tokens: 10,
        output_tokens: 4
      },
      output: [
        {
          type: "function_call",
          call_id: "call_write",
          name: "Write",
          arguments:
            "{\"file_path\":\"C:/Users/fi/source/tool_runtime_test.txt\",\"content\":\"written by verify harness\\n\"}"
        }
      ]
    },
    "claude-sonnet-4-6-latest"
  );

  assert.deepEqual(message.content, [
    {
      type: "tool_use",
      id: "call_write",
      name: "Write",
      input: {
        file_path: "C:/Users/fi/source/tool_runtime_test.txt",
        content: "written by verify harness\n"
      }
    }
  ]);
});

test("buildAnthropicMessageFromResponsesResponse drops Agent worktree isolation defaults", () => {
  const message = __testing.buildAnthropicMessageFromResponsesResponse(
    {
      id: "resp_agent",
      model: "gpt-5.4",
      status: "completed",
      usage: {
        input_tokens: 10,
        output_tokens: 4
      },
      output: [
        {
          type: "function_call",
          call_id: "call_agent",
          name: "Agent",
          arguments:
            "{\"description\":\"回報測試資訊\",\"prompt\":\"test\",\"subagent_type\":\"general-purpose\",\"resume\":\"\",\"run_in_background\":false,\"isolation\":\"worktree\"}"
        }
      ]
    },
    "claude-sonnet-4-6-latest"
  );

  assert.deepEqual(message.content, [
    {
      type: "tool_use",
      id: "call_agent",
      name: "Agent",
      input: {
        description: "回報測試資訊",
        prompt: "test",
        subagent_type: "general-purpose",
        run_in_background: false
      }
    }
  ]);
});

test("planAnthropicFunctionCallEmission serializes batched tool calls", () => {
  const plan = __testing.planAnthropicFunctionCallEmission([
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "先做幾個檢查。" }]
    },
    {
      type: "function_call",
      call_id: "call_agent",
      name: "Agent",
      arguments: "{\"description\":\"回報測試資訊\",\"prompt\":\"test\",\"subagent_type\":\"general-purpose\"}"
    },
    {
      type: "function_call",
      call_id: "call_bash",
      name: "Bash",
      arguments: "{\"command\":\"pwd\"}"
    }
  ]);

  assert.equal(plan.emittedFunctionCallId, "call_agent");
  assert.equal(plan.immediateOutput.length, 2);
  assert.equal(plan.pendingFunctionCalls.length, 1);
  assert.equal(plan.pendingFunctionCalls[0].call_id, "call_bash");
});

test("queued Anthropic tool batches replay one tool at a time", () => {
  __testing.clearAnthropicPendingToolBatches();
  __testing.rememberAnthropicPendingToolBatch(
    "call_agent",
    [
      {
        type: "function_call",
        call_id: "call_bash",
        name: "Bash",
        arguments: "{\"command\":\"pwd\"}"
      }
    ],
    "claude-sonnet-4-6-latest"
  );

  const message = __testing.maybeBuildQueuedAnthropicToolMessage(
    [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_agent",
            content: "done"
          }
        ]
      }
    ],
    "claude-sonnet-4-6-latest"
  );

  assert.deepEqual(message.content, [
    {
      type: "tool_use",
      id: "call_bash",
      name: "Bash",
      input: {
        command: "pwd"
      }
    }
  ]);
  assert.equal(message.stop_reason, "tool_use");
  __testing.clearAnthropicPendingToolBatches();
});

test("buildAnthropicMessageFromResponsesResponse maps Codex web_search calls to Anthropic search blocks", () => {
  const message = __testing.buildAnthropicMessageFromResponsesResponse(
    {
      id: "resp_web_search",
      model: "gpt-5.4",
      status: "completed",
      usage: {
        input_tokens: 42,
        output_tokens: 11
      },
      output: [
        {
          id: "ws_1",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            query: "openai codex cli docs",
            sources: [
              {
                type: "url",
                url: "https://developers.openai.com/codex/cli"
              },
              {
                type: "url",
                url: "https://github.com/openai/codex"
              }
            ]
          }
        },
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Top sources:\n- https://developers.openai.com/codex/cli\n- https://github.com/openai/codex"
            }
          ]
        }
      ]
    },
    "claude-sonnet-4-6-latest"
  );

  assert.equal(message.stop_reason, "end_turn");
  assert.equal(message.content[0].type, "server_tool_use");
  assert.equal(message.content[1].type, "web_search_tool_result");
  assert.equal(message.content[2].type, "text");
  assert.equal(message.content[1].content[0].url, "https://developers.openai.com/codex/cli");
  assert.equal(message.usage.server_tool_use.web_search_requests, 1);

  const events = __testing.renderAnthropicMessageSseEvents(message);
  assert.deepEqual(
    events.map((item) => item.event),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]
  );
  assert.equal(events[1].data.content_block.type, "server_tool_use");
  assert.equal(events[4].data.content_block.type, "web_search_tool_result");
  assert.equal(events[9].data.usage.server_tool_use.web_search_requests, 1);
});

test("estimateAnthropicCountTokens handles tools metadata and documents payloads", () => {
  const count = __testing.estimateAnthropicCountTokens(
    Buffer.from(
      JSON.stringify({
        model: "claude-sonnet-4-6-latest",
        system: "Count this.",
        messages: [{ role: "user", content: "Hello" }],
        tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
        tool_choice: { type: "tool", name: "Read" },
        metadata: { source: "test" },
        documents: [{ id: "doc_1", title: "Doc" }]
      }),
      "utf8"
    )
  );

  assert.equal(typeof count, "number");
  assert.ok(count > 0);
});

test("handleAnthropicNativeProxy preserves direct pass-through when x-api-key is present", async () => {
  const originalFetch = global.fetch;
  let captured = null;
  __testing.config.providerUpstream.allowRequestApiKeys = true;

  global.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(null, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-upstream": "ok"
      }
    });
  };

  try {
    const req = {
      originalUrl: "/v1/messages",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-1234567890abcdef"
      },
      rawBody: Buffer.from(
        JSON.stringify({
          model: "claude-sonnet-4-6-latest",
          messages: [{ role: "user", content: "hello" }]
        }),
        "utf8"
      )
    };
    const res = createMockResponse();

    await __testing.handleAnthropicNativeProxy(req, res);

    assert.ok(captured);
    assert.match(String(captured.url), /\/v1\/messages$/);
    assert.equal(captured.init.headers.get("x-api-key"), "sk-ant-1234567890abcdef");
    assert.ok(captured.init.headers.get("anthropic-version"));
    const forwardedBody = JSON.parse(captured.init.body);
    assert.equal(forwardedBody.model, "claude-sonnet-4-6-latest");
    assert.deepEqual(forwardedBody.messages, [{ role: "user", content: "hello" }]);
    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader("x-upstream"), "ok");
    assert.equal(res.writableEnded, true);
  } finally {
    global.fetch = originalFetch;
  }
});
