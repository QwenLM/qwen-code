# Subagent Model Grade Selection

## Goal

Let the model choose a user-defined model grade when spawning a regular
subagent without exposing provider-specific model IDs in the Agent tool
schema.

```json
{
  "agents": {
    "modelGrades": {
      "small": "fast",
      "high": "qwen-max"
    },
    "allowedGrades": ["small", "high"]
  }
}
```

The Agent tool advertises `model: "small" | "high"` and resolves the selected
grade immediately after loading the subagent configuration.

## Resolution

The effective model selector uses this priority:

1. A non-built-in agent's explicit, non-`inherit` model
2. An allowed grade mapped by `agents.modelGrades`
3. The built-in Explore model setting
4. The inherited parent model

Unknown or disallowed grades are rejected. Forks reject the parameter because
they must inherit the parent's model and prompt cache. Named team teammates
also reject it because their backend model override accepts concrete model IDs
rather than grade selectors.

Only configured, allowed grade names are included in the dynamic tool schema.
Concrete model selectors remain private to user settings.

## Verification

- Settings schema and CLI-to-core configuration forwarding
- Grade resolution, allowlist filtering, and custom-agent priority
- Dynamic Agent tool schema without concrete model IDs
- Regular foreground and background dispatch using the resolved model
- Fork validation
