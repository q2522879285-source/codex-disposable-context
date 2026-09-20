# disposable-context

A small Node.js hook worker that starts a fresh Codex task after the current task explicitly closes an event.

## How it works

1. `UserPromptSubmit` adds the `EVENT_CLOSED` contract to the task context.
2. `Stop` queues a detached worker. The worker reads the completed thread through Codex `app-server`.
3. A fenced JSON object is accepted only when it has an `event_id` and no `open_issues`; a non-empty `next_event` requests rotation.
4. The worker stores a `STATE_V1` record atomically, starts a new task, and sends it the handoff plus `next_event`.

Normal replies are ignored; no rotation happens without the explicit marker.

## Install

Requires Node.js 18+ and a Codex installation exposing `codex app-server --stdio`. The current release is tested on Windows; on other platforms set `CODEX_BIN` to the app-server executable (or ensure `codex` is on `PATH`).

1. Copy this directory to a stable location.
2. Replace `<INSTALL_DIR>` in `hooks.example.json` with that absolute directory. Keep the path quoted when it contains spaces.
3. Merge the `hooks` entries into the user or project hooks file used by your Codex installation.
4. Run the self-check:

```sh
node orchestrator.mjs --self-test
```

The default runtime state is `~/.codex/disposable-context`. Set `DISPOSABLE_CONTEXT_ROOT` to override it. Set `CODEX_BIN` when the executable is not discoverable. Set `DISPOSABLE_CONTEXT_DRY_RUN=1` to validate parsing and state writes without starting a new task.

The runtime writes `orchestrator.log`, transient `queue` payloads, and `states` containing results, evidence, and possibly local paths. Store this directory with user-only permissions and clean old records according to your retention needs. A crashed worker can leave a queue file for inspection.

## Event contract

```json
{
  "type": "EVENT_CLOSED",
  "event_id": "unique-id",
  "goal": "completed goal",
  "result": "short result",
  "evidence": [],
  "changed_files": [],
  "decisions": [],
  "open_issues": [],
  "next_event": "next task",
  "evidence_paths": []
}
```

`event_id` is required. `open_issues` must be an empty array. The JSON must be inside a fenced block. If `next_event` is empty, the worker records the closed state and stops without creating another task. State files are written below `<root>/states/<source-thread-id>/`; queued payloads are transient and deleted after processing.

## Scope

Background turns cannot display approval UI; approval requests are denied and the handoff remains in the recorded state. The worker depends on the experimental `thread/start` API and compatible Codex app-server behavior. The bundled self-check covers parser behavior only; run a disposable projectless end-to-end test before enabling it for important work.

This project contains the hook worker only. It does not modify Codex configuration, upload state, or push to a remote repository.
