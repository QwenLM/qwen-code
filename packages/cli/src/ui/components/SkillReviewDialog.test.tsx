/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render as inkRender } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { useSettings } from '../contexts/SettingsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useLaunchEditor } from '../hooks/useLaunchEditor.js';
import type { Key } from '../hooks/useKeypress.js';

interface CapturedRadio {
  items?: Array<{ value: string; label: string }>;
  onSelect?: (value: string) => void;
}
const captured: CapturedRadio = {};

// Mock RadioButtonSelect to capture its props so we can drive selections
// directly without simulating keyboard input.
vi.mock('./shared/RadioButtonSelect.js', () => ({
  RadioButtonSelect: (props: {
    items: Array<{ value: string; label: string }>;
    onSelect: (value: string) => void;
  }) => {
    captured.items = props.items;
    captured.onSelect = props.onSelect;
    return null;
  },
}));

// Capture the keypress handler so tests can drive `o` / `t` / Esc directly.
let keyHandler: ((key: Key) => void) | undefined;
vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: (handler: (key: Key) => void) => {
    keyHandler = handler;
  },
}));

vi.mock('../contexts/SettingsContext.js', () => ({
  useSettings: vi.fn(),
}));

vi.mock('../contexts/ConfigContext.js', () => ({
  useConfig: vi.fn(),
}));

vi.mock('../hooks/useLaunchEditor.js', () => ({
  useLaunchEditor: vi.fn(),
}));

const mockedUseSettings = vi.mocked(useSettings);
const mockedUseConfig = vi.mocked(useConfig);
const mockedUseLaunchEditor = vi.mocked(useLaunchEditor);

import { SkillReviewDialog } from './SkillReviewDialog.js';
import type { SkillReviewDialogProps } from './SkillReviewDialog.js';

// Track every render so afterEach can unmount it. The dialog installs a
// process.stdout resize listener via useTerminalSize on mount; without
// unmounting, repeated renders leak listeners (MaxListenersExceededWarning).
const renderInstances: Array<ReturnType<typeof inkRender>> = [];
function render(tree: Parameters<typeof inkRender>[0]) {
  const instance = inkRender(tree);
  renderInstances.push(instance);
  return instance;
}

function pressKey(name: string, extra: Partial<Key> = {}) {
  keyHandler?.({
    name,
    ctrl: false,
    meta: false,
    shift: false,
    paste: false,
    sequence: name,
    ...extra,
  } as Key);
}

describe('SkillReviewDialog', () => {
  let tempDir: string;
  let setValue: ReturnType<typeof vi.fn>;
  let setAutoSkillEnabled: ReturnType<typeof vi.fn>;
  let launchEditor: ReturnType<typeof vi.fn>;
  let skills: Array<{
    name: string;
    description: string;
    stagedManifestPath: string;
  }>;

  beforeEach(async () => {
    captured.items = undefined;
    captured.onSelect = undefined;
    keyHandler = undefined;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-review-'));
    const alphaPath = await writeSkill(
      'auto-skill-alpha',
      '---\nname: auto-skill-alpha\ndescription: does alpha\n---\nALPHA_BODY_MARKER steps here.\n',
    );
    const betaPath = await writeSkill(
      'auto-skill-beta',
      '---\nname: auto-skill-beta\ndescription: does beta\n---\nBETA_BODY_MARKER steps here.\n',
    );
    skills = [
      {
        name: 'auto-skill-alpha',
        description: 'does alpha',
        stagedManifestPath: alphaPath,
      },
      {
        name: 'auto-skill-beta',
        description: 'does beta',
        stagedManifestPath: betaPath,
      },
    ];

    setValue = vi.fn();
    mockedUseSettings.mockReturnValue({
      setValue,
      merged: { memory: { enableAutoSkill: true } },
    } as never);
    setAutoSkillEnabled = vi.fn();
    mockedUseConfig.mockReturnValue({ setAutoSkillEnabled } as never);
    launchEditor = vi.fn().mockResolvedValue(undefined);
    mockedUseLaunchEditor.mockReturnValue(launchEditor);
  });

  afterEach(async () => {
    for (const instance of renderInstances) instance.unmount();
    renderInstances.length = 0;
    vi.clearAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Write a staged SKILL.md under tempDir and return its absolute path. */
  async function writeSkill(dirName: string, content: string): Promise<string> {
    const skillPath = path.join(tempDir, dirName, 'SKILL.md');
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, content);
    return skillPath;
  }

  /** Render the dialog with every callback defaulted to a fresh spy. */
  function renderDialog(
    skillsArg: SkillReviewDialogProps['skills'],
    overrides: Partial<SkillReviewDialogProps> = {},
  ) {
    return render(
      <SkillReviewDialog
        skills={skillsArg}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        onDismiss={vi.fn()}
        {...overrides}
      />,
    );
  }

  /** Write a single staged skill and render a one-skill dialog over it. */
  async function renderPreviewSkill(dirName: string, content: string) {
    const stagedManifestPath = await writeSkill(dirName, content);
    return renderDialog([
      { name: dirName, description: '', stagedManifestPath },
    ]);
  }

  it('renders the first pending skill name and description with a counter', () => {
    const { lastFrame } = renderDialog(skills);
    expect(lastFrame()).toContain('auto-skill-alpha');
    expect(lastFrame()).toContain('does alpha');
    expect(lastFrame()).toContain('1/2');
  });

  it('offers keep / discard / bulk / turn-off options while several remain', () => {
    renderDialog(skills);
    const values = (captured.items ?? []).map((i) => i.value);
    expect(values).toEqual([
      'keep',
      'discard',
      'keepAll',
      'discardAll',
      'turnOff',
    ]);
  });

  it('hides the bulk options for a single-skill batch (they would duplicate keep/discard)', () => {
    renderDialog([skills[0]!]);
    const values = (captured.items ?? []).map((i) => i.value);
    expect(values).toEqual(['keep', 'discard', 'turnOff']);
  });

  it('hides the bulk options once only the last skill of a batch remains', async () => {
    renderDialog(skills);
    // Advance from skill 1/2 to the final skill 2/2, then wait for the
    // re-render to reach the mocked RadioButtonSelect.
    captured.onSelect!('keep');
    await vi.waitFor(() => {
      const values = (captured.items ?? []).map((i) => i.value);
      expect(values).toEqual(['keep', 'discard', 'turnOff']);
    });
  });

  it('keep accepts the current skill and does NOT close while more remain', () => {
    const onAccept = vi.fn();
    const onClose = vi.fn();
    renderDialog(skills, { onAccept, onClose });
    captured.onSelect!('keep');
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith('auto-skill-alpha');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keep on the last remaining skill closes the dialog', () => {
    const onAccept = vi.fn();
    const onClose = vi.fn();
    renderDialog([skills[0]!], { onAccept, onClose });
    captured.onSelect!('keep');
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith('auto-skill-alpha');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keepAll accepts every remaining skill then closes once', () => {
    const onAccept = vi.fn();
    const onClose = vi.fn();
    renderDialog(skills, { onAccept, onClose });
    captured.onSelect!('keepAll');
    expect(onAccept).toHaveBeenCalledTimes(2);
    expect(onAccept).toHaveBeenCalledWith('auto-skill-alpha');
    expect(onAccept).toHaveBeenCalledWith('auto-skill-beta');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('discardAll rejects every remaining skill then closes once', () => {
    const onReject = vi.fn();
    const onClose = vi.fn();
    renderDialog(skills, { onReject, onClose });
    captured.onSelect!('discardAll');
    expect(onReject).toHaveBeenCalledTimes(2);
    expect(onReject).toHaveBeenCalledWith('auto-skill-alpha');
    expect(onReject).toHaveBeenCalledWith('auto-skill-beta');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing and closes when there are no skills', async () => {
    const onClose = vi.fn();
    const { lastFrame } = renderDialog([], { onClose });
    expect(lastFrame()).toBe('');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  // ─── New: inline preview ──────────────────────────────────────────────────

  it('renders the current staged SKILL.md content inline', async () => {
    const { lastFrame } = renderDialog(skills);
    await vi.waitFor(() => expect(lastFrame()).toContain('ALPHA_BODY_MARKER'));
  });

  it('shows a fallback when the staged file cannot be read', async () => {
    const { lastFrame } = renderDialog([
      {
        name: 'auto-skill-gone',
        description: 'missing',
        stagedManifestPath: path.join(tempDir, 'nope', 'SKILL.md'),
      },
    ]);
    await vi.waitFor(() =>
      expect(lastFrame()).toContain('Preview unavailable'),
    );
  });

  it('shows loading, not the previous skill body, while the next preview loads', async () => {
    // Gate skill B's read behind a deferred promise so the window between
    // advancing and B's read resolving is reliably observable.
    let releaseBeta!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBeta = resolve;
    });
    const realOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      if (String(args[0]).includes('auto-skill-beta')) await gate;
      return realOpen(...args);
    }) as unknown as typeof fs.open);

    try {
      const { lastFrame } = renderDialog(skills);
      await vi.waitFor(() =>
        expect(lastFrame()).toContain('ALPHA_BODY_MARKER'),
      );
      // Keep skill A → advance to skill B while B's read is still gated.
      captured.onSelect!('keep');
      await vi.waitFor(() => expect(lastFrame()).toContain('2/2'));
      // Skill B's header must not be rendered over skill A's stale body.
      expect(lastFrame()).not.toContain('ALPHA_BODY_MARKER');
      expect(lastFrame()).toContain('Loading preview');
      releaseBeta();
      await vi.waitFor(() => expect(lastFrame()).toContain('BETA_BODY_MARKER'));
    } finally {
      openSpy.mockRestore();
    }
  });

  it('neutralizes ANSI/VT control sequences in the preview', async () => {
    const escPath = path.join(tempDir, 'auto-skill-esc', 'SKILL.md');
    await fs.mkdir(path.dirname(escPath), { recursive: true });
    // Body contains a raw clear-screen (ESC [ 2 J) — a model-generated file
    // could smuggle this in to wipe the terminal.
    await fs.writeFile(escPath, '---\nname: x\n---\nCTRL_\u001b[2Jclear\n');
    const { lastFrame } = renderDialog([
      { name: 'auto-skill-esc', description: '', stagedManifestPath: escPath },
    ]);
    await vi.waitFor(() => expect(lastFrame()).toContain('CTRL_'));
    // The raw clear-screen escape must not reach the terminal...
    expect(lastFrame()).not.toContain('\u001b[2J');
    // ...it is rendered as inert, escaped text instead.
    expect(lastFrame()).toContain('u001b[2J');
  });

  it('escapes bare control bytes (e.g. BEL) that are not ANSI sequences', async () => {
    // BEL (0x07) is a bare C0 byte, not an ANSI escape sequence, so ansi-regex
    // does not catch it — the preview sanitizer must handle it separately.
    const { lastFrame } = await renderPreviewSkill(
      'auto-skill-bel',
      `---\nname: x\n---\nBODY_${String.fromCharCode(7)}END\n`,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('BODY_'));
    // The raw BEL byte must not reach the terminal...
    expect(lastFrame()).not.toContain(String.fromCharCode(7));
    // ...it is rendered as inert, escaped text instead.
    expect(lastFrame()).toContain('u0007');
  });

  it('escapes DEL and C1 control bytes (JSON.stringify leaves these raw)', async () => {
    // 0x9B is the 8-bit CSI (behaves like ESC[) and 0x7F is DEL. JSON.stringify
    // returns both unchanged, so they need an explicit code-point escape.
    const { lastFrame } = await renderPreviewSkill(
      'auto-skill-c1',
      `---\nname: x\n---\nC1_${String.fromCharCode(0x9b)}${String.fromCharCode(0x7f)}END\n`,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('C1_'));
    // Neither the 8-bit CSI nor DEL may reach the terminal raw...
    expect(lastFrame()).not.toContain(String.fromCharCode(0x9b));
    expect(lastFrame()).not.toContain(String.fromCharCode(0x7f));
    // ...both render as inert, escaped text.
    expect(lastFrame()).toContain('u009b');
    expect(lastFrame()).toContain('u007f');
  });

  it('sanitizes the model-generated name and description in the header', async () => {
    // The header fields come from the same model-generated source as the
    // preview body (directory basename / frontmatter) — an escape smuggled
    // there must not bypass the sanitizer just because it is not in the body.
    const stagedManifestPath = await writeSkill(
      'auto-skill-header',
      '---\nname: x\n---\nHEADER_BODY\n',
    );
    const { lastFrame } = renderDialog([
      {
        name: 'evil-\u001b[2Jname',
        description: `desc_${String.fromCharCode(7)}end`,
        stagedManifestPath,
      },
    ]);
    await vi.waitFor(() => expect(lastFrame()).toContain('HEADER_BODY'));
    // Raw escape/control bytes must not reach the terminal...
    expect(lastFrame()).not.toContain('\u001b[2J');
    expect(lastFrame()).not.toContain(String.fromCharCode(7));
    // ...they render as inert, escaped text, same as the preview body.
    expect(lastFrame()).toContain('u001b[2J');
    expect(lastFrame()).toContain('u0007');
  });

  it('renders CRLF line endings as ordinary line breaks, not CR escapes', async () => {
    // Windows-authored / editor-saved file: every line ends with \r\n.
    const { lastFrame } = await renderPreviewSkill(
      'auto-skill-crlf',
      ['---', 'name: x', '---', 'CRLF_LINE_ONE', 'CRLF_LINE_TWO', ''].join(
        '\r\n',
      ),
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('CRLF_LINE_TWO'));
    // Both lines render, with no visible CR escape anywhere.
    expect(lastFrame()).toContain('CRLF_LINE_ONE');
    expect(lastFrame()).not.toContain('\\r');
  });

  it('still escapes a lone CR that is not part of a CRLF pair', async () => {
    // A bare CR mid-line can rewrite the current row — must stay escaped
    // (rendered as the mnemonic `\r`).
    const { lastFrame } = await renderPreviewSkill(
      'auto-skill-cr',
      '---\nname: x\n---\nLONE_\rMID\n',
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('LONE_'));
    expect(lastFrame()).toContain('\\r');
  });

  it('reads only a bounded chunk of a huge preview file (no unbounded read)', async () => {
    // > 64 KiB so an unbounded read/render would process the whole file.
    const body = Array.from({ length: 20000 }, (_, i) => `LINE_${i}`).join(
      '\n',
    );
    const bigPath = await writeSkill(
      'auto-skill-big',
      `---\nname: big\n---\n${body}\n`,
    );

    // Spy on the bounded read: the component must fs.open + read a capped chunk
    // rather than fs.readFile the whole file. Without the cap, fs.open is never
    // called (so openCalls stays 0 and this test fails).
    let openCalls = 0;
    let maxReadLength = 0;
    const realOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      openCalls++;
      const handle = await realOpen(...args);
      const realRead = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(((...rargs: unknown[]) => {
        if (typeof rargs[2] === 'number') {
          maxReadLength = Math.max(maxReadLength, rargs[2]);
        }
        return (realRead as (...a: unknown[]) => unknown)(...rargs);
      }) as never);
      return handle;
    }) as unknown as typeof fs.open);

    try {
      const { lastFrame } = renderDialog([
        {
          name: 'auto-skill-big',
          description: '',
          stagedManifestPath: bigPath,
        },
      ]);
      await vi.waitFor(() => expect(lastFrame()).toContain('LINE_0'));

      // Bounded-read path was taken and never asked for more than the cap
      // (+1 byte is read only to detect truncation).
      expect(openCalls).toBeGreaterThan(0);
      expect(maxReadLength).toBeGreaterThan(0);
      expect(maxReadLength).toBeLessThanOrEqual(64 * 1024 + 1);
      // Far-down lines are never rendered; the omission is surfaced.
      expect(lastFrame()).not.toContain('LINE_400');
      expect(lastFrame()).toMatch(/lines hidden/);
    } finally {
      openSpy.mockRestore();
    }
  });

  it('caps the preview by WRAPPED rows, not logical lines', async () => {
    // One huge logical line and one trailer. Without explicit wrap-aware
    // layout, MaxSizedBox counts 2 rows ("fits") while Ink wraps the long line
    // into dozens of rendered rows, bypassing PREVIEW_MAX_HEIGHT entirely and
    // pushing the options/footer down on small terminals.
    const { lastFrame } = await renderPreviewSkill(
      'auto-skill-wide',
      `---\nname: wide\n---\n${'WIDE_ROW '.repeat(300)}\nTRAILER_LINE\n`,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('WIDE_ROW'));
    const frame = lastFrame()!;
    // The wrapped rows shown never exceed the cap (one row is reserved for
    // the hidden-lines marker)...
    const wideRows = frame
      .split('\n')
      .filter((l) => l.includes('WIDE_ROW')).length;
    expect(wideRows).toBeLessThanOrEqual(11);
    // ...the overflow is surfaced, and the trailer (a hidden wrapped row) is
    // not rendered.
    expect(frame).toMatch(/lines hidden/);
    expect(frame).not.toContain('TRAILER_LINE');
    // The footer below the capped preview stays rendered (RadioButtonSelect
    // is mocked to null here, so assert on the real footer text instead).
    expect(frame).toContain('open in editor');
  });

  it('flags a byte-truncated preview even when no lines are hidden', async () => {
    // A few short lines followed by a large trailing blob pushes the file past
    // the 64 KiB read cap. The trailing newlines are stripped, so the visible
    // lines fit with NO line-hidden marker — only the explicit truncation
    // marker signals that content past the cap was dropped.
    const content = `SHORT_1\nSHORT_2\nSHORT_3\n${'\n'.repeat(70 * 1024)}`;
    const { lastFrame } = await renderPreviewSkill(
      'auto-skill-trunc',
      `---\nname: trunc\n---\n${content}`,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('SHORT_1'));
    const frame = lastFrame()!;
    // No line-hidden marker (the short lines fit)...
    expect(frame).not.toMatch(/lines hidden/);
    // ...but the byte-truncation is surfaced explicitly.
    expect(frame).toMatch(/truncated/i);
  });

  // ─── New: open in editor (`o`) ────────────────────────────────────────────

  it('`o` opens the current skill in the editor', async () => {
    renderDialog(skills);
    pressKey('o');
    await vi.waitFor(() => expect(launchEditor).toHaveBeenCalledTimes(1));
    expect(launchEditor).toHaveBeenCalledWith(skills[0]!.stagedManifestPath);
  });

  it('Ctrl+O and Cmd+O do not launch the editor', () => {
    renderDialog(skills);
    pressKey('o', { ctrl: true });
    pressKey('o', { meta: true });
    expect(launchEditor).not.toHaveBeenCalled();
  });

  it('Esc dismisses the dialog (decide later)', () => {
    const onDismiss = vi.fn();
    renderDialog(skills, { onDismiss });
    pressKey('escape');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('refreshes the preview with the saved edits after the editor closes', async () => {
    const editedPath = skills[0]!.stagedManifestPath;
    // Simulate the user editing and saving the file inside the editor.
    launchEditor.mockImplementationOnce(async (p: string) => {
      await fs.writeFile(
        p,
        '---\nname: auto-skill-alpha\n---\nEDITED_BODY_MARKER after save.\n',
      );
    });
    const { lastFrame } = renderDialog(skills);
    await vi.waitFor(() => expect(lastFrame()).toContain('ALPHA_BODY_MARKER'));
    pressKey('o');
    await vi.waitFor(() =>
      expect(launchEditor).toHaveBeenCalledWith(editedPath),
    );
    // Preview reloads with the saved contents...
    await vi.waitFor(() => expect(lastFrame()).toContain('EDITED_BODY_MARKER'));
    // ...and the pre-edit content is gone.
    expect(lastFrame()).not.toContain('ALPHA_BODY_MARKER');
  });

  it('auto-refreshes the preview when the staged file changes on disk', async () => {
    // A non-blocking GUI editor (macOS default `open -t`) resolves the launch
    // before the user saves, so the preview must pick up later saves via the
    // file watcher — no `o` keypress involved here at all.
    const { lastFrame } = renderDialog(skills);
    await vi.waitFor(() => expect(lastFrame()).toContain('ALPHA_BODY_MARKER'));
    await fs.writeFile(
      skills[0]!.stagedManifestPath,
      '---\nname: auto-skill-alpha\n---\nWATCHED_BODY_MARKER saved later.\n',
    );
    await vi.waitFor(
      () => expect(lastFrame()).toContain('WATCHED_BODY_MARKER'),
      { timeout: 5000 },
    );
    expect(lastFrame()).not.toContain('ALPHA_BODY_MARKER');
  });

  it('`o` does not advance, accept, reject, or close', async () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const onClose = vi.fn();
    const { lastFrame } = renderDialog(skills, { onAccept, onReject, onClose });
    pressKey('o');
    await vi.waitFor(() => expect(launchEditor).toHaveBeenCalled());
    expect(onAccept).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // Still on the first skill.
    expect(lastFrame()).toContain('1/2');
  });

  it('clears a stale editor error when advancing to the next skill', async () => {
    launchEditor.mockRejectedValueOnce(new Error('EDITOR_BOOM'));
    const { lastFrame } = renderDialog(skills);
    // Editor launch fails on the current skill → error is shown.
    pressKey('o');
    await vi.waitFor(() => expect(lastFrame()).toContain('EDITOR_BOOM'));
    // Keep advances to the next skill; the stale error must not carry over.
    captured.onSelect!('keep');
    await vi.waitFor(() => expect(lastFrame()).not.toContain('EDITOR_BOOM'));
  });

  // ─── New: turn off (`t`) ──────────────────────────────────────────────────

  it('selecting turn-off disables auto-skill and closes without rejecting or dismissing', () => {
    const onReject = vi.fn();
    const onClose = vi.fn();
    const onDismiss = vi.fn();
    renderDialog(skills, { onReject, onClose, onDismiss });
    captured.onSelect!('turnOff');
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'memory.enableAutoSkill',
      false,
    );
    // Also disabled for the live session, not just persisted for next launch.
    expect(setAutoSkillEnabled).toHaveBeenCalledWith(false);
    // Closes via onClose, NOT onDismiss: dismissing would blacklist the batch
    // for the whole session, so re-enabling auto-skill from /memory could
    // never reopen it. The parent's auto-open is gated on the live flag.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and the feature untouched when persisting turn-off fails', async () => {
    // saveSettings re-throws write failures (read-only workspace, ENOSPC);
    // the throw must not escape the keypress handler, and a half-applied
    // turn-off (live flag off, setting still on) must not be left behind.
    setValue.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    const onClose = vi.fn();
    const onDismiss = vi.fn();
    const { lastFrame } = renderDialog(skills, { onClose, onDismiss });
    captured.onSelect!('turnOff');
    // The failure is surfaced in the dialog so the user can retry or move on.
    await vi.waitFor(() =>
      expect(lastFrame()).toContain('Failed to save setting'),
    );
    expect(lastFrame()).toContain('EACCES');
    expect(setAutoSkillEnabled).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('the retired `t` hotkey is inert', () => {
    const onClose = vi.fn();
    const onDismiss = vi.fn();
    renderDialog(skills, { onClose, onDismiss });
    pressKey('t');
    expect(setValue).not.toHaveBeenCalled();
    expect(setAutoSkillEnabled).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  // ─── New: footer hints ────────────────────────────────────────────────────

  it('footer surfaces open-in-editor and Esc; turn-off lives in the option list', () => {
    const { lastFrame } = renderDialog(skills);
    const frame = lastFrame();
    expect(frame).toContain('open in editor');
    expect(frame).toContain('Esc decide later');
    // Turn-off moved from a footer hotkey hint into a visible selector option
    // (always last). RadioButtonSelect is mocked, so assert on its items.
    expect(frame).not.toContain('turn off');
    const labels = (captured.items ?? []).map((i) => i.label);
    expect(labels[labels.length - 1]).toBe('Turn off auto-generated skills');
  });
});
