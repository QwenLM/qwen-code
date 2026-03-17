## TLDR

This PR adds a new `qwen auth` command with subcommands for managing authentication in Qwen Code:

- **`qwen auth`** - Interactive authentication setup
- **`qwen auth qwen-oauth`** - Authenticate with Qwen OAuth (free tier)
- **`qwen auth code-plan`** - Authenticate with Alibaba Cloud Coding Plan
- **`qwen auth status`** - Check current authentication status

Also includes a new `qwen-code-claw` skill for using Qwen Code as an AI code agent via ACPX.

## Dive Deeper

### Authentication Command (`qwen auth`)

The authentication system provides a unified way to configure and manage API credentials for Qwen Code:

1. **Interactive Mode** (`qwen auth`)
   - Presents a menu to choose between Qwen OAuth and Coding Plan
   - Uses arrow keys for navigation and Enter to select
   - Secure password input for API key entry

2. **Qwen OAuth** (`qwen auth qwen-oauth`)
   - Free tier authentication
   - Up to 1,000 requests/day
   - Access to latest Qwen models

3. **Coding Plan** (`qwen auth code-plan [--region] [--key]`)
   - Paid tier with higher limits
   - Supports China and Global regions
   - Can be configured via environment variable or interactively

4. **Status Check** (`qwen auth status`)
   - Displays current authentication method
   - Shows configuration details (region, model, version)
   - Provides helpful hints if not configured

### Qwen Code Claw Skill

Added a new skill (`.qwen/skills/qwen-code-claw/SKILL.md`) that enables using Qwen Code as an AI code agent through ACPX (Agent Client Protocol). The skill documentation includes:

- When to use the skill
- Installation instructions
- Authentication setup
- ACPX integration guide
- Common workflows and examples
- Command reference and best practices

### Technical Implementation

- **`InteractiveSelector<T>`** - Reusable interactive menu component for CLI
- **`handler.ts`** - Authentication logic with proper error handling
- **`status.test.ts`** - Comprehensive tests for status command (10 tests)
- **`interactiveSelector.test.ts`** - Tests for the selector component (15 tests)

## Reviewer Test Plan

1. **Test authentication status:**

   ```bash
   qwen auth status
   ```

   Should show "not configured" message if no auth exists

2. **Test interactive auth:**

   ```bash
   qwen auth
   ```

   Should display interactive menu with arrow key navigation

3. **Test Qwen OAuth:**

   ```bash
   qwen auth qwen-oauth
   ```

   Should open browser for OAuth flow

4. **Test Coding Plan auth:**

   ```bash
   qwen auth code-plan --region china --key YOUR_KEY
   ```

   Should configure without prompts

5. **Test skill usage:**
   - Read the skill documentation at `.qwen/skills/qwen-code-claw/SKILL.md`
   - Verify all commands and examples are accurate

## Testing Matrix

|          | 🍏  | 🪟  | 🐧  |
| -------- | --- | --- | --- |
| npm run  | ✅  | ❓  | ❓  |
| npx      | ✅  | ❓  | ❓  |
| Docker   | ❓  | ❓  | ❓  |
| Podman   | ❓  | -   | -   |
| Seatbelt | ❓  | -   | -   |

## Linked issues / bugs

Related to: #2410 (test/simplify-sdk-integration-tests)

This PR builds on the existing authentication infrastructure and adds the missing CLI commands for user-facing authentication management.
