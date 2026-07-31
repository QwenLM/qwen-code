/**
 * Tests for BindingStore persistence semantics.
 *
 * Specifically: a failed `save()` must NOT fire the change listener. The
 * listener drives UI events; firing it for writes that never landed on disk
 * causes the UI to show state that disappears on restart.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BindingStore } from './binding-store'

const testRoots: string[] = []

function makeStorageDirWhereWritesFail(): string {
  // Create a plain file at the location we're about to pass as the
  // storageDir. BindingStore's `save()` calls `mkdirSync(dir, {recursive:true})`
  // which fails with ENOTDIR when a parent path element is a regular file.
  const root = join(tmpdir(), `bindstore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  const blockingFile = join(root, 'not-a-dir')
  writeFileSync(blockingFile, 'blocker')
  testRoots.push(root)
  // Pass a path that nests INSIDE the regular file — mkdirSync will throw.
  return join(blockingFile, 'bindings')
}

afterEach(() => {
  for (const r of testRoots) {
    if (existsSync(r)) rmSync(r, { recursive: true, force: true })
  }
  testRoots.length = 0
})

describe('BindingStore.save() failure semantics', () => {
  it('does not fire changeListener when the write fails', () => {
    const storageDir = makeStorageDirWhereWritesFail()
    const store = new BindingStore(storageDir)

    let fired = 0
    store.onChange(() => { fired += 1 })

    // Trigger a save through `bind()`. The write must fail because
    // storageDir cannot be created (ENOTDIR on a path nested under a file).
    store.bind('ws-1', 'sess-1', 'telegram', 'chan-1')

    expect(fired).toBe(0)
  })

  it('fires changeListener when the write succeeds', () => {
    const root = join(tmpdir(), `bindstore-ok-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    testRoots.push(root)
    const store = new BindingStore(root)

    let fired = 0
    store.onChange(() => { fired += 1 })

    store.bind('ws-1', 'sess-1', 'telegram', 'chan-1')

    expect(fired).toBe(1)
  })
})
