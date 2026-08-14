# Architecture

See PLAN-v0.1.md §2–§4 for the authoritative design. This file records the
implemented structure as it lands.

## Layers

```
governor-core (pure engine, zero Cordis)
      ↑ feeds/consumes
dsh-governor (function plugin: name/inject/Config/apply)
      ↑ patch row
dsh-bundle (dsh.bundle.patch contract) / benchmark patches
```

## DSH extension points used

| Concern | DSH hook |
|---|---|
| Observe every tool call | `tools/post-execute` waterfall |
| Attach next-request context | `PostToolDecision.additionalContexts` |
| Completion boundary | `agent/turn-stopping` + `agent.steer()` |
| User interjection reset | `agent/pre-step` |
| Capability disclosure | `ctx.tools.restrict()` |
| Durability/replay | session log events (`tool/call`, `tool/result`, `assistant/message`) |

## Invariants

- Model-visible ⟺ logged: every steer/reminder is a plugin-source `user/message`.
- No second log: all facts are derived state, rebuilt from the session log on resume.
- Never veto in v0.1: observe-and-enrich only; the strongest action is a bounded steer.
