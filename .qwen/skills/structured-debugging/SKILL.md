---
name: structured-debugging
description: >
  Hypothesis-driven debugging methodology for hard bugs. Use this skill whenever
  you're investigating non-trivial bugs, unexpected behavior, flaky tests, or
  tracing issues through complex systems. Activate proactively when debugging
  requires more than a quick glance — especially when the first attempt at a fix
  didn't work, when behavior seems "impossible", or when you're tempted to blame
  an external system (model, API, library) without evidence.
---

# Structured Debugging

When debugging hard issues, the natural instinct is to form a theory and immediately
apply a fix. This fails more often than it works. The fix addresses the wrong cause,
adds complexity, creates false confidence, and obscures the real issue. Worse, after
several failed attempts you lose track of what's been tried and start guessing randomly.

This methodology replaces guessing with a disciplined cycle that converges on the
root cause. Each iteration narrows the search space. It's slower per attempt but
dramatically faster overall because you stop wasting runs on wrong theories.

## The Cycle

### 1. Hypothesize

Before touching code, write down what you think is happening and why. Be specific
about the expected state at each step in the execution path.

Bad: "Something is wrong with the wait loop."
Good: "The leader hangs because `hasActiveTeammates()` returns true after all agents
have reported completed, likely because terminal status isn't being set on the agent
object after the backend process exits."

Create a side note file for the investigation:

```
knowledge/qwen-code/investigations/<issue>.md
```

Write your hypothesis there. This file persists across conversation turns and even
across sessions — it's your investigation journal.

### 2. Design Instrumentation

Add targeted debug logs or assertions at the exact decision points that would
confirm or reject your hypothesis. Think about what data you need to see.

Don't scatter `console.log` everywhere. Identify the 2-3 places where your
hypothesis makes a testable prediction, and instrument those.

Ask yourself: "If my hypothesis is correct, what will I see at point X?
If it's wrong, what will I see instead?"

### 3. Verify Data Collection

Before running, confirm that your instrumentation output will actually be captured
and accessible.

Common traps:

- stderr discarded by `2>/dev/null` in the test command
- Process killed before flush (logs lost)
- Logging to a file in a directory that doesn't exist
- Output piped through something that truncates it
- Looking at log files from a _previous_ run, not the current one

A test run that produces no data is wasted.

### 4. Run and Observe

Execute the test. Read the actual output — every line of it. Don't assume what it says.

When the data contradicts your hypothesis, believe the data. Don't rationalize it
away. The whole point of this step is to let reality override your theory.

### 5. Document Findings

Update the side note with:

- What the data showed (quote specific log lines)
- What was confirmed vs. disproved
- Updated hypothesis for the next iteration

This is critical for not losing context across attempts. Hard bugs typically take
3-5 rounds. Without notes, you'll forget what you ruled out and waste runs
re-checking things.

### 6. Iterate

Update the hypothesis based on the new evidence. Go back to step 2. Each round
should narrow the search space.

If you're not making progress after 3 rounds, step back and question your
assumptions. The bug might be in a layer you haven't considered.

## Failure Modes to Avoid

These are the specific traps this methodology is designed to prevent. When you
notice yourself drifting toward any of them, stop and return to the cycle.

### Jumping to fixes without evidence

The most common failure. You have a plausible theory, so you "fix" it and run again.
If the theory was wrong, you've added complexity, wasted a test run, and possibly
introduced a new bug. The side note should always show "hypothesis verified by
[specific data]" before any fix is applied.

### Blaming external systems

"The model is hallucinating." "The API is flaky." "The library has a bug." These
conclusions feel satisfying because they put the problem outside your control. They're
also usually wrong.

Before blaming an external system, inspect what it actually received. A model that
appears to hallucinate may be responding rationally to stale data you didn't know
was there. An API that appears flaky may be receiving malformed requests. Look at
the inputs, not just the outputs.

### Inspecting code paths but not data

You instrument the code and prove it executes correctly — the right functions are
called, in the right order, with no errors. But the bug persists. Why?

Because the code can work perfectly while processing garbage input. A function that
correctly reads an inbox, correctly delivers messages, and correctly formats output
is still broken if the inbox contains stale messages from a previous run.

Always inspect the _content_ flowing through the code, not just whether the code
runs. Check payloads, message contents, file data, and database state.

### Losing context across attempts

After several debugging rounds, you start forgetting what you already tried and
what you ruled out. You re-check things, go in circles, or abandon a promising
line of investigation because you lost track of where it was heading.

This is why the side note file exists. Update it after every run. When you start
a new round, re-read it first.

## Persistent State: A Special Category

Features that persist data across runs — caches, session recordings, message queues,
temp files, database rows — are a frequent source of "impossible" bugs. The current
run's behavior is contaminated by leftover state from previous runs.

When behavior seems irrational, always check:

- Is there persistent state that carries across runs?
- Was it cleared before this run?
- Is the system responding to stale data rather than current data?

This is easy to miss because the code is correct — it's the data that's wrong.

## When to Exit the Cycle

Apply the fix when — and only when — you can point to specific data from your
instrumentation that confirms the root cause. Write in the side note:

```
Root cause: [specific mechanism]
Evidence: [specific log lines / data that confirm it]
Fix: [what you're changing and why it addresses the root cause]
```

Then apply the fix, remove instrumentation, and verify with a clean run.

## Worked examples

- [`examples/headless-bg-agent-empty-stdout.md`](examples/headless-bg-agent-empty-stdout.md)
  — pipe-captured runs all passed; the user's TTY printed nothing. The
  contradiction _was_ the bug. Illustrates _reproduction contradiction is
  data_ and _instrument data, not code paths_.
