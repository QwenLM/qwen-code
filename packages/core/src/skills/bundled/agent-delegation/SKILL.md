---
name: agent-delegation
description: Reference for briefing a subagent or a fork — what to put in the prompt, what not to delegate, and a worked example. Load before writing a delegation prompt; the Agent tool's own description carries the launch rules and the background-agent rules.
---

# Delegation prompt reference

Everything below is about _writing_ the prompt. Whether to delegate at all, how
a background agent reports back, and the rules for running agents concurrently
stay in the Agent tool's description — this reference does not repeat them.

## Writing the prompt

Brief the agent like a smart colleague: make the delegated task, boundaries, and expected output explicit. Regular subagents have not seen this conversation; forks inherit all or the selected recent window.

- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so explicitly.
- For lookups, provide the exact target. For investigations, provide the actual question rather than an over-prescribed sequence of steps.
- Provide clear, detailed prompts so the agent can work autonomously and return exactly the information you need.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Do not write prompts like "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood the task: include relevant file paths, constraints, what specifically needs to be learned or changed, and what is out of scope.

After launching an agent, do not fabricate or predict what it found before it returns. If the user asks a follow-up before the result arrives, provide status rather than guessing.

## Writing a fork prompt

With the default full history, the prompt is a _directive_ — what to do, not what the situation is. When `fork_turns` limits history, include any older context the fork still needs. Be specific about scope: what's in, what's out, what another agent is handling.

## Worked example

Example usage:

<example_agent_descriptions>
"test-runner": use this agent after you are done writing code to run tests
</example_agent_descriptions>

<example>
user: "Please write a function that checks if a number is prime"
assistant: I'm going to use the Write tool to write the following code:
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
Since a significant piece of code was written and the task was completed, now use the test-runner agent to run the tests
</commentary>
assistant: Uses the agent tool to launch the test-runner agent
</example>
