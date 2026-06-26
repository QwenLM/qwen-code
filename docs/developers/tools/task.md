# Agent Tool (`agent`)

This document describes the `agent` tool for Qwen Code.

## Description

Use `agent` to launch a specialized subagent to handle complex, multi-step tasks autonomously. The Agent tool delegates work to specialized agents that can work independently with access to their own set of tools, allowing for parallel task execution and specialized expertise.

### Arguments

`agent` takes the following arguments:

- `description` (string, required): A short (3-5 word) description of the task for user visibility and tracking purposes.
- `prompt` (string, required): The detailed task prompt for the subagent to execute. Should contain comprehensive instructions for autonomous execution.
- `subagent_type` (string, optional): The type of specialized agent to use for this task. Defaults to `general-purpose` if omitted.
- `run_in_background` (boolean, optional): Set to `true` to run the agent in the background. You will be notified when it completes.
- `isolation` (string, optional): Set to `"worktree"` to run the agent in an isolated git worktree.

## How to use `agent` with Qwen Code

The Agent tool dynamically loads available subagents from your configuration and delegates tasks to them. Each subagent runs independently and can use its own set of tools, allowing for specialized expertise and parallel execution.

When you use the Agent tool, the subagent will:

1. Receive the task prompt with full autonomy
2. Execute the task using its available tools
3. Return a final result message
4. Terminate (subagents are stateless and single-use)

Usage:

```
agent(description="Brief task description", prompt="Detailed task instructions for the subagent", subagent_type="agent_name")
```

## Available Subagents

The available subagents depend on your configuration. Common subagent types might include:

- **general-purpose**: For complex multi-step tasks requiring various tools
- **code-reviewer**: For reviewing and analyzing code quality
- **test-runner**: For running tests and analyzing results
- **documentation-writer**: For creating and updating documentation

You can view available subagents by using the `/agents` command in Qwen Code.

## Agent Tool Features

### Real-time Progress Updates

The Agent tool provides live updates showing:

- Subagent execution status
- Individual tool calls being made by the subagent
- Tool call results and any errors
- Overall task progress and completion status

### Parallel Execution

You can launch multiple subagents concurrently by calling the Agent tool multiple times in a single message, allowing for parallel task execution and improved efficiency.

### Specialized Expertise

Each subagent can be configured with:

- Specific tool access permissions
- Specialized system prompts and instructions
- Custom model configurations
- Domain-specific knowledge and capabilities

## `agent` examples

### Delegating to a general-purpose agent

```
agent(
  description="Code refactoring",
  prompt="Please refactor the authentication module in src/auth/ to use modern async/await patterns instead of callbacks. Ensure all tests still pass and update any related documentation.",
  subagent_type="general-purpose"
)
```

### Running parallel tasks

```
# Launch code review and test execution in parallel
agent(
  description="Code review",
  prompt="Review the recent changes in the user management module for code quality, security issues, and best practices compliance.",
  subagent_type="general-purpose"
)

agent(
  description="Run tests",
  prompt="Execute the full test suite and analyze any failures. Provide a summary of test coverage and recommendations for improvement.",
  subagent_type="test-engineer"
)
```

### Documentation generation

```
agent(
  description="Update docs",
  prompt="Generate comprehensive API documentation for the newly implemented REST endpoints in the orders module. Include request/response examples and error codes.",
  subagent_type="general-purpose"
)
```

## When to Use the Agent Tool

Use the Agent tool when:

1. **Complex multi-step tasks** - Tasks requiring multiple operations that can be handled autonomously
2. **Specialized expertise** - Tasks that benefit from domain-specific knowledge or tools
3. **Parallel execution** - When you have multiple independent tasks that can run simultaneously
4. **Delegation needs** - When you want to hand off a complete task rather than micromanaging steps
5. **Resource-intensive operations** - Tasks that might take significant time or computational resources

## When NOT to Use the Agent Tool

Don't use the Agent tool for:

- **Simple, single-step operations** - Use direct tools like Read, Edit, etc.
- **Interactive tasks** - Tasks requiring back-and-forth communication
- **Specific file reads** - Use Read tool directly for better performance
- **Simple searches** - Use Grep or Glob tools directly

## Important Notes

- **Stateless execution**: Each subagent invocation is independent with no memory of previous executions
- **Single communication**: Subagents provide one final result message - no ongoing communication
- **Comprehensive prompts**: Your prompt should contain all necessary context and instructions for autonomous execution
- **Tool access**: Subagents only have access to tools configured in their specific configuration
- **Parallel capability**: Multiple subagents can run simultaneously for improved efficiency
- **Configuration dependent**: Available subagent types depend on your system configuration

## Configuration

Subagents are configured through Qwen Code's agent configuration system. Use the `/agents` command to:

- View available subagents
- Create new subagent configurations
- Modify existing subagent settings
- Set tool permissions and capabilities

For more information on configuring subagents, refer to the subagents documentation.
