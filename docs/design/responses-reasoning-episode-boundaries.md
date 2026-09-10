# Preserve Responses reasoning item boundaries

PR #8169 maps each completed Responses reasoning item to one `thoughtSignature`
containing JSON `{ id, encrypted_content }`. PR #8260 consolidates shared thought
parts, but cannot separate adjacent summary-free items using text boundaries.
Concatenating their JSON payloads makes both unreplayable. A quiet item followed
by a summarized item can also absorb the latter's summary and signature.

Recognize the existing complete Responses payload at consolidation and close its
episode immediately after appending it. Keep the encrypted content opaque and
unchanged. Other signature strings retain fragment concatenation, including
Anthropic signature deltas and signature-before-text proxy output. This needs no
new provider setting, no dependency on #8169's modules, and no history migration.
The format check must require string `id` and `encrypted_content` fields; arbitrary
JSON or incomplete payloads are not completion signals.

Validation uses the unchanged #8260 Anthropic tests, focused shared-history tests
for summary-free and mixed episodes and recording, and a combined #8169 + #8260
checkout using actual Responses event conversion and outbound request conversion.
Built-CLI verification uses synthetic loopback Responses SSE data to check tool
continuation and persisted resume. No production credentials are needed. This
change does not repair previously corrupted saved signatures or address context
compression and cross-provider provenance.
