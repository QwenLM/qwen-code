# Prompt Enhancer

Transform basic prompts into professional team-lead level prompts for better AI assistance.

## Quick Start

### Build and Install

```bash
# Navigate to the project root
cd /path/to/qwen-code

# Install dependencies
npm install

# Build all packages (including prompt-enhancer)
npm run build

# Or build just the prompt-enhancer package
cd packages/prompt-enhancer
npm run build
```

### Usage

Once built, use the `/enhance` command in qwen-code:

```bash
# Start qwen-code
npx qwen

# Use the enhance command
/enhance Fix the login bug
```

## Overview

The Prompt Enhancer is a powerful feature that analyzes your basic prompts and transforms them into well-structured, comprehensive prompts that help AI assistants understand your intent better and provide higher-quality responses.

### Why Use Prompt Enhancer?

Developers often write vague prompts like:

- "Fix the bug"
- "Add authentication"
- "Make it faster"

These prompts lack context, constraints, and clear success criteria, leading to suboptimal AI responses.

The Prompt Enhancer automatically:

- **Detects your intent** (code creation, bug fix, review, etc.)
- **Adds structure** (Context, Requirements, Constraints, Acceptance Criteria)
- **Enriches with context** (project-specific information)
- **Provides implementation plans** (step-by-step guidance)

## Usage

### Basic Usage

Use the `/enhance` slash command followed by your prompt:

```bash
/enhance Fix the login bug
```

This will transform your prompt into a professional-quality prompt with sections for:

- Bug Report
- Investigation details
- Fix Requirements
- Constraints
- Validation criteria
- Implementation Plan

### Enhancement Levels

Control how much enhancement is applied:

```bash
# Quick cleanup (minimal)
/enhance --level minimal Add tests

# Full enhancement (default, standard)
/enhance Add authentication to the API

# Comprehensive with examples (maximal)
/enhance --level maximal Create user dashboard
```

**Levels:**

- `minimal` - Quick cleanup and basic structure
- `standard` - Full enhancement with all sections (default)
- `maximal` - Comprehensive with examples and edge cases

### Preview Mode

See what enhancement will look like without applying it:

```bash
/enhance --preview Create component
```

### Examples

#### Example 1: Bug Fix

**Before:**

```
Fix the login bug
```

**After:**

```markdown
## Bug Report

Fix the login bug

## Investigation

- Error location: To be determined from error logs
- Error message: Not provided
- Stack trace: Not provided
- Reproduction steps: To be determined
- Affected files: To be identified during investigation

## Hypothesis

To be investigated

## Fix Requirements

- [ ] Root cause identified and documented
- [ ] Fix implemented with minimal changes
- [ ] Regression test added
- [ ] No breaking changes to existing APIs
- [ ] Edge cases considered

## Constraints

- Maintain backward compatibility
- No performance degradation
- Follow existing error handling patterns
- Document the fix in code comments

## Validation

- [ ] Original issue resolved
- [ ] Reproduction steps no longer trigger the bug
- [ ] No new test failures
- [ ] Edge cases tested
- [ ] Related functionality verified

## Implementation Plan

1. Reproduce the bug locally
2. Identify root cause through debugging
3. Design minimal fix
4. Implement fix
5. Write regression test
6. Run full test suite
7. Verify fix resolves the issue
```

#### Example 2: Code Creation

**Before:**

```
Create user profile component
```

**After:**

```markdown
## Task

Create user profile component

## Context

- Project: YourProject
- Location: To be determined
- Related files: Check existing implementations in src/
- Existing patterns: Uses React patterns, camelCase naming, TSDoc comments

## Requirements

- [ ] Functional: Create a reusable component with proper props typing
- [ ] Code style: Follow existing project conventions (camelCase)
- [ ] Testing: Include unit tests using vitest
- [ ] Documentation: Add TSDoc comments

## Constraints

- TypeScript strict mode compliance
- No new dependencies without justification
- Backward compatibility with existing APIs
- Performance: Not specified

## Acceptance Criteria

1. Tests written using vitest
2. Functionality works as expected
3. All existing tests pass
4. Linter checks pass
5. Code reviewed for patterns consistency

## Implementation Plan

1. Analyze existing similar implementations
2. Create interface/type definitions
3. Implement core logic
4. Write tests
5. Update documentation
6. Run linter and type checker
```

## Configuration

### Enable Auto-Enhancement

To automatically enhance all prompts (not just `/enhance` commands), add to your `~/.qwen/settings.json`:

```json
{
  "promptEnhancer": {
    "enabled": true,
    "level": "standard",
    "autoEnhance": false
  }
}
```

### Settings Reference

| Setting           | Type    | Default      | Description                                   |
| ----------------- | ------- | ------------ | --------------------------------------------- |
| `enabled`         | boolean | `false`      | Enable automatic prompt enhancement           |
| `level`           | string  | `"standard"` | Enhancement level: minimal, standard, maximal |
| `autoEnhance`     | boolean | `false`      | Auto-enhance all prompts (not just /enhance)  |
| `customTemplates` | object  | `{}`         | Custom enhancement templates                  |
| `teamConventions` | object  | `{}`         | Team-specific conventions                     |

### Project-Specific Configuration

Create `.qwen/prompt-enhancer.json` in your project root:

```json
{
  "customTemplates": {
    "code-creation": "Your custom template here"
  },
  "teamConventions": {
    "naming": "camelCase",
    "testing": "vitest",
    "documentation": "tsdoc"
  }
}
```

## Features

### Intent Detection

Automatically detects what you want to accomplish:

- **code-creation** - Creating new code, features, or components
- **bug-fix** - Diagnosing and fixing bugs
- **review** - Code review and feedback
- **refactor** - Refactoring and code improvement
- **ask** - Questions and explanations
- **debug** - Debugging and investigation
- **test** - Writing tests
- **documentation** - Documentation tasks

### Quality Scoring

Each prompt is scored on four dimensions:

- **Clarity** - How clear and understandable is the request?
- **Completeness** - Does the prompt have all necessary information?
- **Actionability** - Can the AI take action based on this prompt?
- **Context Richness** - How much relevant context is provided?

### Context Gathering

Automatically gathers context from your project:

- `package.json` - Project type, dependencies, scripts
- File structure - Project architecture patterns
- Existing code - Style patterns, naming conventions
- Git history - Recent changes

### Enhancement Strategies

Different strategies for different intents:

- **Code Creation Strategy** - Adds requirements, constraints, implementation plan
- **Bug Fix Strategy** - Adds investigation steps, validation criteria
- **Review Strategy** - Adds focus areas, review guidelines
- **Ask Strategy** - Adds topic context, knowledge level

## API

For programmatic use:

```typescript
import { PromptEnhancer } from '@qwen-code/prompt-enhancer';

const enhancer = new PromptEnhancer({
  level: 'standard',
  projectRoot: '/path/to/project',
});

const result = await enhancer.enhance('Fix the bug');

console.log(result.enhanced); // Enhanced prompt
console.log(result.scores.before.overall); // Original score
console.log(result.scores.after.overall); // Enhanced score
console.log(result.appliedEnhancements); // List of enhancements
```

## Tips for Better Prompts

Even with enhancement, providing more information helps:

1. **Specify file paths**: "Fix the bug in `/src/auth/login.ts`"
2. **Include error messages**: "Error: Cannot read property 'x' of undefined"
3. **Add context**: "We're using React 18 with TypeScript"
4. **Define success**: "Should return true for valid emails"
5. **Mention constraints**: "Without using external libraries"

## Troubleshooting

### Enhancement is slow

- Large projects may take longer to gather context
- Try `--level minimal` for faster enhancement

### Enhancement doesn't help

- Make sure your prompt has some actionable content
- Check that intent detection is correct
- Try providing more specific information

### Wrong intent detected

- Use more specific verbs (create, fix, review)
- Add context about what you're trying to do

## Related Features

- **[Modes Layer](./modes.md)** - Specialized agent profiles for different tasks
- **[Custom Commands](./commands.md)** - Create your own slash commands
- **[Settings](./settings.md)** - Configure qwen-code behavior

## Contributing

To add custom enhancement templates or strategies, see the [Contributing Guide](../../CONTRIBUTING.md).
