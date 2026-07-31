import { describe, expect, it } from 'bun:test'
import { getSingularPatch } from '@pierre/diffs'
import { ensureUnifiedDiffFormat } from '../diff-normalize'

const validUnifiedDiff = [
  '--- a/src/file.ts',
  '+++ b/src/file.ts',
  '@@ -1,2 +1,3 @@',
  ' const x = 1',
  '-const y = 2',
  '+const y = 3',
  '+const z = 4',
].join('\n')

const validGitDiff = [
  'diff --git a/src/file.ts b/src/file.ts',
  'index 1111111..2222222 100644',
  '--- a/src/file.ts',
  '+++ b/src/file.ts',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new',
].join('\n')

const validUnifiedDiffWithMetadata = [
  'Patch metadata line',
  '--- old.txt',
  '+++ new.txt',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new',
].join('\n')

const numberedHunkWithoutHeaders = [
  '@@ -10,1 +10,2 @@ functionName',
  '-old',
  '+new',
  '+another',
].join('\n')

const bareBodyWithoutHeaders = [
  ' const keep',
  '-old',
  '+new',
].join('\n')

const userBareHunksWithHeaders = [
  '--- a/editor/src/browse-sync/store/browse-store.ts',
  '+++ b/editor/src/browse-sync/store/browse-store.ts',
  '@@',
  ' import { produce } from "immer";',
  '+import Monitoring from "@craft-internal/baseapp/src/Monitoring";',
  '@@',
  '-import { CACHE_STALE_THRESHOLD_MS, QUEUE_MAX_SIZE } from "../constants";',
  '+import { ... } from "../constants";',
].join('\n')

const bodyLinesStartingWithHeaderPrefixes = [
  '--- a/file.md',
  '+++ b/file.md',
  '@@',
  '--- old horizontal rule',
  '+++ new horizontal rule',
  ' context',
].join('\n')

const bareMarkersThatShouldNotLeaveBlankLines = [
  '--- a/file.ts',
  '+++ b/file.ts',
  '@@',
  ' context',
  '@@',
  '+added',
].join('\n')

const mixedValidAndBareHunks = [
  '--- a/file.ts',
  '+++ b/file.ts',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new',
  '@@',
  '+another',
].join('\n')

describe('ensureUnifiedDiffFormat', () => {
  it('returns a valid full unified diff byte-identically', () => {
    expect(ensureUnifiedDiffFormat(validUnifiedDiff)).toBe(validUnifiedDiff)
  })

  it('returns a valid git diff byte-identically', () => {
    expect(ensureUnifiedDiffFormat(validGitDiff)).toBe(validGitDiff)
  })

  it('returns a valid unified diff with leading metadata byte-identically', () => {
    expect(ensureUnifiedDiffFormat(validUnifiedDiffWithMetadata)).toBe(validUnifiedDiffWithMetadata)
  })

  it('prepends file headers to a valid numbered hunk without changing hunk metadata', () => {
    expect(ensureUnifiedDiffFormat(numberedHunkWithoutHeaders)).toBe([
      '--- a/file',
      '+++ b/file',
      numberedHunkWithoutHeaders,
    ].join('\n'))
  })

  it('synthesizes headers and a hunk for bare body lines without headers', () => {
    expect(ensureUnifiedDiffFormat(bareBodyWithoutHeaders)).toBe([
      '--- a/file',
      '+++ b/file',
      '@@ -1,2 +1,2 @@',
      ' const keep',
      '-old',
      '+new',
    ].join('\n'))
  })

  it('preserves user file headers and replaces bare hunk markers with one synthetic hunk', () => {
    expect(ensureUnifiedDiffFormat(userBareHunksWithHeaders)).toBe([
      '--- a/editor/src/browse-sync/store/browse-store.ts',
      '+++ b/editor/src/browse-sync/store/browse-store.ts',
      '@@ -1,2 +1,3 @@',
      ' import { produce } from "immer";',
      '+import Monitoring from "@craft-internal/baseapp/src/Monitoring";',
      '-import { CACHE_STALE_THRESHOLD_MS, QUEUE_MAX_SIZE } from "../constants";',
      '+import { ... } from "../constants";',
    ].join('\n'))
  })

  it('counts body lines beginning with --- and +++ as deletion/addition content', () => {
    expect(ensureUnifiedDiffFormat(bodyLinesStartingWithHeaderPrefixes)).toBe([
      'diff --git a/file.md b/file.md',
      '--- a/file.md',
      '+++ b/file.md',
      '@@ -1,2 +1,2 @@',
      '--- old horizontal rule',
      '+++ new horizontal rule',
      ' context',
    ].join('\n'))
  })

  it('strips bare hunk markers without leaving blank context lines', () => {
    const normalized = ensureUnifiedDiffFormat(bareMarkersThatShouldNotLeaveBlankLines)

    expect(normalized).toBe([
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,1 +1,2 @@',
      ' context',
      '+added',
    ].join('\n'))
    expect(normalized).not.toContain('\n\n')
  })

  it('collapses mixed valid and bare hunk markers into one synthetic hunk', () => {
    expect(ensureUnifiedDiffFormat(mixedValidAndBareHunks)).toBe([
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,1 +1,2 @@',
      '-old',
      '+new',
      '+another',
    ].join('\n'))
  })

  it('produces output accepted by @pierre/diffs for normalized single-file cases', () => {
    const inputs = [
      validUnifiedDiff,
      validGitDiff,
      validUnifiedDiffWithMetadata,
      numberedHunkWithoutHeaders,
      bareBodyWithoutHeaders,
      userBareHunksWithHeaders,
      bodyLinesStartingWithHeaderPrefixes,
      bareMarkersThatShouldNotLeaveBlankLines,
      mixedValidAndBareHunks,
    ]

    for (const input of inputs) {
      expect(() => getSingularPatch(ensureUnifiedDiffFormat(input))).not.toThrow()
    }
  })
})
