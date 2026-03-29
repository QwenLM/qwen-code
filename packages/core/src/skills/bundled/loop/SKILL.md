---
name: loop
description: Create a recurring loop that runs a prompt on a schedule. Usage - /loop 5m check the build, /loop check the PR every 30m, /loop run tests (defaults to 10m).
allowedTools:
  - cron_create
---

# Loop

You are setting up a recurring in-session loop. Parse the user's input to extract:

1. **An interval** — look for patterns like `5m`, `30m`, `2h`, `1d`, `90s`, `every 5 minutes`, `every 2 hours`, etc.
   - Supported units: `s` (seconds, rounded up to 1 minute minimum), `m` (minutes), `h` (hours), `d` (days)
   - If no interval is found, default to **10 minutes**
   - The interval can appear at the start (`/loop 5m check the build`) or after "every" (`/loop check the build every 5m`)
2. **A prompt** — everything that isn't the interval is the prompt to run on each iteration

## Converting intervals to cron expressions

- **Every N minutes**: `*/N * * * *` (e.g., 5m → `*/5 * * * *`)
- **Every N hours**: `0 */N * * *` (e.g., 2h → `0 */2 * * *`)
- **Every N days**: `0 0 */N * *` (e.g., 1d → `0 0 */1 * *`)
- For seconds: round up to 1 minute minimum, use `*/1 * * * *`
- For intervals that don't divide evenly into cron (e.g., 45m), pick the closest reasonable cron expression

## What to do

1. Parse the interval and prompt from the user's input
2. Convert the interval to a cron expression
3. Append to the prompt: `\n\nBe concise. If nothing has changed, reply with a single short sentence.`
4. Call `cron_create` with:
   - `cron`: the computed cron expression
   - `prompt`: the extracted prompt with the conciseness instruction appended
   - `recurring`: true
5. Confirm to the user: "Loop created — I'll [description] every [interval]."
