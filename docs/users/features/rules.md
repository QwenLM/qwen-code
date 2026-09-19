# Context rules

Rules are Markdown instructions for a workspace. Use a context file such as
`QWEN.md` for facts needed throughout a session, and conditional rules for
instructions relevant to particular files.

## Locations

- User rules: `rules/` under the Qwen configuration directory (normally
  `~/.qwen/rules/`).
- Project rules: `.qwen/rules/` under the effective project root.
- Extension rules: `rules/` under an enabled extension's root.

Markdown files are discovered recursively. Project and extension rules require
a trusted workspace. User rules retain their existing global scope. Safe and
bare modes skip rule discovery.

## Path conditions

Create `.qwen/rules/frontend.md`:

```markdown
---
paths:
  - 'src/**/*.tsx'
---

Use the shared UI components. Include an accessibility check when changing forms.
```

Patterns are relative to the workspace's effective project root, including for
extension rules; they do not refer to the extension installation directory.
When a supported file tool accesses a matching path, the rule is injected into
the conversation. Unrelated files do not activate it. Multiple patterns act as
alternatives, not simultaneous requirements. HTML comments are stripped.

Path-triggered injection uses the local file-tool pipeline. It is skipped when
the session uses an execution environment, whose filesystem paths may differ
from the host workspace. Do not move required remote-environment instructions
out of the always-on context based on this feature.

User and project rules without `paths:` are included in the initial context.
Extension rules must have nonempty `paths:`; otherwise they are skipped with a
debug warning. Use valid YAML rather than relying on frontmatter error recovery.

## Lifecycle and cost

A rule is consumed once by the current rules registry. Refreshing memory rebuilds
that registry, so a matching rule can be injected again after refresh. Disabling
an extension prevents its rules from being discovered on the next refresh; it
does not erase instructions already present in conversation history.

Conditional loading reduces the initial resident context only if the same text
is removed from the always-on context file. Once loaded, the rule may remain in
history and consume input tokens on subsequent requests. Instructions needed
before any file operation must remain in the always-on context.

For user-invoked procedures rather than file-specific guidance, consider a
[skill](skills.md). See the [extension migration example](../extension/getting-started-extensions.md#keep-scenario-instructions-out-of-resident-context).
