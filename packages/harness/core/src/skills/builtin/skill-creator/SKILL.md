---
name: skill-creator
description:
  Guide for creating effective skills. This skill should be used when users want
  to create a new skill (or update an existing skill) that extends the CLI's
  capabilities with specialized knowledge, workflows, or tool integrations.
allowed-tools: Edit, Write
---

# Skill Creator for Qwen Code

This skill provides guidance for creating effective skills.

## About Skills

Skills are modular, self-contained packages that extend Qwen Code's
capabilities by providing specialized knowledge, workflows, and tools. Think of
them as "onboarding guides" for specific domains or tasks. They transform the
Qwen Code from a general-purpose agent into a specialized agent equipped with
procedural knowledge that no model can fully possess.

### What Skills Provide

1. Specialized workflows - Multi-step procedures for specific domains
2. Tool integrations - Instructions for working with specific file formats or
   APIs
3. Domain expertise - Company-specific knowledge, schemas, business logic
4. Bundled resources - Scripts, references, and assets for complex and
   repetitive tasks

## Core Principles

### Concise is Key

The context window is a public good. Skills share the context window with
everything else Qwen Code needs: system prompt, conversation history, other
Skills' metadata, and the actual user request.

**Default assumption: Qwen Code is already very smart.** Only add context
Qwen Code doesn't already have. Challenge each piece of information: "Does
Qwen Code really need this explanation?" and "Does this paragraph justify its
token cost?"

Prefer concise examples over verbose explanations.

### Set Appropriate Degrees of Freedom

Match the level of specificity to the task's fragility and variability:

**High freedom (text-based instructions)**: Use when multiple approaches are
valid, decisions depend on context, or heuristics guide the approach.

**Medium freedom (pseudocode or scripts with parameters)**: Use when a preferred
pattern exists, some variation is acceptable, or configuration affects behavior.

**Low freedom (specific scripts, few parameters)**: Use when operations are
fragile and error-prone, consistency is critical, or a specific sequence must be
followed.

### Anatomy of a Skill

Every skill consists of a required SKILL.md file and optional bundled resources:

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter metadata (required)
│   │   ├── name: (required)
│   │   ├── description: (required)
│   │   └── model/tools/when_to_use/... (optional)
│   └── Markdown instructions (required)
└── Bundled Resources (optional)
    ├── scripts/          - Executable code (Node.js/Python/Bash/etc.)
    ├── references/       - Documentation intended to be loaded into context as needed
    └── assets/           - Files used in output (templates, icons, fonts, etc.)
```

#### SKILL.md (required)

Every SKILL.md consists of:

- **Frontmatter** (YAML): Contains `name` and `description` fields. These are
  the only fields that Qwen Code reads to determine when the skill gets used,
  thus it is very important to be clear and comprehensive in describing what the
  skill is, and when it should be used.
- **Body** (Markdown): Instructions and guidance for using the skill. Only
  loaded AFTER the skill triggers (if at all).

#### Bundled Resources (optional)

##### Scripts (`scripts/`)

Executable code (Node.js/Python/Bash/etc.) for tasks that require deterministic
reliability or are repeatedly rewritten.

- **When to include**: When the same code is being rewritten repeatedly or
  deterministic reliability is needed
- **Example**: `scripts/rotate_pdf.cjs` for PDF rotation tasks
- **Benefits**: Token efficient, deterministic, may be executed without loading
  into context
- **Agentic Ergonomics**: Scripts must output LLM-friendly stdout. Suppress
  standard tracebacks. Output clear, concise success/failure messages, and
  paginate or truncate outputs to prevent context window overflow.

##### References (`references/`)

Documentation and reference material intended to be loaded as needed into
context to inform Qwen Code's process and thinking.

- **When to include**: For documentation that Qwen Code should reference while
  working
- **Examples**: `references/finance.md` for financial schemas,
  `references/api_docs.md` for API specifications
- **Best practice**: If files are large (>10k words), include grep search
  patterns in SKILL.md

##### Assets (`assets/`)

Files not intended to be loaded into context, but rather used within the output
Qwen Code produces.

- **When to include**: When the skill needs files that will be used in the final
  output
- **Examples**: `assets/logo.png` for brand assets, `assets/slides.pptx` for
  PowerPoint templates

#### What to Not Include in a Skill

Do NOT create extraneous documentation or auxiliary files like README.md,
CHANGELOG.md, INSTALLATION_GUIDE.md, etc. The skill should only contain the
information needed for an AI agent to do the job.

### Progressive Disclosure Design Principle

Skills use a three-level loading system to manage context efficiently:

1. **Metadata (name + description)** - Always in context (~100 words)
2. **SKILL.md body** - When skill triggers (<5k words)
3. **Bundled resources** - As needed (unlimited because scripts can be executed
   without reading into context window)

Keep SKILL.md body under 500 lines. Split content into separate reference files
when approaching this limit.

## Skill Creation Process

1. Understand the skill with concrete examples
2. Plan reusable skill contents (scripts, references, assets)
3. Create the skill directory and template files
4. Edit the skill (implement resources and write SKILL.md)
5. Validate the skill
6. Install and test

Follow these steps in order.

### Skill Naming

- Use lowercase letters, digits, and hyphens only; normalize user-provided
  titles to hyphen-case (e.g., "Plan Mode" -> `plan-mode`).
- Prefer short, verb-led phrases that describe the action.
- Name the skill folder exactly after the skill name.

### Step 1: Understanding the Skill with Concrete Examples

To create an effective skill, clearly understand concrete examples of how the
skill will be used. Ask users:

- "What functionality should this skill support?"
- "Can you give some examples of how this skill would be used?"
- "What would a user say that should trigger this skill?"

**Avoid interrogation loops:** Do not ask more than one or two clarifying
questions at a time. Bias toward action: propose a concrete list of features
based on your initial understanding, and ask the user to refine them.

### Step 2: Planning the Reusable Skill Contents

Analyze each concrete example to identify reusable resources:

- **Scripts**: Code that would be rewritten each time (e.g., `rotate_pdf.cjs`)
- **References**: Documentation needed for context (e.g., `schema.md`)
- **Assets**: Files used in output (e.g., template directories, images)

### Step 3: Creating the Skill

Create the skill directory structure directly. Ask the user for the target
location:

- **Project-level**: `${QWEN_CONFIG_DIR}/skills/<skill-name>/`
- **User-level**: `~/${QWEN_USER_CONFIG_DIR}/skills/<skill-name>/`

Create the following directory structure:

```
<skill-name>/
├── SKILL.md
├── scripts/       (if needed)
├── references/    (if needed)
└── assets/        (if needed)
```

Write the initial `SKILL.md` with this template:

```markdown
---
name: <skill-name>
description: <Complete explanation of what the skill does and when to use it. Include specific scenarios, file types, or tasks that trigger it.>
---

# <Skill Title>

## Overview

[1-2 sentences explaining what this skill enables]

## [Main section based on chosen structure]

[Skill instructions and guidance]

## Resources

[Reference any bundled scripts, references, or assets here]
```

Only create the resource directories (`scripts/`, `references/`, `assets/`)
that are actually needed for this skill. Do not create empty placeholder
directories.

### Step 4: Edit the Skill

When editing the skill, remember it is being created for another
Qwen Code session to use. Include information that would be beneficial
and non-obvious.

#### Start with Reusable Skill Contents

Implement the resources identified in Step 2. This may require user input
(e.g., brand assets, documentation to store).

Scripts must be tested by actually running them to ensure they work correctly.

#### Update SKILL.md

**Writing Guidelines:** Always use imperative/infinitive form.

##### Frontmatter

**Required fields:**

- `name`: The skill name (hyphen-case, lowercase)
- `description`: Primary triggering mechanism. Include both what the Skill does
  and specific triggers/contexts for when to use it. **Must be a single-line
  string** (max 1024 characters).
  - Example:
    `description: Data ingestion, cleaning, and transformation for tabular data. Use when working with CSV/TSV files to analyze large datasets, normalize schemas, or merge sources.`

**Optional fields:**

- `model`: Override the model used when this skill is active
- `tools`: List of tools this skill is allowed to use (supports glob patterns)
- `when_to_use`: Concise hint for automatic skill selection
- `argument-hint`: Short hint for expected arguments (e.g., `<file-path>`)
- `arguments`: Structured argument definitions for complex skills

##### Body

Write instructions for using the skill and its bundled resources.

### Step 5: Validate the Skill

After writing the skill, verify it meets these requirements:

**Checklist:**

- [ ] `SKILL.md` exists in the skill directory
- [ ] YAML frontmatter starts with `---` and ends with `---`
- [ ] `name` field is present and uses hyphen-case (`/^[a-z0-9-]+$/`)
- [ ] `description` field is present, single-line, and ≤ 1024 characters
- [ ] No unresolved `TODO:` strings remain in any file
- [ ] Skill folder name matches the `name` field
- [ ] No extraneous files (README.md, CHANGELOG.md, etc.)
- [ ] SKILL.md body is under 500 lines

If any check fails, fix the issue before proceeding.

### Step 6: Install and Test

Tell the user their skill is ready. They can use it by:

1. Restarting the session or running `/skills reload`
2. Invoking with `/<skill-name>`
3. Verifying with `/skills list`

**Iteration:** After testing, users may request improvements. Use the skill on
real tasks, notice struggles or inefficiencies, and update accordingly.
