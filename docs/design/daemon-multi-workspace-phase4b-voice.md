# Workspace-qualified Voice

## Goal

Expose the existing daemon Voice settings, batch transcription, and streaming
transcription surfaces for every trusted workspace runtime without changing
legacy primary-only routes.

## Design

`GET`/`POST /workspaces/:workspace/voice`,
`POST /workspaces/:workspace/voice/transcribe`, and
`WS /workspaces/:workspace/voice/stream` resolve a registered trusted runtime
by id or encoded cwd. They use that runtime's cwd, effective environment,
bridge, and workspace settings. Voice setting writes through plural REST always
use workspace scope; secondary ACP voice writes use the same scope so they
cannot mutate shared user settings.

One process-scoped `WorkspaceVoiceCoordinator` owns the existing limit of
eight active Voice operations. It accounts for both WebSocket and REST batch
work across legacy and workspace-qualified paths. A removal drain rejects new
admission but leaves existing Voice work visible to the non-force removal
activity snapshot. Runtime disposal aborts only the selected runtime's Voice
leases before its bridge is shut down.

## Compatibility

Legacy `/workspace/voice`, `/workspace/voice/transcribe`, and `/voice/stream`
remain bound to the primary workspace. ACP method names and Voice settings
schema are unchanged. `workspace_qualified_voice` advertises all qualified
Voice modalities when the shared ACP/Voice WebSocket listener is enabled. The
existing Voice modality capability tags remain
primary-workspace signals and are not prerequisites for a secondary runtime,
whose configuration is validated by the selected route.

Unknown workspace selectors return `400 workspace_mismatch`; registered but
untrusted runtimes return `403 untrusted_workspace` before Voice settings or
audio are read. The shared eight-operation admission cap covers batch and
streaming work for both legacy and plural routes. Batch capacity failures return
`503 voice_capacity_exceeded` with `Retry-After: 5`; streaming capacity failures
send an error frame and close with code `1013`.
