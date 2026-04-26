import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCodexCollaborationModeResolver,
  extractCodexTurnMetadata
} from "../src/codex-collaboration-mode.js";

test("extractCodexTurnMetadata reads session and turn ids from client metadata", () => {
  const metadata = extractCodexTurnMetadata({
    prompt_cache_key: "sess_fallback",
    client_metadata: {
      "x-codex-turn-metadata": "{\"session_id\":\"sess_123\",\"turn_id\":\"turn_456\"}"
    }
  });

  assert.deepEqual(metadata, {
    sessionId: "sess_123",
    turnId: "turn_456"
  });
});

test("extractCodexTurnMetadata keeps prompt cache session id when turn metadata is absent", () => {
  const metadata = extractCodexTurnMetadata({
    prompt_cache_key: "sess_without_turn",
    client_metadata: {
      "x-codex-installation-id": "install_123"
    }
  });

  assert.deepEqual(metadata, {
    sessionId: "sess_without_turn",
    turnId: ""
  });
});

test("Codex collaboration mode resolver bridges plan mode and mode-default instructions from local session logs", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-collab-mode-"));
  const sessionDir = path.join(codexHome, "sessions", "2026", "04", "24");
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionId = "sess_plan_123";
  const turnId = "turn_plan_456";
  const sessionFile = path.join(sessionDir, `rollout-2026-04-24T00-00-00-${sessionId}.jsonl`);
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: sessionId,
          base_instructions: {
            text: "Base instructions"
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: turnId,
          collaboration_mode_kind: "plan"
        }
      })
    ].join("\n"),
    "utf8"
  );

  const resolver = createCodexCollaborationModeResolver({ codexHome });
  const bridged = await resolver.bridgeRequest({
    model: "gpt-5.4",
    prompt_cache_key: sessionId,
    instructions: "Base instructions",
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        session_id: sessionId,
        turn_id: turnId
      })
    },
    input: "hello"
  });

  assert.equal(bridged.collaborationMode, "plan");
  assert.equal(bridged.settings?.developer_instructions, null);
});

test("Codex collaboration mode resolver ignores session filename substring collisions", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-collab-mode-collision-"));
  const sessionDir = path.join(codexHome, "sessions", "2026", "04", "24");
  const archivedSessionDir = path.join(codexHome, "archived_sessions", "2026", "04", "24");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(archivedSessionDir, { recursive: true });

  const sessionId = "sess_collision_target";
  const collisionSessionId = `${sessionId}-shadow`;
  const exactFile = path.join(archivedSessionDir, `rollout-2026-04-24T00-00-01-${sessionId}.jsonl`);
  const collisionFile = path.join(sessionDir, `rollout-2026-04-24T00-00-00-${collisionSessionId}.jsonl`);
  await fs.writeFile(
    collisionFile,
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn_shadow",
        collaboration_mode_kind: "default"
      }
    }) + "\n",
    "utf8"
  );
  await fs.writeFile(
    exactFile,
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn_target",
        collaboration_mode_kind: "plan"
      }
    }) + "\n",
    "utf8"
  );

  const resolver = createCodexCollaborationModeResolver({ codexHome, turnModeResolveTimeoutMs: 0 });
  assert.equal(await resolver.findSessionFile(sessionId), exactFile);
});

test("Codex collaboration mode resolver falls back to latest structured session mode without turn metadata", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-collab-mode-latest-"));
  const sessionDir = path.join(codexHome, "sessions", "2026", "04", "24");
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionId = "sess_latest_plan_123";
  const sessionFile = path.join(sessionDir, `rollout-2026-04-24T00-00-00-${sessionId}.jsonl`);
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: sessionId,
          base_instructions: {
            text: "Base instructions"
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn_default_older",
          collaboration_mode_kind: "default"
        }
      }),
      JSON.stringify({
        type: "turn_context",
        payload: {
          turn_id: "turn_plan_latest",
          collaboration_mode: {
            mode: "plan"
          }
        }
      })
    ].join("\n"),
    "utf8"
  );

  const resolver = createCodexCollaborationModeResolver({ codexHome, turnModeResolveTimeoutMs: 300 });
  const startedAt = Date.now();
  const bridged = await resolver.bridgeRequest({
    model: "gpt-5.4",
    prompt_cache_key: sessionId,
    instructions: "Base instructions",
    client_metadata: {
      "x-codex-installation-id": "install_123"
    },
    input: "hello"
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(bridged.collaborationMode, "plan");
  assert.equal(bridged.settings?.developer_instructions, null);
  assert.ok(elapsedMs < 250, `expected latest plan mode to resolve without waiting, took ${elapsedMs}ms`);
});

test("Codex collaboration mode resolver waits for latest session mode when request lacks turn metadata", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-collab-mode-latest-race-"));
  const sessionDir = path.join(codexHome, "sessions", "2026", "04", "24");
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionId = "sess_latest_race_123";
  const sessionFile = path.join(sessionDir, `rollout-2026-04-24T00-00-00-${sessionId}.jsonl`);
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: sessionId,
          base_instructions: {
            text: "Base instructions"
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn_default_stale",
          collaboration_mode_kind: "default"
        }
      })
    ].join("\n") + "\n",
    "utf8"
  );

  const resolver = createCodexCollaborationModeResolver({ codexHome, turnModeResolveTimeoutMs: 300 });
  const appendTurn = new Promise((resolve) => {
    setTimeout(async () => {
      await fs.appendFile(
        sessionFile,
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn_plan_current",
            collaboration_mode_kind: "plan"
          }
        }) + "\n",
        "utf8"
      );
      resolve();
    }, 50);
  });

  const bridged = await resolver.bridgeRequest({
    model: "gpt-5.4",
    prompt_cache_key: sessionId,
    instructions: "Base instructions",
    client_metadata: {
      "x-codex-installation-id": "install_123"
    },
    input: "hello"
  });
  await appendTurn;

  assert.equal(bridged.collaborationMode, "plan");
  assert.equal(bridged.settings?.developer_instructions, null);
});

test("Codex collaboration mode resolver re-scans newer rollout files for the same session", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-collab-mode-rollout-refresh-"));
  const sessionDir = path.join(codexHome, "sessions", "2026", "04", "24");
  await fs.mkdir(sessionDir, { recursive: true });

  const sessionId = "sess_rollout_refresh_123";
  const oldSessionFile = path.join(sessionDir, `rollout-2026-04-24T00-00-00-${sessionId}.jsonl`);
  const newSessionFile = path.join(sessionDir, `rollout-2026-04-24T00-00-01-${sessionId}.jsonl`);
  const newTurnId = "turn_refresh_plan";
  await fs.writeFile(
    oldSessionFile,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: sessionId,
          base_instructions: {
            text: "Base instructions"
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn_old_default",
          collaboration_mode_kind: "default"
        }
      })
    ].join("\n"),
    "utf8"
  );

  const resolver = createCodexCollaborationModeResolver({ codexHome, turnModeResolveTimeoutMs: 0 });
  assert.equal(await resolver.findSessionFile(sessionId), oldSessionFile);
  assert.equal((await resolver.loadSessionState(sessionId))?.latestTurnId, "turn_old_default");

  await fs.writeFile(
    newSessionFile,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: sessionId,
          base_instructions: {
            text: "Base instructions"
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: newTurnId,
          collaboration_mode_kind: "plan"
        }
      })
    ].join("\n"),
    "utf8"
  );

  const bridged = await resolver.bridgeRequest({
    model: "gpt-5.4",
    instructions: "Base instructions",
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        session_id: sessionId,
        turn_id: newTurnId
      })
    },
    input: "hello"
  });

  assert.equal(await resolver.findSessionFile(sessionId), newSessionFile);
  assert.equal(bridged.collaborationMode, "plan");
  assert.equal(bridged.settings?.developer_instructions, null);
});

test("Codex collaboration mode resolver waits briefly for the current turn mode to be written", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-collab-mode-race-"));
  const sessionDir = path.join(codexHome, "sessions", "2026", "04", "24");
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionId = "sess_race_123";
  const turnId = "turn_race_456";
  const sessionFile = path.join(sessionDir, `rollout-2026-04-24T00-00-00-${sessionId}.jsonl`);
  await fs.writeFile(
    sessionFile,
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: sessionId,
        base_instructions: {
          text: "Base instructions"
        }
      }
    }) + "\n",
    "utf8"
  );

  const resolver = createCodexCollaborationModeResolver({ codexHome, turnModeResolveTimeoutMs: 300 });
  const appendTurn = new Promise((resolve) => {
    setTimeout(async () => {
      await fs.appendFile(
        sessionFile,
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: turnId,
            collaboration_mode_kind: "plan"
          }
        }) + "\n",
        "utf8"
      );
      resolve();
    }, 50);
  });

  const bridged = await resolver.bridgeRequest({
    model: "gpt-5.4",
    prompt_cache_key: sessionId,
    instructions: "Base instructions",
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        session_id: sessionId,
        turn_id: turnId
      })
    },
    input: "hello"
  });
  await appendTurn;

  assert.equal(bridged.collaborationMode, "plan");
  assert.equal(bridged.settings?.developer_instructions, null);
});

test("Codex collaboration mode resolver does not apply stale default mode after timeout without turn metadata", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-collab-mode-stale-default-"));
  const sessionDir = path.join(codexHome, "sessions", "2026", "04", "24");
  await fs.mkdir(sessionDir, { recursive: true });

  const sessionId = "sess_stale_default_123";
  const sessionFile = path.join(sessionDir, `rollout-2026-04-24T00-00-00-${sessionId}.jsonl`);
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: sessionId,
          base_instructions: {
            text: "Base instructions"
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn_stale_default",
          collaboration_mode_kind: "default"
        }
      })
    ].join("\n"),
    "utf8"
  );

  const resolver = createCodexCollaborationModeResolver({ codexHome, turnModeResolveTimeoutMs: 75 });
  const bridged = await resolver.bridgeRequest({
    model: "gpt-5.4",
    prompt_cache_key: sessionId,
    instructions: "Base instructions",
    client_metadata: {
      "x-codex-installation-id": "install_123"
    },
    input: "hello"
  });

  assert.equal(Object.hasOwn(bridged, "collaborationMode"), false);
  assert.equal(Object.hasOwn(bridged, "settings"), false);
});

test("Codex collaboration mode resolver does not override explicit instructions or explicit mode", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-collab-mode-"));
  const sessionDir = path.join(codexHome, "sessions", "2026", "04", "24");
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionId = "sess_default_123";
  const turnId = "turn_default_456";
  const sessionFile = path.join(sessionDir, `rollout-2026-04-24T00-00-00-${sessionId}.jsonl`);
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: sessionId,
          base_instructions: {
            text: "Base instructions"
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: turnId,
          collaboration_mode_kind: "plan"
        }
      })
    ].join("\n"),
    "utf8"
  );

  const resolver = createCodexCollaborationModeResolver({ codexHome });
  const bridged = await resolver.bridgeRequest({
    model: "gpt-5.4",
    collaborationMode: "default",
    instructions: "User override instructions",
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        session_id: sessionId,
        turn_id: turnId
      })
    },
    input: "hello"
  });

  assert.equal(bridged.collaborationMode, "default");
  assert.equal(Object.hasOwn(bridged, "settings"), false);
  assert.equal(bridged.instructions, "User override instructions");
});
