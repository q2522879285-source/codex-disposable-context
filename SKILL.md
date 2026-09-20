---
name: disposable-context
description: Rotate a completed Codex event into a fresh task with a minimal STATE_V1 handoff. Use for stage-based work where finished events should stop carrying old conversational context; do not use for an unfinished event or when unresolved issues remain.
---

# Disposable Context

Use event-driven rotation, not a context-size threshold. Treat one meaningful unit of work as one event.

## Completion contract

Only when the current event is genuinely complete, `open_issues` is empty, and a next event exists, end the response with exactly one fenced JSON block:

```json
{
  "type": "EVENT_CLOSED",
  "event_id": "stable-unique-id",
  "goal": "what this event was for",
  "result": "short completed result",
  "evidence": [],
  "changed_files": [],
  "decisions": [],
  "open_issues": [],
  "next_event": "the next bounded event",
  "evidence_paths": []
}
```

Do not emit the marker for ordinary replies, partial work, unresolved issues, or a conversation with no next event. If the event is complete but there is no next event, the marker may record the closure with an empty `next_event`; the hook records it without creating a new task.

## Handoff boundary

Keep the handoff minimal: completed result, constraints, decisions, evidence paths, and the next event. Do not copy the old transcript. Long-term rules, user preferences, credentials, and durable decisions are not disposable state and must not be overwritten by rotation.

The global hook consumes `EVENT_CLOSED`, writes `STATE_V1`, starts a fresh task in the same project/cwd, and injects the handoff. If the hook or experimental thread API is unavailable, continue in the current task and report the concrete blocker; never simulate a new task through UI clicks.

## Operational split

- Skill: decide when and how to emit the closure contract.
- Hook: add the contract at prompt time and queue post-turn processing.
- Orchestrator: validate the event, persist `STATE_V1`, create the next task, and inject the handoff.
- `STATE_V1`: the only disposable handoff record for this event.
