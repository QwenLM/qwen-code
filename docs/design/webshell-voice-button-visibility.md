# WebShell Voice Button Visibility

## Summary

The WebShell voice button is visible only when the workspace explicitly enables voice, the embedding host allows the voice toolbar action, and the daemon advertises the `voice_transcribe` capability.

## Decision

The host toolbar filter remains the outer gate. When the host allows voice, `VoiceButton` reads the existing `/workspace/voice` status and accepts only `enabled: true`. A missing capability avoids the status request entirely.

The status is fail-closed: the button stays hidden while the request is pending or after it fails. Each settings event invalidates the previous result and starts a fresh request. Results are tied to the workspace client and settings version so a late response cannot re-enable a stale configuration.

## Boundaries

Voice model selection, available model discovery, and voice mode do not affect button visibility. Invalid model configuration continues to use the existing capture error path after the user clicks the button.

This change does not add a WebShell prop, daemon endpoint, SDK type, or configuration field.
