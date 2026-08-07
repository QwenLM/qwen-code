# Qwen Code and Agentix runtime handoff

The Qwen adapter treats Agentix as an external, published memory boundary. It
does not import the sidecar implementation or private memory records.

## Single active context source

The local launcher sets `QWEN_AGENTIX_SNAPSHOT_PATH` to the current Agentix
snapshot and bounds it with `QWEN_MEMORY_SNAPSHOT_MAX_CHARS`. Qwen injects that
file as labelled recalled context, ending with an explicit statement that it is
not a new user instruction. This prevents a stale memory brief from impersonating
the active conversation.

Qwen managed auto-memory should be disabled when Agentix is the selected memory
owner (`memory.enableManagedAutoMemory=false`). Existing provider memory files
may remain on disk for recovery, but they must not be active competing inputs.

## Incremental refresh contract

When automatic refresh is enabled, the adapter invokes only configured external
commands:

1. extract unprocessed Qwen session logs;
2. train only sessions absent from the training ledger;
3. publish a bounded snapshot containing semantic recall, recent evidence, and a
   small graph neighborhood.

Extraction and training are idempotent. A session ledger prevents replaying the
whole transcript corpus at every compression event, and logical sessions are
deduplicated before training.

## Failure behavior

If the provider quota or semantic readout model is unavailable, Agentix falls
back to deterministic vector/statistical recall. Qwen retains the active turn
and does not treat an unavailable snapshot as valid compressed history.

The adapter remains deliberately narrow: it owns context assembly and lifecycle
hooks, while Agentix owns memory state, provenance, graph construction, and
privacy policy.
