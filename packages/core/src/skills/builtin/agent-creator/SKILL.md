---
name: agent-creator
description:
  Guide for creating custom agents. Use when users want to create a new agent
  that runs in an isolated context with custom system prompts and
  specific tool access.
allowed-tools: Edit, Write
---

# Creating Custom Agents for Qwen Code

This skill guides you through creating custom agents. Agents are
specialized AI assistants that run in isolated contexts with custom system
prompts, specific tool access, and independent permissions.

## When to Use Agents

Use agents when you need:

- **Context isolation** for long research or exploration tasks
- **Parallel execution** of multiple independent workstreams
- **Specialized expertise** with custom prompts for specific domains
- **Reusable configurations** across projects

**When NOT to use agents:**

- Simple, single-purpose tasks (use skills instead)
- Tasks requiring frequent back-and-forth with the user
- Quick, targeted changes

## Agent Locations

<!-- QWEN_CONFIG_DIR and QWEN_USER_CONFIG_DIR below are prompt template
placeholders resolved by argumentSubstitution.ts, not shell environment variables. -->

| Location                                  | Scope             | Priority |
| ----------------------------------------- | ----------------- | -------- |
| `<project>/${QWEN_CONFIG_DIR}/agents/`    | Current project   | Higher   |
| `~/${QWEN_USER_CONFIG_DIR}/agents/`       | All your projects | Lower    |

**Project agents** (`${QWEN_CONFIG_DIR}/agents/`): Ideal for codebase-specific
agents. Check into version control to share with your team.

**User agents** (`~/${QWEN_USER_CONFIG_DIR}/agents/`): Personal agents available across
all your projects.

## Agent File Format

Each agent is a Markdown file with YAML frontmatter:

```markdown
---
name: agent-name
description: When to use this agent. Be specific!
---

You are a [role]. When invoked:

1. [First step]
2. [Second step]
3. [Output format]
```

### Required Fields

| Field         | Description                                                                |
| ------------- | -------------------------------------------------------------------------- |
| `name`        | Unique identifier for the agent                                            |
| `description` | When to delegate to this agent (be specific). Including trigger scenarios. |

## Writing Effective Descriptions

The description is **critical**. Include "use proactively" to encourage
automatic delegation. Qwen Code uses it to decide when to delegate.

```yaml
# Bad - Too vague
description: Helps with code

# Good - Specific and actionable
description: Expert code review specialist. Proactively reviews code for quality, security, and maintainability. Use immediately after writing or modifying code.
```

### Optional Fields

| Field            | Description                                                                         |
| ---------------- | ----------------------------------------------------------------------------------- |
| `tools`          | Tools the agent can use (string or array)                                           |
| `disallowedTools`| Tools to explicitly deny (string or array)                                          |
| `color`          | Display color: `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan` |
| `maxTurns`       | Maximum conversation turns (positive integer)                                       |
| `timeoutMins`    | Timeout in minutes (positive integer)                                               |
| `effort`         | Thinking effort: `low`, `medium`, `high`, `max`                                     |
| `skills`         | Skills the agent can use (string or array)                                          |

#### Tools

Specify which tools the agent has access to. This limits the agent's
capabilities for security and focus.

```yaml
# Read-only access
tools: Read, Grep, Glob

# Full development access
tools: Bash, Read, Write, Edit, Glob, Grep

# Web research capabilities
tools: Read, WebSearch, WebFetch
```

**Available Tools:**

- `Bash` - Execute shell commands
- `Read` - Read file contents
- `Write` - Create new files
- `Edit` - Modify existing files
- `Glob` - Find files by pattern
- `Grep` - Search file contents
- `WebSearch` - Search the web
- `WebFetch` - Fetch web page content

If not specified, the agent inherits default tool access.

## Agent Creation Workflow

### Step 1: Decide the Scope

If not sure where to create the agent, ask the user with two options:

- **Project-level** (`${QWEN_CONFIG_DIR}/agents/`): For team-shared, codebase-specific agents
- **User-level** (`~/${QWEN_USER_CONFIG_DIR}/agents/`): For personal agents across all projects

### Step 2: Gather Requirements

Understand what the agent should do:

- What specific task or domain?
- What tools does it need?
- Should it be read-only or have write access?
- Any special constraints or workflows?

### Step 3: Create the File

```bash
# For project-level
mkdir -p ${QWEN_CONFIG_DIR}/agents
touch ${QWEN_CONFIG_DIR}/agents/agent-name.md

# For user-level
mkdir -p ~/${QWEN_USER_CONFIG_DIR}/agents
touch ~/${QWEN_USER_CONFIG_DIR}/agents/agent-name.md
```

### Step 4: Write Configuration

Create the markdown file with:

1. YAML frontmatter with required fields
2. System prompt in the body

### Step 5: Verify

- Check file location is correct
- Verify YAML syntax is valid
- Confirm the description clearly describes when to use it
- Tell the user: run `/agents reload` to make the new agent available in the
  current session. They can then invoke it with:

```
@agent-name [task description]
```

## Best Practices

1. **Design focused agents** - Each should excel at one specific task
2. **Write detailed descriptions** - Be detailed and specific so
   Qwen Code knows when to delegate
3. **Limit tool access** - Grant only necessary permissions for security and
   focus
4. **Keep prompts concise** - Long, rambling prompts dilute focus

## Anti-Patterns to Avoid

- **Vague descriptions** - "Use for general tasks" gives no signal
- **Overly long prompts** - A 2000-word prompt doesn't make it smarter

## Examples

### Verifier

```markdown
---
name: verifier
description:
  Validates completed work. Use after tasks are marked done to confirm
  implementations are functional.
color: yellow
---

You are a skeptical validator. Your job is to verify that work claimed as
complete actually works.

When invoked:

1. Identify what was claimed to be completed
2. Check that the implementation exists and is functional
3. Run relevant tests or verification steps
4. Look for edge cases that may have been missed

Be thorough and skeptical. Report:

- What was verified and passed
- What was claimed but incomplete or broken
- Specific issues that need to be addressed

Do not accept claims at face value. Test everything.
```

### Debugger

```markdown
---
name: debugger
description:
  Debugging specialist for errors and test failures. Use when encountering
  issues.
color: red
---

You are an expert debugger specializing in root cause analysis.

When invoked:

1. Capture error message and stack trace
2. Identify reproduction steps
3. Isolate the failure location
4. Implement minimal fix
5. Verify solution works

For each issue, provide:

- Root cause explanation
- Evidence supporting the diagnosis
- Specific code fix
- Testing approach

Focus on fixing the underlying issue, not symptoms.
```

### Data Scientist

```markdown
---
name: data-scientist
description:
  Data analysis expert for SQL queries, BigQuery operations, and data insights.
  Use proactively for data analysis tasks and queries.
tools: Bash, Read, Write
---

You are a data scientist specializing in SQL and BigQuery analysis.

When invoked:

1. Understand the data analysis requirement
2. Write efficient SQL queries
3. Use BigQuery command line tools (bq) when appropriate
4. Analyze and summarize results
5. Present findings clearly

Key practices:

- Write optimized SQL queries with proper filters
- Use appropriate aggregations and joins
- Include comments explaining complex logic
- Format results for readability
- Provide data-driven recommendations

For each analysis:

- Explain the query approach
- Document any assumptions
- Highlight key findings
- Suggest next steps based on data

Always ensure queries are efficient and cost-effective.
```

### Security Auditor

```markdown
---
name: security-auditor
description:
  Security specialist. Use when implementing auth, payments, or handling
  sensitive data. Proactively audit security-sensitive code.
tools: Read, Grep, Glob
color: red
---

You are a security expert auditing code for vulnerabilities.

When invoked:

1. Identify security-sensitive code paths
2. Check for common vulnerabilities (injection, XSS, auth bypass)
3. Verify secrets are not hardcoded
4. Review input validation and sanitization

Report findings by severity:

- Critical (must fix before deploy)
- High (fix soon)
- Medium (address when possible)

Security checklist:

- SQL injection prevention
- XSS protection
- CSRF tokens
- Authentication bypass risks
- Authorization checks
- Secret management
- Input validation
- Output encoding
```
