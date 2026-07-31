# Skills Configuration Guide

This guide explains how to create and configure skills in Qwen Code.

> **CLI-first workflow (recommended):** Use `craft-agent skill ...` commands instead of editing `SKILL.md` files directly.
> - `craft-agent skill --help`
> - Canonical command reference: [craft-cli.md](./craft-cli.md)

## What Are Skills?

Skills are specialized instructions that extend the agent for specific tasks. They use a simple `SKILL.md` format with frontmatter and markdown instructions.

**Key points:**
- Skills are invoked via slash commands (e.g., `/commit`, `/review-pr`)
- Skills can be automatically triggered by file patterns (globs)
- Skills can pre-approve specific tools to run without prompting
- The SKILL.md format is portable markdown with metadata frontmatter

## Skill Format

Qwen Code uses a `SKILL.md` file for each skill. This means:

1. **Format portability**: Skills are plain files that can be reviewed and edited
2. **Same frontmatter fields**: `name`, `description`, `globs`, `alwaysAllow`, `requiredSources`
3. **Simple content structure**: Markdown body with instructions for the agent

**What Qwen Code adds:**
- **Visual icons**: Display custom icons in the UI for each skill
- **Workspace organization**: Skills are scoped to workspaces
- **UI management**: Browse, edit, and validate skills through the interface

## Skill Precedence

When a skill is invoked (e.g., `/commit`):

1. **Workspace skill checked first** - If `~/.craft-agent/workspaces/{id}/skills/commit/SKILL.md` exists, it's used
2. **SDK skill as fallback** - If no workspace skill exists, the built-in SDK skill is used

This allows you to:
- **Override SDK skills** - Create a workspace skill with the same slug to replace built-in behavior
- **Extend SDK skills** - Reference SDK behavior in your custom skill and add workspace-specific instructions
- **Create new skills** - Add entirely new skills not in the SDK

## Skill Storage

Skills are stored as folders:
```
~/.craft-agent/workspaces/{workspaceId}/skills/{slug}/
├── SKILL.md          # Required: Skill definition
├── icon.svg          # Recommended: Skill icon for UI display
├── icon.png          # Alternative: PNG icon
└── (other files)     # Optional: Additional resources
```

## SKILL.md Format

The skill file uses frontmatter plus markdown instructions:

```yaml
---
name: "Skill Display Name"
description: "Brief description shown in skill list"
globs: ["*.ts", "*.tsx"]     # Optional: file patterns that trigger skill
alwaysAllow: ["Bash"]        # Optional: tools to always allow
requiredSources:             # Optional: sources to auto-enable on invocation
  - linear
---

# Skill Instructions

Your skill content goes here. This is injected into the agent context
when the skill is active.

## Guidelines

- Specific instructions for the agent
- Best practices to follow
- Things to avoid

## Examples

Show the agent how to perform the task correctly.
```

## Metadata Fields

### name (required)
Display name for the skill. Shown in the UI and skill list.

### description (required)
Brief description (1-2 sentences) explaining what the skill does.

### globs (optional)
Array of glob patterns. When a file matching these patterns is being worked on,
the skill may be automatically suggested or activated.

```yaml
globs:
  - "*.test.ts"           # Test files
  - "*.spec.tsx"          # React test files
  - "**/__tests__/**"     # Test directories
```

### alwaysAllow (optional)
Array of tool names that are automatically allowed when this skill is active.
Useful for skills that require specific tools without prompting.

```yaml
alwaysAllow:
  - "Bash"                # Allow bash commands
  - "Write"               # Allow file writes
```

### requiredSources (optional)
Array of source slugs to auto-enable when this skill is invoked.
When a user mentions the skill, the listed sources are enabled for the session
before the agent starts — so tools from those sources are available from the first turn.

Sources must exist in the workspace and be authenticated. Unauthenticated or
missing sources are silently skipped (the existing runtime auto-enable handles them
as a fallback).

```yaml
requiredSources:
  - linear               # Auto-enable Linear source
  - github               # Auto-enable GitHub source
```

## Creating a Skill

### 1. Create the skill directory

```bash
mkdir -p ~/.craft-agent/workspaces/{ws}/skills/my-skill
```

### 2. Write SKILL.md

```markdown
---
name: "Code Review"
description: "Review code changes for quality, security, and best practices"
globs: ["*.ts", "*.tsx", "*.js", "*.jsx"]
---

# Code Review Skill

When reviewing code, focus on:

## Quality Checks
- Consistent code style
- Clear naming conventions
- Appropriate abstractions

## Security Checks
- Input validation
- Authentication/authorization
- Sensitive data handling

## Best Practices
- Error handling
- Performance considerations
- Test coverage
```

### 3. Add an icon (IMPORTANT)

Every skill should have a visually relevant icon. This helps users quickly identify skills in the UI.

**Icon requirements:**
- **Filename**: Must be `icon.svg`, `icon.png`, `icon.jpg`, or `icon.jpeg`
- **Format**: SVG preferred (scalable, crisp at all sizes)
- **Size**: For PNG/JPG, use at least 64x64 pixels

**How to get an icon:**

1. **Search online icon libraries:**
   - [Heroicons](https://heroicons.com/) - MIT licensed
   - [Feather Icons](https://feathericons.com/) - MIT licensed
   - [Simple Icons](https://simpleicons.org/) - Brand icons (git, npm, etc.)

2. **Use WebFetch to download:**
   ```
   # Find an appropriate icon URL and download it
   WebFetch to get SVG content, then save to icon.svg
   ```

3. **Match the skill's purpose:**
   - Git/commit skill → git icon or commit icon
   - Test skill → checkmark or test tube icon
   - Deploy skill → rocket or cloud icon
   - Review skill → magnifying glass or eye icon

### 4. Validate the skill

**IMPORTANT**: Always validate after creating or editing a skill:

```
skill_validate({ skillSlug: "my-skill" })
```

This validates:
- Slug format (lowercase, alphanumeric, hyphens only)
- SKILL.md exists and is readable
- YAML frontmatter is valid
- Required fields present (name, description)
- Content is non-empty
- Icon format (if present)

## Example Skills

### Commit Message Skill

```yaml
---
name: "Commit"
description: "Create well-formatted git commit messages"
alwaysAllow: ["Bash"]
---

# Commit Message Guidelines

When creating commits:

1. **Format**: Use conventional commits
   - `feat:` New feature
   - `fix:` Bug fix
   - `docs:` Documentation
   - `refactor:` Code refactoring
   - `test:` Adding tests

2. **Style**:
   - Keep subject line under 72 characters
   - Use imperative mood ("Add feature" not "Added feature")
   - Explain why, not what (the diff shows what)

3. **Co-authorship**:
   Always include the project-approved co-author trailer.
```

**Recommended icon**: Git commit icon from Heroicons or Simple Icons

### Team Standards Skill

```yaml
---
name: "Team Standards"
description: "Enforce team coding conventions and patterns"
globs: ["src/**/*.ts", "src/**/*.tsx"]
---

# Team Coding Standards

## File Organization
- One component per file
- Co-locate tests with source files
- Use barrel exports (index.ts)

## Naming Conventions
- Components: PascalCase
- Hooks: camelCase with `use` prefix
- Constants: SCREAMING_SNAKE_CASE

## Import Order
1. External packages
2. Internal packages (@company/*)
3. Relative imports
```

**Recommended icon**: Clipboard list or checklist icon

### Skill with Required Sources

```yaml
---
name: "Linear Triage"
description: "Triage and prioritize Linear issues"
requiredSources:
  - linear
---

# Linear Triage

When triaging issues:
1. List unassigned issues from the current sprint
2. Categorize by severity
3. Suggest assignees based on expertise
```

**Recommended icon**: Kanban board or list icon

When this skill is invoked, the `linear` source is automatically enabled for the
session — no manual toggle needed.

## Overriding SDK Skills

To customize a built-in SDK skill like `/commit`:

1. Create `~/.craft-agent/workspaces/{ws}/skills/commit/SKILL.md`
2. Write your custom instructions
3. Add an icon
4. Run `skill_validate({ skillSlug: "commit" })`

Your skill will be used instead of the SDK's built-in version.

This is useful for:
- Adding team-specific commit message formats
- Enforcing project-specific coding standards
- Customizing review criteria for your codebase

## Best Practices

1. **Be specific**: Give the agent clear, actionable instructions
2. **Include examples**: Show the expected output format
3. **Set boundaries**: Explain what NOT to do
4. **Keep focused**: One skill = one specific task or domain
5. **Add a relevant icon**: Makes skills easily identifiable in the UI
6. **Always validate**: Run `skill_validate` after creating or editing

## Troubleshooting

**Skill not loading:**
- Check slug format (lowercase, alphanumeric, hyphens only)
- Verify SKILL.md exists and is readable
- Run `skill_validate` for detailed errors

**Skill not triggering:**
- Check glob patterns match your files
- Verify skill is in correct workspace

**Icon not showing:**
- Use supported formats: svg, png, jpg, jpeg
- File must be named `icon.{ext}` (not `my-icon.svg`)
- Check icon file is not corrupted
- For SVG, ensure valid XML structure
