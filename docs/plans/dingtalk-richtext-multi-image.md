# DingTalk Rich-Text Multi-Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver every image from one DingTalk `richText` callback to the multimodal model and persist every image reference for Web Shell replay.

**Architecture:** Normalize legacy single-image input and structured image attachments into an ordered bridge-level image array. DingTalk downloads every picture part, while ACP emits every image block and the daemon uploads every image before submitting one prompt.

**Tech Stack:** TypeScript, Vitest, DingTalk Stream adapter, Agent Client Protocol, Qwen daemon session attachment API.

**Spec:** `docs/design/dingtalk-richtext-multi-image.md`

## Global Constraints

- Preserve `imageBase64` and `imageMimeType` compatibility for existing adapters.
- Preserve source order from `content.richText[]` through the model prompt and Web Shell transcript.
- Do not change collection of separate messages received during an active turn.
- Add no dependency or configuration.
- Run tests from each package directory.

---

### Task 1: DingTalk downloads every picture part

**Files:**

- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts:2119-2140,2343-2353`
- Test: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Consumes: `extractContent(data).downloadCodes: string[]` in callback order.
- Produces: `Envelope.attachments` containing one data-backed image per successful download in the same order.

- [ ] **Step 1: Write the failing adapter test**

Add a test that sends one `richText` callback with two literal picture parts, returns distinct bytes for each `downloadCode`, and asserts that both codes were downloaded and both base64 attachments reached `handleInbound` in order.

```ts
expect(downloadCodes).toEqual(['picture-1', 'picture-2']);
expect(envelope.attachments).toEqual([
  {
    type: 'image',
    data: Buffer.from([1]).toString('base64'),
    mimeType: 'image/png',
  },
  {
    type: 'image',
    data: Buffer.from([2]).toString('base64'),
    mimeType: 'image/png',
  },
]);
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts -t "downloads every picture in one richText callback"
```

Expected: FAIL because only `picture-1` is requested and only one attachment exists.

- [ ] **Step 3: Implement ordered multi-download**

Replace the first-only call with a sequential loop:

```ts
for (const downloadCode of content.downloadCodes) {
  await this.attachMedia(
    envelope,
    downloadCode,
    content.mediaType,
    content.fileName,
    content.placeholder,
  );
}
```

Make every successful image download append a data-backed attachment; retain the existing temp-file path for file, audio, and video media.

- [ ] **Step 4: Run the targeted adapter tests and verify GREEN**

```bash
cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts
```

Expected: PASS, including updated quoted-two-image expectations that both images are data-backed.

- [ ] **Step 5: Commit the adapter behavior**

```bash
git add packages/channels/dingtalk/src/DingtalkAdapter.ts packages/channels/dingtalk/src/DingtalkAdapter.test.ts
git commit -m "fix(channels): retain all DingTalk rich-text images"
```

### Task 2: ChannelBase carries an ordered image collection

**Files:**

- Modify: `packages/channels/base/src/ChannelAgentBridge.ts:110-116`
- Modify: `packages/channels/base/src/ChannelBase.ts:5251-5284,5656-5661`
- Test: `packages/channels/base/src/ChannelBase.test.ts`

**Interfaces:**

- Produces: `ChannelPromptImage { data: string; mimeType: string }` and `ChannelAgentBridgePromptOptions.images?: ChannelPromptImage[]`.
- Compatibility input: `imageBase64?: string` plus `imageMimeType?: string`.

- [ ] **Step 1: Write failing ChannelBase tests**

Add one test with two data-backed `Envelope.attachments` and assert the bridge receives:

```ts
images: [
  { data: 'first', mimeType: 'image/png' },
  { data: 'second', mimeType: 'image/jpeg' },
];
```

Keep the legacy test and change its assertion to the same one-element `images` shape.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts -t "image"
```

Expected: FAIL because the bridge options contain only singular image fields.

- [ ] **Step 3: Add the bridge image type and normalization**

```ts
export interface ChannelPromptImage {
  data: string;
  mimeType: string;
}

export interface ChannelAgentBridgePromptOptions {
  images?: ChannelPromptImage[];
  imageBase64?: string;
  imageMimeType?: string;
  displayText?: string;
}
```

Build `images` in legacy-first, attachment-order sequence and pass it to `promptBridge.prompt`. Preserve file-path rendering for attachments without image data.

- [ ] **Step 4: Run ChannelBase tests and verify GREEN**

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts
```

Expected: PASS with no change to non-image attachment behavior.

- [ ] **Step 5: Commit the bridge contract**

```bash
git add packages/channels/base/src/ChannelAgentBridge.ts packages/channels/base/src/ChannelBase.ts packages/channels/base/src/ChannelBase.test.ts
git commit -m "feat(channels): carry ordered prompt images"
```

### Task 3: ACP sends every image as a native content block

**Files:**

- Modify: `packages/channels/base/src/AcpBridge.ts:285-299`
- Test: `packages/channels/base/src/AcpBridge.test.ts`

**Interfaces:**

- Consumes: `ChannelAgentBridgePromptOptions.images` with legacy single-image fallback.
- Produces: ACP prompt content containing every `{ type: 'image', data, mimeType }` block before text.

- [ ] **Step 1: Write the failing ACP test**

Call `prompt` with two literal images and assert the connection receives:

```ts
prompt: [
  { type: 'image', data: 'first', mimeType: 'image/png' },
  { type: 'image', data: 'second', mimeType: 'image/jpeg' },
  { type: 'text', text: 'describe both' },
];
```

- [ ] **Step 2: Run the ACP test and verify RED**

```bash
cd packages/channels/base && npx vitest run src/AcpBridge.test.ts -t "multiple images"
```

Expected: FAIL because `images` is not consumed.

- [ ] **Step 3: Implement image iteration**

Normalize `options.images` with the legacy pair as fallback, push each image block, then push the text block. Do not alter ACP metadata.

- [ ] **Step 4: Run ACP tests and verify GREEN**

```bash
cd packages/channels/base && npx vitest run src/AcpBridge.test.ts
```

Expected: PASS, including existing single-image behavior.

- [ ] **Step 5: Commit ACP support**

```bash
git add packages/channels/base/src/AcpBridge.ts packages/channels/base/src/AcpBridge.test.ts
git commit -m "feat(channels): send all prompt images over ACP"
```

### Task 4: Daemon persists every image for Web Shell

**Files:**

- Modify: `packages/channels/base/src/DaemonChannelBridge.ts:43-51,125-142,428-441`
- Test: `packages/channels/base/src/DaemonChannelBridge.test.ts:79-101,1889-1948`

**Interfaces:**

- Consumes: ordered `ChannelAgentBridgePromptOptions.images` with legacy fallback.
- Produces: one `session.uploadAttachment` call and one attachment reference prompt block per image.

- [ ] **Step 1: Extend the existing failing daemon replay test**

Pass two images, return two distinct attachment references, and assert upload order plus this prompt:

```ts
prompt: [
  { type: 'image', attachmentId: 'image.png', mimeType: 'image/png', size: 12 },
  {
    type: 'image',
    attachmentId: 'image-2.jpeg',
    mimeType: 'image/jpeg',
    size: 13,
  },
  { type: 'text', text: 'describe' },
];
```

- [ ] **Step 2: Run the daemon test and verify RED**

```bash
cd packages/channels/base && npx vitest run src/DaemonChannelBridge.test.ts -t "stores channel images"
```

Expected: FAIL because only the singular image is uploaded.

- [ ] **Step 3: Implement ordered uploads with unique names**

Iterate all normalized images, generate deterministic names (`image.png`, `image-2.jpeg`, ...), await each `uploadAttachment`, and push every returned reference before text.

- [ ] **Step 4: Run daemon tests and verify GREEN**

```bash
cd packages/channels/base && npx vitest run src/DaemonChannelBridge.test.ts
```

Expected: PASS and the prompt contains all persisted attachment references.

- [ ] **Step 5: Commit daemon persistence**

```bash
git add packages/channels/base/src/DaemonChannelBridge.ts packages/channels/base/src/DaemonChannelBridge.test.ts
git commit -m "feat(channels): persist all channel images in daemon sessions"
```

### Task 5: Verify the complete behavior

**Files:**

- Modify only if verification exposes a defect in the files above.
- Record runtime evidence in the final handoff and Issue/PR text; do not commit credentials or callback payloads.

**Interfaces:**

- Consumes: built channel packages and the configured local DingTalk daemon.
- Produces: unit, build, typecheck, and user-visible Web Shell evidence.

- [ ] **Step 1: Run package verification**

```bash
npm run build
npx tsc --noEmit -p packages/channels/base/tsconfig.json
npx tsc --noEmit -p packages/channels/dingtalk/tsconfig.json
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts src/AcpBridge.test.ts src/DaemonChannelBridge.test.ts
cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 2: Reload the configured channel worker**

Run `npm run dev -- channel reload`, then confirm `npm run dev -- channel status` reports the DingTalk worker running.

- [ ] **Step 3: Perform the five-image E2E**

Send five hand images together as one DingTalk message and verify:

- one DingTalk callback is accepted;
- five media downloads complete;
- five daemon attachment uploads return HTTP 201;
- the persisted user turn has five `attachmentReferences` in order;
- Web Shell shows five image previews;
- the model reports five hands.

- [ ] **Step 4: Self-audit the final diff**

Read `git diff HEAD^` and all untracked files without filtering for expected changes. Verify no secrets, callback payloads, unrelated lockfile changes, or separate-message buffer behavior entered the patch.
