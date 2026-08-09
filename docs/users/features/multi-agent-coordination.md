# Multi-Agent Coordination

Use `/coordinate` when a task benefits from several independent investigations and one consolidated result:

```text
/coordinate inspect the authentication flow, compare the retry paths, and implement the smallest safe fix
```

Qwen Code launches up to three homogeneous `coordinator-explore` agents concurrently. They inherit the current session's model and have only the canonical read-only repository tools. They cannot edit files, run shell commands, delegate, or ask questions.

The current Qwen session remains the Leader. It validates and reconciles the investigators' evidence, then directly completes any requested change in the current workspace. Only the Leader writes, so there are no concurrent writers or hidden merge steps. Verification runs after the implementation is complete.

`/coordinate` is explicit and bounded. It does not create a persistent Agent Team, run background sessions, share transcripts between agents, select heterogeneous models, or automatically fan out ordinary prompts.
