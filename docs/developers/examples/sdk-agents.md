# SDK Subagent Examples

Examples of configuring subagents via the `agents` option in `QueryOptions`.

## Code reviewer subagent

```typescript
import { query, type SubagentConfig } from '@qwen-code/sdk';

const codeReviewer: SubagentConfig = {
  name: 'code-reviewer',
  description:
    'Reviews code for bugs, security issues, and performance problems',
  systemPrompt: `You are a code reviewer. Review diffs for:
- Logic errors and edge cases
- Security vulnerabilities (injection, auth bypass, data leaks)
- Performance regressions (N+1 queries, unbounded loops)
Output a structured review with severity levels: critical, warning, info.`,
  level: 'session',
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  modelConfig: { model: 'claude-sonnet-4-6' },
};

const conversation = query({
  prompt: 'Review the changes in the current branch against dev',
  options: { agents: [codeReviewer] },
});

for await (const message of conversation) {
  if (message.type === 'assistant') {
    console.log(message.message.content);
  }
}
```

The primary agent decides when to invoke the subagent based on the task. You define the configuration; the agent handles dispatch and result aggregation.

## Multiple subagents

Pass multiple subagent configurations. The primary agent chooses which to invoke:

```typescript
const securityAuditor: SubagentConfig = {
  name: 'security-auditor',
  description: 'Audits code for security vulnerabilities and compliance issues',
  systemPrompt: 'You are a security auditor. Focus on OWASP Top 10...',
  level: 'session',
  tools: ['Read', 'Glob', 'Grep'],
  modelConfig: { model: 'claude-sonnet-4-6' },
};

const testWriter: SubagentConfig = {
  name: 'test-writer',
  description: 'Writes comprehensive test suites for code changes',
  systemPrompt: 'You write tests. Use the project testing framework...',
  level: 'session',
  tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
};

const conversation = query({
  prompt:
    'Review auth module for security, then write tests for any issues found',
  options: {
    agents: [securityAuditor, testWriter],
    permissionMode: 'auto-edit',
  },
});
```

## Restricting subagent tools

Use `tools` for an allowlist. The subagent can only use the listed tools:

```typescript
const readOnlyAnalyzer: SubagentConfig = {
  name: 'analyzer',
  description: 'Analyzes code without making changes',
  systemPrompt: 'Analyze the codebase. Do not modify any files.',
  level: 'session',
  tools: ['Read', 'Glob', 'Grep'], // no write tools
};
```

## Model selection per subagent

Each subagent can use a different model:

```typescript
const architect: SubagentConfig = {
  name: 'architect',
  description: 'Designs system architecture and makes high-level decisions',
  systemPrompt: 'You are a senior architect...',
  level: 'session',
  modelConfig: { model: 'claude-opus-4-6' }, // use opus for complex reasoning
};

const implementer: SubagentConfig = {
  name: 'implementer',
  description: 'Implements code changes based on specifications',
  systemPrompt: 'You implement code changes...',
  level: 'session',
  modelConfig: { model: 'claude-sonnet-4-6' }, // sonnet for standard implementation
};
```
