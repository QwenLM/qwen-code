# Agent Arena

> Dispatch multiple AI models simultaneously to execute the same task, compare their solutions side-by-side, and select the best result to apply to your workspace.

> [!warning]
> Agent Arena is experimental. It has [known limitations](#limitations) around display modes and session management.

Agent Arena lets you pit multiple AI models against each other on the same task. Each model runs as a fully independent agent in its own isolated Git worktree, so file operations never interfere. When all agents finish, you compare results and select a winner to merge back into your main workspace.

Unlike [subagents](/users/features/sub-agents), which delegate focused subtasks within a single session, Arena agents are complete, top-level agent instances — each with its own model, context window, and full tool access.

This page covers:

- [When to use Agent Arena](#when-to-use-agent-arena)
- [Starting an arena session](#start-an-arena-session)
- [Interacting with agents](#interact-with-agents), including display modes and navigation
- [Comparing results and selecting a winner](#compare-results-and-select-a-winner)
- [Best practices](#best-practices)

## When to use Agent Arena

Agent Arena is most effective when you want to **evaluate or compare** how different models tackle the same problem. The strongest use cases are:

- **Model benchmarking**: Evaluate different models' capabilities on real tasks in your actual codebase, not synthetic benchmarks
- **Best-of-N selection**: Get multiple independent solutions and pick the best implementation
- **Exploring approaches**: See how different models reason about and solve the same problem — useful for learning and insight
- **Risk reduction**: For critical changes, validate that multiple models converge on a similar approach before committing

Agent Arena uses significantly more tokens than a single session (each agent has its own context window and model calls). It works best when the value of comparison justifies the cost. For routine tasks where you trust your default model, a single session is more efficient.

## Start an arena session

Use the `/arena` slash command to launch a session. Specify the models you want to compete and the task:

```
/arena --models qwen3.5-plus,glm-5,kimi-k2.5 "Refactor the authentication module to use JWT tokens"
```

If you omit `--models`, an interactive model selection dialog appears, letting you pick from your configured providers.

### What happens when you start

1. **Worktree setup**: Qwen Code creates isolated Git worktrees for each agent at `~/.qwen/arena/<session-id>/worktrees/<model-name>/`. Each worktree mirrors your current working directory state exactly — including staged changes, unstaged changes, and untracked files.
2. **Agent spawning**: Each agent starts in its own worktree with full tool access and its configured model. Agents are launched sequentially but execute in parallel.
3. **Execution**: All agents work on the task independently with no shared state or communication. You can monitor their progress and interact with any of them.
4. **Completion**: When all agents finish (or fail), you enter the result comparison phase.

## Interact with agents

### Display modes

Agent Arena currently supports **in-process mode**, where all agents run asynchronously within the same terminal process. A tab bar at the bottom of the terminal lets you switch between agents.

> [!note]
> **Split-pane display modes are planned for the future.** We intend to support tmux-based and iTerm2-based split-pane layouts, where each agent gets its own terminal pane for true side-by-side viewing. Currently, only in-process tab switching is available.

### Navigate between agents

In in-process mode, use keyboard shortcuts to switch between agent views:

| Shortcut | Action                            |
| :------- | :-------------------------------- |
| `Right`  | Switch to the next agent tab      |
| `Left`   | Switch to the previous agent tab  |
| `Up`     | Switch focus to the input box     |
| `Down`   | Switch focus to the agent tab bar |

The tab bar shows each agent's current status:

| Indicator | Meaning                |
| :-------- | :--------------------- |
| `●`       | Running or idle        |
| `✓`       | Completed successfully |
| `✗`       | Failed                 |
| `○`       | Cancelled              |

### Interact with individual agents

When viewing an agent's tab, you can:

- **Send messages** — type in the input area to give the agent additional instructions
- **Approve tool calls** — if an agent requests tool approval, the confirmation dialog appears in its tab
- **View full history** — scroll through the agent's complete conversation, including model output, tool calls, and results

Each agent is a full, independent session. Anything you can do with the main agent, you can do with an arena agent.

## Compare results and select a winner

When all agents complete, the Arena enters the result comparison phase. You'll see:

- **Status summary**: Which agents succeeded, failed, or were cancelled
- **Execution metrics**: Duration, rounds of reasoning, token usage, and tool call counts for each agent

A selection dialog presents the successful agents. Choose one to apply its changes to your main workspace, or discard all results.

### What happens when you select a winner

1. The winning agent's changes are extracted as a diff against the baseline
2. The diff is applied to your main working directory
3. All worktrees and temporary branches are cleaned up automatically

If you want to inspect results before deciding, each agent's full conversation history is available via the tab bar while the selection dialog is active.

## Configuration

Arena behavior can be customized in [settings.json](/users/configuration/settings):

```json
{
  "arena": {
    "worktreeBaseDir": "~/.qwen/arena",
    "maxRoundsPerAgent": 50,
    "timeoutSeconds": 600
  }
}
```

| Setting                   | Description                        | Default         |
| :------------------------ | :--------------------------------- | :-------------- |
| `arena.worktreeBaseDir`   | Base directory for arena worktrees | `~/.qwen/arena` |
| `arena.maxRoundsPerAgent` | Maximum reasoning rounds per agent | `50`            |
| `arena.timeoutSeconds`    | Timeout for each agent in seconds  | `600`           |

## Best practices

### Choose models that complement each other

Arena is most valuable when you compare models with meaningfully different strengths. For example:

```
/arena --models qwen3.5-plus,glm-5,kimi-k2.5 "Optimize the database query layer"
```

Comparing three versions of the same model family yields less insight than comparing across providers.

### Keep tasks self-contained

Arena agents work independently with no communication. Tasks should be fully describable in the prompt without requiring back-and-forth:

**Good**: "Refactor the payment module to use the strategy pattern. Update all tests."

**Less effective**: "Let's discuss how to improve the payment module" — this benefits from conversation, which is better suited to a single session.

### Limit the number of agents

Up to 5 agents can run simultaneously. In practice, 2-3 agents provide the best balance of comparison value to resource cost. More agents means:

- Higher token costs (each agent has its own context window)
- Longer total execution time
- More results to compare

Start with 2-3 and scale up only when the comparison value justifies it.

### Use Arena for high-impact decisions

Arena shines when the stakes justify running multiple models:

- Choosing an architecture for a new module
- Selecting an approach for a complex refactor
- Validating a critical bug fix from multiple angles

For routine changes like renaming a variable or updating a config file, a single session is faster and cheaper.

## Troubleshooting

### Agents failing to start

- Verify that each model in `--models` is properly configured with valid API credentials
- Check that your working directory is a Git repository (worktrees require Git)
- Ensure you have write access to the worktree base directory (`~/.qwen/arena/` by default)

### Worktree creation fails

- Run `git worktree list` to check for stale worktrees from previous sessions
- Clean up stale worktrees with `git worktree prune`
- Ensure your Git version supports worktrees (`git --version`, requires Git 2.5+)

### Agent takes too long

- Increase the timeout: set `arena.timeoutSeconds` in settings
- Reduce task complexity — Arena tasks should be focused and well-defined
- Lower `arena.maxRoundsPerAgent` if agents are spending too many rounds

### Applying winner fails

- Check for uncommitted changes in your main working directory that might conflict
- The diff is applied as a patch — merge conflicts are possible if your working directory changed during the session

## Limitations

Agent Arena is experimental. Current limitations:

- **In-process mode only**: Split-pane display via tmux or iTerm2 is not yet available. All agents run within a single terminal window with tab switching.
- **No diff preview before selection**: You can view each agent's conversation history, but there is no unified diff viewer to compare solutions side-by-side before picking a winner.
- **No worktree retention**: Worktrees are always cleaned up after selection. There is no option to preserve them for further inspection.
- **No session resumption**: Arena sessions cannot be resumed after exiting. If you close the terminal mid-session, worktrees remain on disk and must be cleaned up manually via `git worktree prune`.
- **Maximum 5 agents**: The hard limit of 5 concurrent agents cannot be changed.
- **Git repository required**: Arena requires a Git repository for worktree isolation. It cannot be used in non-Git directories.

## Comparison with other multi-agent modes

Agent Arena is one of several multi-agent modes in Qwen Code. **Agent Team** is not yet implemented. **Agent Swarm** is available as a lightweight tool for batch-style parallel worker execution.

|                   | **Agent Arena**                                        | **Agent Team** (planned)                           | **Agent Swarm**                                          |
| :---------------- | :----------------------------------------------------- | :------------------------------------------------- | :------------------------------------------------------- |
| **Goal**          | Competitive: Find the best solution to the _same_ task | Collaborative: Tackle _different_ aspects together | Batch parallel: Dynamically spawn workers for bulk tasks |
| **Agents**        | Pre-configured models compete independently            | Teammates collaborate with assigned roles          | Workers spawned on-the-fly, destroyed on completion      |
| **Communication** | No inter-agent communication                           | Direct peer-to-peer messaging                      | One-way: results aggregated by parent                    |
| **Isolation**     | Full: separate Git worktrees                           | Independent sessions with shared task list         | Lightweight ephemeral context per worker                 |
| **Output**        | One selected solution applied to workspace             | Synthesized results from multiple perspectives     | Aggregated results from parallel processing              |
| **Best for**      | Benchmarking, choosing between model approaches        | Research, complex collaboration, cross-layer work  | Batch operations, data processing, map-reduce tasks      |

## Next steps

Explore related approaches for parallel and delegated work:

- **Lightweight delegation**: [Subagents](/users/features/sub-agents) handle focused subtasks within your session — better when you don't need model comparison
- **Manual parallel sessions**: Run multiple Qwen Code sessions yourself in separate terminals with [Git worktrees](https://git-scm.com/docs/git-worktree) for full manual control
