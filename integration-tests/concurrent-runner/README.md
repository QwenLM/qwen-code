# Qwen Concurrent Runner

A Python tool for executing multiple Qwen CLI tasks across different models concurrently using isolated git worktrees.

## Overview

This tool enables you to:

- Run multiple tasks against multiple models in parallel
- Create isolated git worktrees for each execution
- Track execution status in real-time
- Capture and store all outputs (stdout, stderr, and OpenAI logs)
- Resume or analyze results after completion

## Installation

```bash
# Install dependencies
pip install -r requirements.txt
```

## Usage

```bash
python runner.py config.json
```

## Configuration

Create a JSON configuration file (see `config.example.json`):

```json
{
  "concurrency": 3,
  "yolo": true,
  "source_repo": ".",
  "worktree_base": "~/.qwen/worktrees",
  "outputs_dir": "./outputs",
  "results_file": "./results.json",
  "tasks": [
    {
      "id": "code-review",
      "name": "Security Code Review",
      "prompts": ["Review the codebase for security vulnerabilities."]
    }
  ],
  "models": ["claude-3-5-sonnet-20241022", "qwen3-coder-plus"]
}
```

### Configuration Options

| Option          | Type   | Default           | Description                                   |
| --------------- | ------ | ----------------- | --------------------------------------------- |
| `concurrency`   | int    | 4                 | Maximum parallel executions                   |
| `yolo`          | bool   | true              | Auto-approve all actions                      |
| `source_repo`   | string | .                 | Source git repository path                    |
| `branch`        | string | null              | Git branch to checkout (uses default if null) |
| `worktree_base` | string | ~/.qwen/worktrees | Base directory for git worktrees              |
| `outputs_dir`   | string | ./outputs         | Directory for captured output                 |
| `results_file`  | string | ./results.json    | JSON file for run tracking                    |
| `tasks`         | array  | []                | List of task definitions                      |
| `models`        | array  | []                | List of model identifiers                     |

### Task Definition

Each task has:

- `id`: Unique identifier
- `name`: Human-readable name
- `prompts`: Array of prompt strings (joined with newlines)

## Output Structure

Each run creates an isolated output directory:

```
outputs/
├── {run_id}/
│   ├── stdout.txt        # CLI stdout
│   ├── stderr.txt        # CLI stderr
│   └── logs/             # OpenAI API logs
│       └── openai-*.json
```

## results.json

```json
{
  "updated_at": "2026-01-28T10:30:00",
  "runs": [
    {
      "run_id": "abc123",
      "task_id": "code-review",
      "task_name": "Security Code Review",
      "model": "qwen3-coder-plus",
      "status": "succeeded",
      "worktree_path": "~/.qwen/worktrees/run-abc123",
      "output_dir": "outputs/abc123",
      "logs_dir": "outputs/abc123/logs",
      "started_at": "2026-01-28T10:00:00",
      "ended_at": "2026-01-28T10:05:00",
      "exit_code": 0,
      "stdout_file": "outputs/abc123/stdout.txt",
      "stderr_file": "outputs/abc123/stderr.txt"
    }
  ]
}
```

## Execution Flow

1. **Generate Matrix**: Create N×M run combinations (tasks × models)
2. **Create Worktree**: Git worktree add from source repo
3. **Initialize**: npm install && npm run build
4. **Execute**: Run qwen CLI with captured output (logs go to run-specific folder)
5. **Cleanup**: Remove git worktree (always executed)

## Status Values

- `queued`: Waiting to start
- `preparing`: Creating git worktree
- `initializing`: Running npm install + build
- `running`: Executing qwen CLI
- `succeeded`: Completed successfully
- `failed`: Error occurred

## Requirements

- Python 3.10+
- Git repository (for worktree operations)
- Node.js and npm (for build step)
- `qwen` CLI in PATH

## Exit Codes

- 0: All runs succeeded
- 1: One or more runs failed
- 130: Interrupted by user (Ctrl+C)
