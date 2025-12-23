# Tool: skill

Use the `skill` tool to activate a pre-defined Skill and load its expert instructions into the conversation. This allows the agent to follow complex, standardized workflows for specific tasks.

## Description

The `skill` tool serves as the bridge between the agent's reasoning process and the library of available skills. When the agent identifies that a user's request matches the capability of a known skill (based on the skill's name and description), it uses this tool to formally activate it.

Upon activation, the tool injects the skill's detailed instructions, its file path, and a file tree of its supporting files into the agent's context. This provides the agent with a comprehensive "standard operating procedure" (SOP) to follow.

## Arguments

- `skill` (string, required): The unique name of the skill to activate. This must match one of the names from the available skills list.

## How to use `skill` with Qwen Code

The agent autonomously decides when to use the `skill` tool. Your role is to create high-quality skills with clear, descriptive names and descriptions, making it easy for the agent to discover and use them at the right time.

```python
# Agent's internal thought process might look like this:
# "The user wants to refactor a component according to the team's style guide.
# The 'component-refactor' skill seems perfect for this. I will activate it."

skill(skill="component-refactor")
```

## Available Skills

The list of available skills is dynamic and depends on the user and project context. The agent is always aware of the skills it can use, as it receives a lightweight list of all available project-level and user-level skills at the beginning of a session.

You can view, create, and manage all available skills using the `/skill manage` and `/skill create` commands in the Qwen Code terminal.

## Important Notes

- **On-Demand Activation**: The `skill` tool only loads the _metadata_ (name, description) of all skills initially. The full instructions and file context are only loaded _after_ the tool is called for a specific skill, making the process highly efficient.
- **Contextual File Access**: Once a skill is activated, the agent still needs to use its file-system tools (e.g., `read_file`) to access any supporting files within the skill's directory. The content of these files is not automatically injected into the context.
- **Stateless by Nature**: Each `skill()` invocation is a fresh activation. The agent does not retain memory of a previous skill execution unless that information is part of the ongoing conversation history.

For more information on the user-facing aspects and philosophy of skills, refer to the [Skills user guide](../../users/features/skills.md).
