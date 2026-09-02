# Cancelled prompt restoration after streamed output

## Scenario

1. Start Qwen Code in interactive mode.
2. Submit `Explain how a hash table handles collisions in detail.`
3. Wait until response text is visible, then press Ctrl+C.
4. Confirm the partial response remains in the transcript.
5. Confirm the submitted prompt is restored to the input box and can be edited.

## Regression checks

- A draft typed while the response is running is not overwritten.
- A queued follow-up remains the editable input instead of restoring the prior prompt.
- Cancelling during a tool call keeps the existing tool-execution behavior.
- Cancelling before any response still rewinds the empty turn as before.

## Automated verification

```bash
cd packages/cli
npx vitest run src/ui/AppContainer.test.tsx
npx vitest run src/ui/hooks/useGeminiStream.test.tsx -t 'flushes buffered stream events before snapshotting'
```

Result: 119 AppContainer tests passed; the stream flush-race regression passed.

## Manual status

Not run in this environment because a global released `qwen` executable was not available for the required before/after comparison.
