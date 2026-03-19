# Agent Skills

> Create, manage, and share Skills to extend Qwen Code's capabilities.

Skills are reusable instruction bundles that help Qwen Code handle specific
workflows more effectively. Each skill lives in its own directory and must
include a `SKILL.md` file with YAML frontmatter plus Markdown instructions.

## What are Skills?

Skills package domain knowledge, workflow instructions, and optional helper
files into a discoverable unit that the model can load when it is relevant.

### Benefits

- **Consistency**: Ensure Qwen Code follows the same procedures every time for repetitive tasks
- **Reusability**: Share skills across projects and with team members
- **Discoverability**: Skills are automatically loaded when relevant to your request
- **Customization**: Tailor Qwen Code's behavior to your specific workflows and conventions

A skill directory can include:

```text
my-skill/
├── SKILL.md
├── reference.md
├── examples.md
├── scripts/
│   └── helper.py
└── templates/
    └── template.txt
```

Use skills when you want Qwen Code to consistently follow a reusable procedure
for tasks like code review, docs updates, release prep, or environment-specific
workflows.

## How Skills are invoked

Skills are usually **model-invoked**. If your request matches a skill's
description, Qwen Code can load it automatically as its first step.

You can also invoke a skill explicitly:

```bash
/skills <skill-name>
```

Use `/skills` by itself to browse currently available skills.

### Bundled direct commands

Bundled skills can also expose direct slash commands. Qwen Code currently ships
one bundled skill:

| Skill    | How to invoke it              | What it does                                                               |
| -------- | ----------------------------- | -------------------------------------------------------------------------- |
| `review` | `/review` or `/skills review` | Reviews changed code, a PR, or a specific file for correctness and quality |

## Skill discovery and precedence

Qwen Code discovers skills from four levels:

| Level       | Location / Source                         | Notes                                               |
| ----------- | ----------------------------------------- | --------------------------------------------------- |
| `project`   | `.qwen/skills/`                           | Best for repository-specific and team-shared skills |
| `user`      | `~/.qwen/skills/`                         | Best for personal reusable workflows                |
| `extension` | Installed extension `skills/` directories | Shipped by an enabled extension                     |
| `bundled`   | Built into Qwen Code                      | Read-only skills shipped with the CLI               |

If multiple levels define the same skill name, Qwen Code uses this precedence:

```text
project > user > extension > bundled
```

That means a project skill named `review` overrides a user, extension, or
bundled skill with the same name.

## Create a Skill

Skills are directories containing a `SKILL.md` file.

### Personal Skills

Personal skills are available across all your projects:

```bash
mkdir -p ~/.qwen/skills/my-skill-name
```

Use personal skills for:

- Your own preferred workflows
- Skills you are still iterating on
- Cross-project helpers

### Project Skills

Project skills are shared with the repository:

```bash
mkdir -p .qwen/skills/my-skill-name
```

Use project skills for:

- Team conventions
- Repository-specific procedures
- Shared scripts and templates

## Write `SKILL.md`

Each skill must define `name` and `description` in YAML frontmatter, followed by
Markdown instructions.

```yaml
---
name: your-skill-name
description: Briefly explain what this skill does and when Qwen Code should use it
---

# Your Skill Name

## Instructions
Provide clear, concrete guidance for Qwen Code.

## Examples
Show realistic examples or workflows when helpful.
```

### Required fields

- `name`: non-empty string
- `description`: non-empty string

### Recommended conventions

- Use lowercase letters, numbers, and hyphens in `name`
- Make `description` specific about both:
  - what the skill does
  - when it should be used

## Add supporting files

Supporting files can live next to `SKILL.md` and be referenced from it:

````markdown
See [reference.md](reference.md) for detailed rules.

Run the helper script:

```bash
python scripts/helper.py input.txt
```
````

When a skill references relative paths, Qwen Code resolves them from the skill
directory.

## View available Skills

To list everything Qwen Code can currently use:

```bash
/skills
```

You can also inspect the filesystem directly:

```bash
# Personal skills
ls ~/.qwen/skills/

# Project skills
ls .qwen/skills/

# A specific skill manifest
cat ~/.qwen/skills/my-skill/SKILL.md
```

## Test and debug a Skill

After creating a skill, test it with requests that clearly match its
description.

Example:

```text
Can you help me extract text from this PDF?
```

### Common debugging checks

#### Make the description more specific

Too vague:

```yaml
description: Helps with documents
```

Better:

```yaml
description: Extract text and tables from PDF files, fill forms, and merge documents. Use when working with PDFs, forms, or document extraction.
```

#### Verify the file path

- Personal: `~/.qwen/skills/<skill-name>/SKILL.md`
- Project: `.qwen/skills/<skill-name>/SKILL.md`

```bash
ls ~/.qwen/skills/my-skill/SKILL.md
ls .qwen/skills/my-skill/SKILL.md
```

#### Check the YAML frontmatter

```bash
head -n 15 .qwen/skills/my-skill/SKILL.md
```

Make sure:

- line 1 starts with `---`
- the frontmatter closes with `---`
- the YAML is valid

#### View loader errors

```bash
qwen --debug
```

## Update or remove a Skill

Edit the manifest directly:

```bash
code ~/.qwen/skills/my-skill/SKILL.md
code .qwen/skills/my-skill/SKILL.md
```

Qwen Code watches skill directories, so updates are usually picked up
automatically. If you do not see the change reflected in `/skills` or model
behavior, restart the CLI.

Remove a skill by deleting its directory:

```bash
rm -rf ~/.qwen/skills/my-skill
rm -rf .qwen/skills/my-skill
```

## Share Skills with your team

Project skills can be committed like any other repository content:

```bash
git add .qwen/skills/
git commit -m "Add project skill for release prep"
git push
```

## Best practices

### Keep skills focused

Prefer one skill per capability:

- Good: "git commit messages", "PDF extraction", "docs audit"
- Too broad: "document processing"

### Write discoverable descriptions

Include the words users are likely to say:

```yaml
description: Analyze Excel spreadsheets, create pivot tables, and generate charts. Use when working with Excel files, spreadsheets, or .xlsx data.
```

### Use project skills for team policy

If a workflow depends on repo-specific tools, conventions, or scripts, store it
under `.qwen/skills/` so the whole team gets the same behavior.
