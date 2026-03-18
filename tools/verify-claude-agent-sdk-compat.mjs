import http from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultClaudeExecutable = "C:/Users/fi/.local/bin/claude.exe";
const markerPrefix = "__SCENARIO__:";
const unsupportedUpstreamKeys = ["metadata", "temperature", "top_p", "documents"];
const verbose = process.env.VERIFY_VERBOSE === "1";

function logVerbose(...args) {
  if (verbose) {
    console.error(...args);
  }
}

function normalizeWindowsPath(filePath) {
  return process.platform === "win32" ? filePath.replaceAll("/", "\\") : filePath;
}

async function reservePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = Number(address?.port || 0);
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not reserve a free TCP port.");
  return port;
}

async function resolveSdkModule() {
  if (process.env.CLAUDE_AGENT_SDK_MODULE) {
    return process.env.CLAUDE_AGENT_SDK_MODULE;
  }

  const bunCacheRoot = path.resolve(process.env.USERPROFILE || process.env.HOME || "", ".bun", "install", "cache", "@anthropic-ai", "claude-agent-sdk");
  if (!existsSync(bunCacheRoot)) {
    throw new Error(`Claude Agent SDK cache not found at ${bunCacheRoot}`);
  }

  const entries = await readDirNames(bunCacheRoot);
  const versions = entries.sort().reverse();
  for (const entry of versions) {
    const candidate = path.join(bunCacheRoot, entry, "sdk.mjs");
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(`Could not locate sdk.mjs in ${bunCacheRoot}`);
}

async function readDirNames(targetDir) {
  const { readdir } = await import("node:fs/promises");
  return readdir(targetDir);
}

async function getManagedProxyApiKey() {
  if (process.env.CLAUDE_AGENT_PROXY_API_KEY) return process.env.CLAUDE_AGENT_PROXY_API_KEY;
  const keyStorePath = path.join(repoRoot, "data", "api-keys.json");
  const raw = await readFile(keyStorePath, "utf8");
  const parsed = JSON.parse(raw);
  const firstKey = Array.isArray(parsed?.keys) ? parsed.keys.find((entry) => typeof entry?.value === "string" && entry.value.length > 0) : null;
  if (!firstKey?.value) {
    throw new Error(`No managed proxy API key found in ${keyStorePath}`);
  }
  return firstKey.value;
}

function extractScenarioNameFromInput(input) {
  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== "object") continue;
    if (item.role !== "user") continue;
    for (const block of Array.isArray(item.content) ? item.content : []) {
      if (!block || typeof block !== "object") continue;
      if (block.type !== "input_text") continue;
      const text = String(block.text || "");
      const match = text.match(new RegExp(`${markerPrefix}([a-z0-9_-]+)`));
      if (match) return match[1];
      const subagentMatch = text.match(/__SUBAGENT__:([a-z0-9_-]+)/i);
      if (subagentMatch) return `subagent:${subagentMatch[1]}`;
    }
  }
  return "";
}

function getScenarioOutputs(input, scenarioPrefix) {
  return (Array.isArray(input) ? input : []).filter((item) => {
    if (!item || typeof item !== "object") return false;
    if (item.type !== "function_call_output") return false;
    return typeof item.call_id === "string" && item.call_id.startsWith(`${scenarioPrefix}:`);
  });
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractTaskIdFromOutput(outputText) {
  const parsed = parseMaybeJson(outputText);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const key of ["task_id", "taskId", "shell_id", "shellId"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
  }
  const match = String(outputText || "").match(/"(task_id|taskId|shell_id|shellId)"\s*:\s*"([^"]+)"/);
  if (match?.[2]) return match[2];
  const backgroundMatch = String(outputText || "").match(/\bID:\s*([a-z0-9-]+)\b/i);
  return backgroundMatch?.[1] || "";
}

function extractCronIdFromOutput(outputText) {
  const parsed = parseMaybeJson(outputText);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (typeof parsed.id === "string" && parsed.id.trim().length > 0) return parsed.id.trim();
    if (typeof parsed.job_id === "string" && parsed.job_id.trim().length > 0) return parsed.job_id.trim();
  }
  const match = String(outputText || "").match(/"(id|job_id)"\s*:\s*"([^"]+)"/);
  if (match?.[2]) return match[2];
  const scheduledMatch = String(outputText || "").match(/\bjob\s+([a-z0-9-]+)\b/i);
  if (scheduledMatch?.[1]) return scheduledMatch[1];
  const listedMatch = String(outputText || "").match(/^([a-z0-9-]+)\s+[—-]\s+/i);
  return listedMatch?.[1] || "";
}

function buildFunctionCallResponse(body, scenarioName, stepIndex, toolName, args) {
  return {
    id: `resp_${scenarioName}_${stepIndex}`,
    model: body.model || "gpt-5.4",
    status: "completed",
    usage: {
      input_tokens: 1,
      output_tokens: 1
    },
    output: [
      {
        type: "function_call",
        call_id: `${scenarioName}:${stepIndex}`,
        name: toolName,
        arguments: JSON.stringify(args)
      }
    ]
  };
}

function buildFinalResponse(body, scenarioName, text) {
  return {
    id: `resp_${scenarioName}_done`,
    model: body.model || "gpt-5.4",
    status: "completed",
    usage: {
      input_tokens: 1,
      output_tokens: 1
    },
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text
          }
        ]
      }
    ]
  };
}

function buildMultiFunctionCallResponse(body, scenarioName, stepIndex, calls) {
  return {
    id: `resp_${scenarioName}_${stepIndex}`,
    model: body.model || "gpt-5.4",
    status: "completed",
    usage: {
      input_tokens: 1,
      output_tokens: 1
    },
    output: (Array.isArray(calls) ? calls : []).map((call, index) => ({
      type: "function_call",
      call_id: `${scenarioName}:${stepIndex}:${index + 1}`,
      name: call.name,
      arguments: JSON.stringify(call.args || {})
    }))
  };
}

function assertNoUnsupportedUpstreamFields(body, scenarioName) {
  for (const key of unsupportedUpstreamKeys) {
    assert.equal(body[key], undefined, `Scenario ${scenarioName} leaked unsupported upstream field "${key}"`);
  }
}

function collectToolUseErrors(logs, scenarioName) {
  return logs.flatMap((entry) =>
    (Array.isArray(entry.outputs) ? entry.outputs : [])
      .filter((output) => typeof output?.output === "string" && output.output.includes("<tool_use_error>"))
      .map((output) => ({
        scenarioName,
        callId: output.call_id,
        output: output.output
      }))
  );
}

function createScenarios(workspace) {
  const baseTemp = workspace.baseTemp;
  const readFilePath = normalizeWindowsPath(path.join(baseTemp, "read-target.txt"));
  const writeFilePath = normalizeWindowsPath(path.join(baseTemp, "write-target.txt"));
  const editFilePath = normalizeWindowsPath(path.join(baseTemp, "edit-target.txt"));
  const notebookPath = normalizeWindowsPath(path.join(baseTemp, "sample.ipynb"));
  const worktreeRepoPath = normalizeWindowsPath(workspace.worktreeRepoPath);

  return {
    text_stream: {
      tools: [],
      cwd: normalizeWindowsPath(repoRoot),
      maxDurationMs: 15000,
      handle({ body }) {
        return buildFinalResponse(body, "text_stream", "SCENARIO_OK text_stream");
      }
    },
    glob: {
      tools: ["Glob"],
      cwd: normalizeWindowsPath(repoRoot),
      maxDurationMs: 20000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "glob", 1, "Glob", {
            pattern: "**/package.json",
            path: normalizeWindowsPath(repoRoot)
          });
        }
        return buildFinalResponse(body, "glob", "SCENARIO_OK glob");
      }
    },
    grep: {
      tools: ["Grep"],
      cwd: normalizeWindowsPath(repoRoot),
      maxDurationMs: 20000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "grep", 1, "Grep", {
            pattern: "\"scripts\"",
            path: normalizeWindowsPath(path.join(repoRoot, "package.json")),
            output_mode: "content",
            "-n": true,
            head_limit: 5
          });
        }
        return buildFinalResponse(body, "grep", "SCENARIO_OK grep");
      }
    },
    read: {
      tools: ["Read"],
      cwd: normalizeWindowsPath(baseTemp),
      maxDurationMs: 20000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "read", 1, "Read", {
            file_path: readFilePath
          });
        }
        return buildFinalResponse(body, "read", "SCENARIO_OK read");
      }
    },
    bash: {
      tools: ["Bash"],
      cwd: normalizeWindowsPath(baseTemp),
      maxDurationMs: 25000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "bash", 1, "Bash", {
            command: "node -e \"process.stdout.write(process.cwd())\"",
            description: "Print current working directory"
          });
        }
        return buildFinalResponse(body, "bash", "SCENARIO_OK bash");
      }
    },
    write: {
      tools: ["Write"],
      cwd: normalizeWindowsPath(baseTemp),
      maxDurationMs: 20000,
      postCheck: async () => {
        const content = await readFile(writeFilePath, "utf8");
        assert.equal(content, "written by verify harness\n");
      },
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "write", 1, "Write", {
            file_path: writeFilePath,
            content: "written by verify harness\n"
          });
        }
        return buildFinalResponse(body, "write", "SCENARIO_OK write");
      }
    },
    edit: {
      tools: ["Read", "Edit"],
      cwd: normalizeWindowsPath(baseTemp),
      maxDurationMs: 20000,
      postCheck: async () => {
        const content = await readFile(editFilePath, "utf8");
        assert.equal(content, "hello edited world\n");
      },
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "edit", 1, "Read", {
            file_path: editFilePath
          });
        }
        if (outputs.length === 1) {
          return buildFunctionCallResponse(body, "edit", 2, "Edit", {
            file_path: editFilePath,
            old_string: "hello world\n",
            new_string: "hello edited world\n"
          });
        }
        return buildFinalResponse(body, "edit", "SCENARIO_OK edit");
      }
    },
    notebook_edit: {
      tools: ["NotebookEdit"],
      cwd: normalizeWindowsPath(baseTemp),
      maxDurationMs: 25000,
      postCheck: async () => {
        const raw = await readFile(notebookPath, "utf8");
        assert.match(raw, /Harness note/);
      },
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "notebook_edit", 1, "NotebookEdit", {
            notebook_path: notebookPath,
            edit_mode: "insert",
            cell_type: "markdown",
            new_source: "# Harness note"
          });
        }
        return buildFinalResponse(body, "notebook_edit", "SCENARIO_OK notebook_edit");
      }
    },
    web_search: {
      tools: ["WebSearch"],
      cwd: normalizeWindowsPath(repoRoot),
      maxDurationMs: 30000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "web_search", 1, "WebSearch", {
            query: "Anthropic homepage",
            allowed_domains: ["anthropic.com"]
          });
        }
        return buildFinalResponse(body, "web_search", "SCENARIO_OK web_search");
      }
    },
    web_fetch: {
      tools: ["WebFetch"],
      cwd: normalizeWindowsPath(repoRoot),
      maxDurationMs: 30000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "web_fetch", 1, "WebFetch", {
            url: "https://www.anthropic.com",
            prompt: "Return the main page title in one short sentence."
          });
        }
        return buildFinalResponse(body, "web_fetch", "SCENARIO_OK web_fetch");
      }
    },
    todo_write: {
      tools: ["TodoWrite"],
      cwd: normalizeWindowsPath(repoRoot),
      maxDurationMs: 20000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "todo_write", 1, "TodoWrite", {
            todos: [
              { content: "Inspect package.json", status: "completed", activeForm: "Inspecting package.json" },
              { content: "Report scripts", status: "in_progress", activeForm: "Reporting scripts" }
            ]
          });
        }
        return buildFinalResponse(body, "todo_write", "SCENARIO_OK todo_write");
      }
    },
    skill: {
      tools: ["Skill"],
      cwd: normalizeWindowsPath(repoRoot),
      maxDurationMs: 20000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "skill", 1, "Skill", {
            skill: "claude-api"
          });
        }
        return buildFinalResponse(body, "skill", "SCENARIO_OK skill");
      }
    },
    ask_user_question: {
      tools: ["AskUserQuestion"],
      cwd: normalizeWindowsPath(repoRoot),
      maxDurationMs: 20000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "ask_user_question", 1, "AskUserQuestion", {
            questions: [
              {
                question: "Which option should we choose?",
                header: "Choice",
                options: [
                  { label: "Alpha", description: "Pick alpha" },
                  { label: "Beta", description: "Pick beta" }
                ],
                multiSelect: false
              }
            ],
            answers: {
              Choice: "Alpha"
            }
          });
        }
        return buildFinalResponse(body, "ask_user_question", "SCENARIO_OK ask_user_question");
      }
    },
    plan_mode: {
      tools: ["EnterPlanMode", "ExitPlanMode"],
      cwd: normalizeWindowsPath(repoRoot),
      maxDurationMs: 25000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "plan_mode", 1, "EnterPlanMode", {});
        }
        if (outputs.length === 1) {
          return buildFunctionCallResponse(body, "plan_mode", 2, "ExitPlanMode", {});
        }
        return buildFinalResponse(body, "plan_mode", "SCENARIO_OK plan_mode");
      }
    },
    worktree: {
      tools: ["EnterWorktree", "ExitWorktree"],
      cwd: worktreeRepoPath,
      maxDurationMs: 40000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "worktree", 1, "EnterWorktree", {
            name: "agent-sdk-check"
          });
        }
        if (outputs.length === 1) {
          return buildFunctionCallResponse(body, "worktree", 2, "ExitWorktree", {
            action: "remove"
          });
        }
        return buildFinalResponse(body, "worktree", "SCENARIO_OK worktree");
      }
    },
    cron_flow: {
      tools: ["CronCreate", "CronList", "CronDelete"],
      cwd: normalizeWindowsPath(repoRoot),
      maxDurationMs: 25000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "cron_flow", 1, "CronCreate", {
            cron: "7 * * * *",
            prompt: "noop",
            recurring: true
          });
        }
        if (outputs.length === 1) {
          return buildFunctionCallResponse(body, "cron_flow", 2, "CronList", {});
        }
        if (outputs.length === 2) {
          const cronId = extractCronIdFromOutput(outputs[0].output);
          return buildFunctionCallResponse(body, "cron_flow", 3, "CronDelete", {
            id: cronId
          });
        }
        return buildFinalResponse(body, "cron_flow", "SCENARIO_OK cron_flow");
      }
    },
    task_output: {
      tools: ["Bash", "TaskOutput"],
      cwd: normalizeWindowsPath(baseTemp),
      maxDurationMs: 35000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "task_output", 1, "Bash", {
            command: "node -e \"setTimeout(() => {}, 2500)\"",
            description: "Start background node sleep",
            run_in_background: true
          });
        }
        if (outputs.length === 1) {
          const taskId = extractTaskIdFromOutput(outputs[0].output);
          return buildFunctionCallResponse(body, "task_output", 2, "TaskOutput", {
            task_id: taskId,
            block: false,
            timeout: 1000
          });
        }
        return buildFinalResponse(body, "task_output", "SCENARIO_OK task_output");
      }
    },
    task_stop: {
      tools: ["Bash", "TaskStop"],
      cwd: normalizeWindowsPath(baseTemp),
      maxDurationMs: 35000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "task_stop", 1, "Bash", {
            command: "node -e \"setTimeout(() => {}, 2500)\"",
            description: "Start background node sleep",
            run_in_background: true
          });
        }
        if (outputs.length === 1) {
          const taskId = extractTaskIdFromOutput(outputs[0].output);
          return buildFunctionCallResponse(body, "task_stop", 2, "TaskStop", {
            task_id: taskId
          });
        }
        return buildFinalResponse(body, "task_stop", "SCENARIO_OK task_stop");
      }
    },
    task_output_blocking: {
      tools: ["Bash", "TaskOutput"],
      cwd: normalizeWindowsPath(baseTemp),
      maxDurationMs: 40000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "task_output_blocking", 1, "Bash", {
            command: "node -e \"setTimeout(() => process.stdout.write('TASK_DONE'), 400)\"",
            description: "Start background task that prints marker",
            run_in_background: true
          });
        }
        if (outputs.length === 1) {
          const taskId = extractTaskIdFromOutput(outputs[0].output);
          return buildFunctionCallResponse(body, "task_output_blocking", 2, "TaskOutput", {
            task_id: taskId,
            block: true,
            timeout: 5000
          });
        }
        const finalOutput = String(outputs[1]?.output || "");
        assert.match(finalOutput, /TASK_DONE/i, "TaskOutput block=true did not capture final stdout");
        return buildFinalResponse(body, "task_output_blocking", "SCENARIO_OK task_output_blocking");
      }
    },
    task_stop_completed: {
      tools: ["Bash", "TaskOutput"],
      cwd: normalizeWindowsPath(baseTemp),
      maxDurationMs: 45000,
      handle({ body, outputs }) {
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "task_stop_completed", 1, "Bash", {
            command: "node -e \"process.stdout.write('DONE_FAST')\"",
            description: "Start short lived background task",
            run_in_background: true
          });
        }
        if (outputs.length === 1) {
          const taskId = extractTaskIdFromOutput(outputs[0].output);
          return buildFunctionCallResponse(body, "task_stop_completed", 2, "TaskOutput", {
            task_id: taskId,
            block: true,
            timeout: 5000
          });
        }
        if (outputs.length === 2) {
          const finalOutput = String(outputs[1]?.output || "");
          assert.match(finalOutput, /DONE_FAST/i, "Completed task output missing expected marker");
          return buildFinalResponse(
            body,
            "task_stop_completed",
            "SCENARIO_OK task_stop_completed"
          );
        }
        return buildFinalResponse(body, "task_stop_completed", "SCENARIO_OK task_stop_completed");
      }
    },
    agent_resume: {
      tools: ["Agent"],
      cwd: normalizeWindowsPath(repoRoot),
      maxDurationMs: 50000,
      handle({ body, scenarioName, outputs }) {
        if (scenarioName === "subagent:agent_resume") {
          return buildFinalResponse(body, "subagent_agent_resume", "SUBAGENT_OK agent_resume");
        }
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "agent_resume", 1, "Agent", {
            description: "Agent resume harness",
            prompt: `${markerPrefix}subagent:agent_resume Respond with SUBAGENT_OK agent_resume only.`,
            subagent_type: "general-purpose",
            run_in_background: true
          });
        }
        if (outputs.length === 1) {
          const output = String(outputs[0]?.output || "").trim();
          assert.ok(output.length > 0, "Agent background result was empty");
          const parsed = parseMaybeJson(output);
          const agentId =
            (parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? parsed.agent_id || parsed.id || parsed.task_id || parsed.taskId
              : "") || "";
          if (!agentId) {
            return buildFinalResponse(
              body,
              "agent_resume",
              "SCENARIO_OK agent_resume (background run did not expose a resumable id)"
            );
          }
          return buildFunctionCallResponse(body, "agent_resume", 2, "Agent", {
            description: "Resume agent harness",
            prompt: "Return the final resumed result.",
            subagent_type: "general-purpose",
            resume: agentId
          });
        }
        return buildFinalResponse(body, "agent_resume", "SCENARIO_OK agent_resume");
      }
    },
    agent_background: {
      tools: ["Agent"],
      cwd: normalizeWindowsPath(repoRoot),
      maxDurationMs: 45000,
      handle({ body, scenarioName, outputs }) {
        if (scenarioName === "subagent:agent_background") {
          return buildFinalResponse(body, "subagent_agent_background", "SUBAGENT_OK agent_background");
        }
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "agent_background", 1, "Agent", {
            description: "Agent background harness",
            prompt: `${markerPrefix}subagent:agent_background Respond with SUBAGENT_OK agent_background only.`,
            subagent_type: "general-purpose",
            run_in_background: true
          });
        }
        const output = String(outputs[0]?.output || "");
        assert.ok(output.trim().length > 0, "Background agent returned empty output");
        return buildFinalResponse(body, "agent_background", "SCENARIO_OK agent_background");
      }
    },
    agent: {
      tools: ["Agent"],
      cwd: normalizeWindowsPath(repoRoot),
      maxDurationMs: 45000,
      handle({ body, scenarioName, outputs }) {
        if (scenarioName === "subagent:agent") {
          return buildFinalResponse(body, "subagent_agent", "SUBAGENT_OK agent");
        }
        if (outputs.length === 0) {
          return buildFunctionCallResponse(body, "agent", 1, "Agent", {
            description: "Agent harness check",
            prompt: `${markerPrefix}subagent:agent Respond with SUBAGENT_OK agent only.`,
            subagent_type: "general-purpose"
          });
        }
        return buildFinalResponse(body, "agent", "SCENARIO_OK agent");
      }
    },
    parallel_sanitized_batch: {
      tools: ["Agent", "Read", "Bash", "WebSearch"],
      expectToolUses: ["Agent", "Bash", "WebSearch", "Read"],
      cwd: normalizeWindowsPath(baseTemp),
      maxDurationMs: 45000,
      handle({ body, scenarioName, outputs }) {
        if (scenarioName === "subagent:parallel_sanitized_batch") {
          return buildFinalResponse(body, "subagent_parallel_sanitized_batch", "SUBAGENT_OK parallel_sanitized_batch");
        }
        const hasStepOneOutputs = outputs.some((entry) =>
          typeof entry?.call_id === "string" && entry.call_id.startsWith("parallel_sanitized_batch:1:")
        );
        const hasStepTwoOutputs = outputs.some((entry) =>
          typeof entry?.call_id === "string" && entry.call_id.startsWith("parallel_sanitized_batch:2:")
        );

        if (!hasStepOneOutputs) {
          return buildMultiFunctionCallResponse(body, "parallel_sanitized_batch", 1, [
            {
              name: "Agent",
              args: {
                description: "Agent harness check",
                prompt: `${markerPrefix}subagent:parallel_sanitized_batch Respond with SUBAGENT_OK parallel_sanitized_batch only.`,
                subagent_type: "general-purpose",
                isolation: "worktree",
                resume: ""
              }
            },
            {
              name: "Bash",
              args: {
                command: "pwd",
                description: "Print working directory"
              }
            },
            {
              name: "WebSearch",
              args: {
                query: "Anthropic Claude API docs",
                allowed_domains: ["docs.anthropic.com"],
                blocked_domains: []
              }
            }
          ]);
        }
        if (!hasStepTwoOutputs) {
          return buildMultiFunctionCallResponse(body, "parallel_sanitized_batch", 2, [
            {
              name: "Read",
              args: {
                file_path: normalizeWindowsPath(path.join(repoRoot, "README.md")),
                offset: 0,
                limit: 2000,
                pages: ""
              }
            },
            {
              name: "Bash",
              args: {
                command: "pwd",
                description: "Print working directory"
              }
            }
          ]);
        }
        return buildFinalResponse(body, "parallel_sanitized_batch", "SCENARIO_OK parallel_sanitized_batch");
      }
    },
    content_assertions: {
      tools: ["Glob", "Grep", "Read", "Bash"],
      expectToolUses: ["Glob", "Grep", "Read", "Bash"],
      cwd: normalizeWindowsPath(repoRoot),
      maxDurationMs: 45000,
      handle({ body, outputs }) {
        const hasStepOneOutputs = outputs.some((entry) => typeof entry?.call_id === "string" && entry.call_id.startsWith("content_assertions:1:"));
        const hasStepTwoOutputs = outputs.some((entry) => typeof entry?.call_id === "string" && entry.call_id.startsWith("content_assertions:2:"));

        if (!hasStepOneOutputs) {
          return buildMultiFunctionCallResponse(body, "content_assertions", 1, [
            {
              name: "Glob",
              args: {
                pattern: "package.json",
                path: normalizeWindowsPath(repoRoot)
              }
            },
            {
              name: "Grep",
              args: {
                pattern: '"verify:claude-agent-sdk"',
                path: normalizeWindowsPath(path.join(repoRoot, "package.json")),
                output_mode: "content",
                "-n": true,
                head_limit: 5
              }
            }
          ]);
        }
        if (!hasStepTwoOutputs) {
          const grepOutput = String(outputs.find((entry) => entry.call_id === "content_assertions:1:2")?.output || "");
          assert.match(grepOutput, /verify:claude-agent-sdk/i, "Grep output missing expected script name");
          return buildMultiFunctionCallResponse(body, "content_assertions", 2, [
            {
              name: "Read",
              args: {
                file_path: normalizeWindowsPath(path.join(repoRoot, "package.json"))
              }
            },
            {
              name: "Bash",
              args: {
                command: "node -p \"process.cwd()\"",
                description: "Print exact working directory"
              }
            }
          ]);
        }
        const readOutput = String(outputs.find((entry) => entry.call_id === "content_assertions:2:1")?.output || "");
        const bashOutput = String(outputs.find((entry) => entry.call_id === "content_assertions:2:2")?.output || "");
        assert.match(readOutput, /codex-pro-max/i, "Read output missing expected package content");
        assert.match(bashOutput, /codex-pro-max/i, "Bash output missing expected cwd");
        return buildFinalResponse(body, "content_assertions", "SCENARIO_OK content_assertions");
      }
    }
  };
}

async function createWorkspace() {
  const baseTemp = await mkdtemp(path.join(os.tmpdir(), "claude-agent-sdk-compat-"));
  const worktreeRepoPath = path.join(baseTemp, "worktree-repo");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(worktreeRepoPath, { recursive: true });
  await writeFile(path.join(baseTemp, "read-target.txt"), "read target\n", "utf8");
  await writeFile(path.join(baseTemp, "edit-target.txt"), "hello world\n", "utf8");
  await writeFile(
    path.join(baseTemp, "sample.ipynb"),
    JSON.stringify(
      {
        cells: [
          {
            cell_type: "markdown",
            id: "cell-1",
            metadata: {},
            source: ["# Original\n"]
          }
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5
      },
      null,
      2
    ),
    "utf8"
  );
  await initializeTempGitRepo(worktreeRepoPath);
  return { baseTemp, worktreeRepoPath };
}

async function initializeTempGitRepo(repoPath) {
  await execProcess("git", ["init"], { cwd: repoPath });
  await execProcess("git", ["config", "user.email", "verify@example.com"], { cwd: repoPath });
  await execProcess("git", ["config", "user.name", "Verify Harness"], { cwd: repoPath });
  await writeFile(path.join(repoPath, "README.md"), "temp repo\n", "utf8");
  await execProcess("git", ["add", "README.md"], { cwd: repoPath });
  await execProcess("git", ["commit", "-m", "init"], { cwd: repoPath });
}

async function execProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const [code] = await once(child, "close");
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`.trim());
  }
  return { stdout, stderr };
}

async function startFakeUpstream(scenarios) {
  const port = await reservePort();
  const logs = [];

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/codex/responses") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "not found" }));
      return;
    }

    let rawBody = "";
    for await (const chunk of req) rawBody += chunk.toString("utf8");
    const body = JSON.parse(rawBody);
    const scenarioName = extractScenarioNameFromInput(body.input);
    const scenario = scenarios[scenarioName];
    if (!scenario) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(buildFinalResponse(body, "fallback", "SCENARIO_OK fallback")));
      return;
    }

    assertNoUnsupportedUpstreamFields(body, scenarioName);
    const outputs = getScenarioOutputs(body.input, scenarioName);
    logs.push({
      scenarioName,
      body,
      outputs
    });

    const response = await scenario.handle({
      body,
      outputs,
      scenarioName
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });

  server.listen(port, "127.0.0.1");
  await once(server, "listening");

  return {
    port,
    logs,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function startProxyServer(proxyPort, upstreamPort) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(proxyPort),
      UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const readyDeadline = Date.now() + 20000;
  while (Date.now() < readyDeadline) {
    if (stdout.includes(`http://127.0.0.1:${proxyPort}`)) {
      return {
        child,
        getStdout: () => stdout,
        getStderr: () => stderr,
        async stop() {
          if (child.exitCode !== null) return;
          child.kill("SIGINT");
          await once(child, "close");
        }
      };
    }
    if (child.exitCode !== null) {
      throw new Error(`Proxy exited early: ${stderr || stdout}`);
    }
    await sleep(100);
  }

  child.kill("SIGKILL");
  throw new Error(`Timed out waiting for proxy startup on port ${proxyPort}. ${stderr || stdout}`);
}

async function runScenario({ name, scenario, query, proxyPort, apiKey }) {
  const stderrChunks = [];
  const toolUses = [];
  const startedAt = Date.now();
  const prompt = `${markerPrefix}${name} Please complete the harness step exactly.`;
  const options = {
    cwd: scenario.cwd,
    tools: scenario.tools,
    allowedTools: scenario.tools,
    includePartialMessages: true,
    maxTurns: 8,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE || defaultClaudeExecutable,
    stderr: (chunk) => stderrChunks.push(String(chunk))
  };

  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  process.env.ANTHROPIC_API_KEY = apiKey;
  process.env.ANTHROPIC_AUTH_TOKEN = apiKey;

  let resultMessage = null;
  const timeoutMs = scenario.maxDurationMs || 30000;
  const queryIterator = query({ prompt, options });
  const timeout = setTimeout(() => {
    try {
      queryIterator.return?.();
    } catch {}
  }, timeoutMs).unref();

  try {
    for await (const message of queryIterator) {
      logVerbose(`[${name}] message`, JSON.stringify(message));
      if (message.type === "assistant") {
        for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
          if (block?.type === "tool_use" && typeof block.name === "string") {
            toolUses.push(block.name);
          }
        }
      }
      if (message.type === "result") {
        resultMessage = message;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  if (!resultMessage || resultMessage.subtype !== "success" || resultMessage.is_error) {
    throw new Error(`Scenario ${name} did not finish successfully. stderr=${stderrChunks.join("")}`);
  }
  if (stderrChunks.length > 0) {
    throw new Error(`Scenario ${name} emitted stderr: ${stderrChunks.join("")}`);
  }
  const durationMs = Date.now() - startedAt;
  if (durationMs > timeoutMs) {
    throw new Error(`Scenario ${name} exceeded timeout (${durationMs}ms > ${timeoutMs}ms).`);
  }
  const expectedToolUses =
    Array.isArray(scenario.expectToolUses) && scenario.expectToolUses.length > 0
      ? scenario.expectToolUses
      : scenario.tools;
  if (Array.isArray(expectedToolUses) && expectedToolUses.length > 0) {
    for (const toolName of expectedToolUses) {
      if (["TaskOutput", "TaskStop", "ExitWorktree", "ExitPlanMode", "CronDelete", "CronList"].includes(toolName)) {
        continue;
      }
      assert.ok(toolUses.includes(toolName), `Scenario ${name} did not surface tool_use for ${toolName}`);
    }
  }
  await scenario.postCheck?.();
  return {
    durationMs,
    toolUses,
    result: resultMessage.result
  };
}

async function main() {
  const sdkModulePath = await resolveSdkModule();
  const { query } = await import(pathToFileURL(sdkModulePath).href);
  const apiKey = await getManagedProxyApiKey();
  const workspace = await createWorkspace();
  const scenarios = createScenarios(workspace);
  const fakeUpstream = await startFakeUpstream(scenarios);
  const proxyPort = await reservePort();
  const proxy = await startProxyServer(proxyPort, fakeUpstream.port);

  const summary = [];
  try {
    const selectedScenarios = new Set(
      String(process.env.VERIFY_SCENARIOS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    );
    const entries = Object.entries(scenarios).filter(([name]) => selectedScenarios.size === 0 || selectedScenarios.has(name));

    for (const [name, scenario] of entries) {
      try {
        logVerbose(`Running scenario ${name}`);
        const result = await runScenario({
          name,
          scenario,
          query,
          proxyPort,
          apiKey
        });
        const relatedLogs = fakeUpstream.logs.filter((entry) => entry.scenarioName === name);
        const toolUseErrors = collectToolUseErrors(relatedLogs, name);
        assert.equal(toolUseErrors.length, 0, `Scenario ${name} had tool_use errors: ${JSON.stringify(toolUseErrors)}`);
        summary.push({
          name,
          durationMs: result.durationMs,
          toolUses: result.toolUses,
          result: result.result
        });
      } catch (error) {
        const relatedLogs = fakeUpstream.logs.filter((entry) => entry.scenarioName === name);
        console.error(
          JSON.stringify(
            {
              failedScenario: name,
              error: error && error.stack ? error.stack : String(error),
              upstreamLogs: relatedLogs
            },
            null,
            2
          )
        );
        throw error;
      }
    }

    const coveredTools = new Set(summary.flatMap((entry) => entry.toolUses));
    console.log(JSON.stringify({ ok: true, summary, coveredTools: [...coveredTools].sort() }, null, 2));
  } finally {
    await proxy.stop().catch(() => {});
    await fakeUpstream.close().catch(() => {});
    await rm(workspace.baseTemp, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
