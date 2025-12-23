# Skills: Empowering Qwen Code with Expert Abilities

In Qwen Code, a **Skill** is a reusable set of expert instructions that equips the agent with a specific, well-defined ability. Think of skills as teaching the agent a new, durable capability that it can reliably execute to accomplish complex tasks, much like a human expert following a standard operating procedure (SOP).

By creating skills, you transform the agent from a general-purpose assistant into a specialized partner, capable of navigating your unique workflows, adhering to your project's standards, and interacting with your tools in a precise, predictable manner.

## The Philosophy Behind Skills

Skills are more than just prompts; they are structured, version-controlled workflows. They solve a critical challenge in working with AI agents: ensuring reliability and consistency. Instead of repeatedly explaining a complex process in a prompt, you can encapsulate that knowledge into a skill. The agent can then invoke this skill whenever needed, producing consistent and high-quality results. For a deeper dive into the philosophy behind agent skills, see Anthropic's post on [equipping agents with skills](https://claude.com/blog/skills-explained).

This approach allows you to build a library of trusted, battle-tested abilities for your agent, effectively customizing it for your specific domain, whether that's refactoring code according to your team's style guide, generating API documentation from source files, or running a complex data analysis pipeline.

## How Skills Work: On-Demand Loading

Skills are designed to be highly efficient by using an **on-demand loading** mechanism. This ensures that the agent's context window is not cluttered with information it doesn't immediately need.

Here's the workflow:

1.  **Initial Scan**: When a session starts, Qwen Code scans for all available skills but only loads their metadata (`name` and `description`). This lightweight list is presented to the agent, giving it an awareness of the available capabilities without consuming significant context.
2.  **Agent Decision**: Based on your prompt, the agent evaluates the descriptions of the available skills. If it determines that a specific skill is the right tool for the job, it decides to invoke it.
3.  **Full Skill Activation**: Only _after_ the agent decides to use a skill is the full content of the corresponding `SKILL.md` file loaded. This includes the detailed instructions and the file tree of any supporting files.
4.  **Contextual File Access**: The contents of supporting files within the skill's directory are not automatically loaded upon activation. The agent is empowered to decide _when_ and _how_ to access them. It will use its file-reading tools to load these files as needed, based on its interpretation of the task and the guidance you provide in the skill's instructions.

This lazy-loading approach makes skills scalable and efficient, allowing you to build an extensive library of complex abilities without overwhelming the agent.

## Anatomy of a Skill

A skill is a directory containing a special `SKILL.md` file and any supplementary files needed for the task.

- **`SKILL.md`**: The heart of the skill.
  - **Metadata (YAML Frontmatter)**: Defines the skill's `name` and `description`. A clear, concise description is crucial, as it's how the agent determines when the skill is appropriate for a given task.
  - **Instructions (Markdown)**: The detailed, step-by-step instructions for the agent to follow. This is where you codify the expert workflow.
- **Supporting Files**: Scripts, code templates, configuration files, or data samples can be included in the skill's directory. The agent can read these files on-demand to gain the necessary context to execute the instructions.

## Storage Levels: Project vs. Global

You can define skills at two levels, allowing for both shared, project-specific workflows and personal, global tools.

- **Project Skills**: Located in `.qwen/skills/` at the root of your project. These skills are version-controlled with your codebase, ensuring that your entire team has access to the same set of abilities. **Project skills override global skills with the same name.**
- **User (Global) Skills**: Located in `~/.qwen/skills/` in your home directory. These are your personal skills, available across all your projects.

## Managing Your Skillset

The `/skill` command is your entry point for managing the agent's abilities.

### Create a New Skill

To teach the agent a new skill, use the command:

```
/skill create
```

This launches an interactive wizard to guide you through defining the skill's name, description, initial instructions, and where to store it (Project or User level).

### Manage Existing Skills

To view, edit, or remove existing skills, use:

```
/skill manage
```

This opens a powerful management dialog that allows you to inspect and maintain your library of skills.

## Best Practices for Writing Effective Skills

Drawing inspiration from best practices in the field, here are some tips for creating powerful skills. For more detailed guidance, we highly recommend reading Anthropic's [best practices for agent skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).

- **Think Like a Manager, Write Like a Mentor**: Clearly define the goal, provide context, specify the expected output format, and give step-by-step instructions.
- **One Skill, One Job**: Keep skills focused on a single, well-defined task. This makes them more reliable and easier to debug.
- **Provide Examples**: If the task is complex, include a "good" example in the instructions to show the agent exactly what you're looking for.
- **Encourage Tool Use**: Explicitly tell the agent which tools (like `read_file`, `write_to_file`, or `execute_command`) it should use at each step.
- **Iterate and Refine**: The best skills are developed over time. Start with a simple version, test it, and gradually add detail and nuance based on the agent's performance.
