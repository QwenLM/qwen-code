# Welcome Back Feature

The Welcome Back feature helps you seamlessly resume your work by automatically detecting when you return to a project with existing conversation history and offering to continue from where you left off.

## Overview

When you start Qwen Code in a project directory that contains a previously generated project summary (`.qwen/PROJECT_SUMMARY.md`), the Welcome Back dialog will automatically appear, giving you the option to either start fresh or continue your previous conversation.

## How It Works

### Automatic Detection

The Welcome Back feature automatically detects:

- **Project Summary File:** Looks for `.qwen/PROJECT_SUMMARY.md` in your current project directory
- **Conversation History:** Checks if there's meaningful conversation history to resume
- **Settings:** Respects your `enableWelcomeBack` setting (enabled by default)

### Welcome Back Dialog

When a project summary is found, you'll see a dialog with:

- **Last Updated Time:** Shows when the summary was last generated
- **Overall Goal:** Displays the main objective from your previous session
- **Current Plan:** Shows task progress with status indicators:
  - `[DONE]` - Completed tasks
  - `[IN PROGRESS]` - Currently working on
  - `[TODO]` - Planned tasks
- **Task Statistics:** Summary of total tasks, completed, in progress, and pending

### Options

You have two choices when the Welcome Back dialog appears:

1. **Start new chat session**
   - Closes the dialog and begins a fresh conversation
   - No previous context is loaded

2. **Continue previous conversation**
   - Automatically fills the input with: `@.qwen/PROJECT_SUMMARY.md, Based on our previous conversation, Let's continue?`
   - Loads the project summary as context for the AI
   - Allows you to seamlessly pick up where you left off

## Configuration

### Enable/Disable Welcome Back

You can control the Welcome Back feature through settings:

**Via Settings Dialog:**

1. Run `/settings` in Qwen Code
2. Find "Enable Welcome Back" in the UI category
3. Toggle the setting on/off

**Via Settings File:**
Add to your `.qwen/settings.json`:

```json
{
  "enableWelcomeBack": true
}
```

**Settings Locations:**

- **User settings:** `~/.qwen/settings.json` (affects all projects)
- **Project settings:** `.qwen/settings.json` (project-specific)

### Keyboard Shortcuts

- **Escape:** Close the Welcome Back dialog (defaults to "Start new chat session")

## Integration with Other Features

### Project Summary Generation

The Welcome Back feature works seamlessly with the `/summary` command:

1. **Generate Summary:** Use `/summary` to create a project summary
2. **Automatic Detection:** Next time you start Qwen Code in this project, Welcome Back will detect the summary
3. **Resume Work:** Choose to continue and the summary will be loaded as context

### Quit Confirmation

When exiting with `/quit-confirm` and choosing "Generate summary and quit":

1. A project summary is automatically created
2. Next session will trigger the Welcome Back dialog
3. You can seamlessly continue your work

## File Structure

The Welcome Back feature creates and uses:

```
your-project/
├── .qwen/
│   └── PROJECT_SUMMARY.md    # Generated project summary
```

### PROJECT_SUMMARY.md Format

The generated summary follows this structure:

```markdown
# Project Summary

## Overall Goal

<!-- Single, concise sentence describing the high-level objective -->

## Key Knowledge

<!-- Crucial facts, conventions, and constraints -->
<!-- Includes: technology choices, architecture decisions, user preferences -->

## Recent Actions

<!-- Summary of significant recent work and outcomes -->
<!-- Includes: accomplishments, discoveries, recent changes -->

## Current Plan

<!-- The current development roadmap and next steps -->
<!-- Uses status markers: [DONE], [IN PROGRESS], [TODO] -->

---

## Summary Metadata

**Update time**: 2025-01-10T15:30:00.000Z
```
