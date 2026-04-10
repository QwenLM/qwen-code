---
name: batch
description: Execute batch operations on multiple files in parallel. Use when you need to apply the same operation to many files at once. Examples - `/batch add JSDoc comments to all .ts files under src`, `/batch convert all .js files to .ts`, `/batch fix lint errors in src/components/*.tsx`. The command will automatically discover target files, split them into chunks, and process them in parallel using worker agents.
allowedTools:
  - task
  - glob
  - grep_search
  - read_file
  - edit_file
  - write_file
  - run_shell_command
---

# /batch - Parallel Batch Operations

You are orchestrating a batch operation across multiple files. Your job is to:

1. Parse the user's request to understand the target files and operation
2. Discover matching files using glob
3. Split files into chunks for parallel processing
4. Launch multiple worker agents to process files concurrently
5. Aggregate results and present a summary

## Step 1: Parse Intent and Discover Files

First, parse the user's request to identify:

- **Target pattern**: glob pattern for files (e.g., `src/**/*.ts`, `**/*.js`)
- **Operation**: what to do with each file (e.g., "add JSDoc comments", "convert to TypeScript")

If the user didn't specify a pattern, infer it from context or ask for clarification.

Use the `glob` tool to discover matching files. Apply these common exclusions automatically:

- `node_modules/**`
- `dist/**`
- `build/**`
- `.git/**`
- `**/*.test.ts`
- `**/*.spec.ts`
- `**/package-lock.json`
- `**/yarn.lock`
- `**/*.min.js`
- Binary files (images, fonts, etc.)
- Files larger than 500KB (check size if needed)

**Important**: If more than 50 files match, inform the user with the exact count and the file list, then proceed. The user can cancel (Ctrl+C) if needed. If the count exceeds 100 files, warn the user and suggest a more specific pattern instead of proceeding.

## Step 2: Chunk Files for Parallel Processing

Split the discovered files into chunks based on these rules:

| Total Files | Chunk Count | Files Per Chunk |
| ----------- | ----------- | --------------- |
| 1-5         | 1           | All files       |
| 6-15        | 2           | ~7-8 each       |
| 16-30       | 3           | ~10 each        |
| 31-50       | 4           | ~10-12 each     |

**Chunking algorithm**:

- Minimum chunk size: 3 files (avoid over-parallelization for small batches)
- Maximum chunk size: 15 files (ensure reasonable work per agent)
- Maximum parallel agents: 5 (API rate limit consideration)

Example: 24 files → 3 chunks of 8 files each

## Step 3: Launch Parallel Worker Agents

Launch worker agents **in parallel** by invoking the Agent tool multiple times in a **SINGLE message**.

Each worker agent should receive:

- The list of files to process (full paths)
- The operation to perform
- Clear instructions to report success/failure per file

Use the `general-purpose` subagent type for workers.

**CRITICAL**: All Agent tool calls MUST be in a single response to enable parallel execution. The system automatically runs multiple Agent calls concurrently.

### Agent Prompt Template

For each chunk, use this prompt format:

```
You are a worker agent processing a batch of files.

**Operation**: [describe the operation, e.g., "Add JSDoc comments to all exported functions"]

**Files to process**:
- [file1.ts]
- [file2.ts]
- ...

**Instructions**:
1. Process each file independently
2. For each file, report either:
   - SUCCESS: [file path] - [brief description of change]
   - FAILED: [file path] - [reason for failure]
3. If a file fails, continue with the next file - do not abort
4. At the end, provide a summary of what was done

**Constraints**:
- Do not modify test files unless explicitly requested
- Preserve existing code style and formatting
- Make minimal necessary changes to accomplish the operation
```

### Example Invocation Pattern

```
<Agent tool call 1>
description: "Process batch chunk 1/3"
prompt: "You are a worker agent... [full prompt as above]"
subagent_type: "general-purpose"
</Agent tool call 1>

<Agent tool call 2>
description: "Process batch chunk 2/3"
prompt: "You are a worker agent... [full prompt as above]"
subagent_type: "general-purpose"
</Agent tool call 2>

<Agent tool call 3>
description: "Process batch chunk 3/3"
prompt: "You are a worker agent... [full prompt as above]"
subagent_type: "general-purpose"
</Agent tool call 3>
```

## Step 4: Aggregate Results

After all worker agents complete, aggregate their results into a clear summary.

### Output Format

```markdown
### Batch Operation Complete

**Operation**: [description of what was done]
**Files discovered**: [total count]
**Chunks processed**: [number of parallel agents]
**Total time**: [duration if tracked]

| Status  | Count |
| ------- | ----- |
| Success | [N]   |
| Failed  | [N]   |
| Skipped | [N]   |

**Successful files**:

- [file1.ts] - [brief description]
- [file2.ts] - [brief description]
  ...

**Failed files** (if any):

- [file.ts]: [reason for failure]

**Skipped files** (if any):

- [file.ts]: [reason for skipping]
```

### Handling Partial Failures

If some files failed but others succeeded:

- Clearly report which files succeeded
- List failures with specific reasons
- Suggest follow-up actions if appropriate

If all files failed:

- Report the common failure pattern
- Suggest potential fixes

## Step 5: Error Handling

### During Batch Processing

1. **Single file failure**: Don't abort the batch. The worker agent records the error and continues.
2. **Agent failure**: If a worker agent fails completely (timeout, crash), note the chunk as failed with reason.
3. **User cancellation**: If the user sends Ctrl+C, the system will cancel all pending agents gracefully.

### Error Reporting

For each failed file, include:

- File path
- Specific error message or reason
- Suggested fix if obvious

## Usage Examples

### Example 1: Add License Headers

```
/batch Add Apache 2.0 license header to all .ts files in src/
```

**Flow**:

1. glob `src/**/*.ts` → find 45 files
2. Split into 4 chunks
3. Launch 4 parallel agents
4. Each agent adds the license header to its assigned files
5. Summary: 45 files processed, 45 succeeded, 0 failed

### Example 2: Convert JavaScript to TypeScript

```
/batch Convert all .js files in utils/ to TypeScript
```

**Flow**:

1. glob `utils/**/*.js` → find 12 files
2. Split into 2 chunks
3. Launch 2 parallel agents
4. Each agent converts files and renames to .ts
5. Summary: 12 files processed, 10 succeeded, 2 failed (complex dynamic patterns)

### Example 3: Fix Lint Errors

```
/batch Fix all @typescript-eslint/no-explicit-any errors in src/
```

**Flow**:

1. Use `grep_search` to find files containing `: any` pattern in `src/`
2. Filter to relevant files
3. Split into chunks and launch parallel agents
4. Each agent fixes the specific lint issue (replace `any` with proper types)
5. Summary: 8 files fixed

## Constraints and Limits

| Constraint          | Value | Reason                       |
| ------------------- | ----- | ---------------------------- |
| Max files per batch | 100   | Prevent resource exhaustion  |
| Max parallel agents | 5     | API rate limit consideration |
| Min files per agent | 3     | Avoid over-parallelization   |
| Max files per agent | 15    | Ensure meaningful work       |
| File size limit     | 500KB | Avoid context overflow       |

## Dry-Run Mode

If the user wants to preview what will be changed without actually modifying files:

1. Discover and list all matching files
2. Show the planned operation for each file
3. Ask the user if they want to proceed with the actual changes

Example: `/batch --dry-run add JSDoc comments to src/**/*.ts`
