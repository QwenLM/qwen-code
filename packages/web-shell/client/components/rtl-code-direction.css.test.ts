import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

// jsdom computes no CSS cascade, so pin the stylesheet source instead. These
// surfaces render LTR-indexed code — terminal output, unified-diff rows and
// the minigame board — and must not inherit the Arabic shell's RTL direction:
// RTL would right-align output and reorder it through bidi, swap the diff
// lineNo/marker/content columns, and mirror the game grid against its arrow
// keys. Each rule below carries an explicit `direction: ltr`; dropping it
// reopens the corresponding RTL defect with no other test signal.
const LTR_CODE_SURFACES: Array<[string, string]> = [
  ['./WaitingMinigame.module.css', '.cells'],
  ['./messages/UserShellMessage.module.css', '.output'],
  ['./messages/UserShellMessage.module.css', '.command'],
  ['./messages/PlanExecutionView.module.css', '.dagCanvas'],
  ['./messages/tools/DiffView.module.css', '.line'],
  ['./messages/TasksStatusMessage.module.css', '.shellOutput'],
  ['./messages/TasksStatusMessage.module.css', '.monitorCommand'],
  ['./messages/ToolApproval.module.css', '.codeBlock'],
  ['./dialogs/GitDiffDialog.module.css', '.diffLine'],
  [
    './artifacts/ArtifactPanel.module.css',
    '.codeMirrorDiff :global(.cm-editor)',
  ],
  [
    './artifacts/ArtifactPanel.module.css',
    '.codeMirrorFile :global(.cm-editor)',
  ],
];

// A machine value rendered through a class that ALSO renders localized copy
// carries the pin as a `dir="ltr"` attribute on that one render instead of in
// the stylesheet: a class-level pin would force LTR onto the Arabic
// placeholders sharing it. Each entry names the file, the element, a marker
// identifying the render, and how many such renders must carry the pin — so
// pinning a localized sibling fails here too.
const LTR_MACHINE_RENDERS: Array<[string, string, string, number]> = [
  ['./messages/TasksStatusMessage.tsx', 'div', 'shellFieldValue', 2],
  ['./messages/MemoryMessage.tsx', 'div', 'detailPath', 1],
  ['./messages/ModelManagementSection.tsx', 'bdi', 'modelId', 1],
  ['./messages/ModelManagementSection.tsx', 'bdi', 'modelBaseUrl', 1],
  ['./messages/tools/ShellToolOutput.tsx', 'pre', 'shellFailure', 1],
  ['./messages/tools/ShellToolOutput.tsx', 'pre', 'shellOutput', 2],
  ['./DesktopRelayControl.tsx', 'code', 'font-mono', 2],
  ['./workspace-agents/add-runtime-dialog.tsx', 'code', 'font-mono', 1],
  ['./workspace-agents/share-agent-dialog.tsx', 'code', 'font-mono', 1],
  ['./sidebar/WorkspaceDetailsTooltip.tsx', 'span', 'sessionDetailsPath', 1],
  ['./sidebar/WorkspaceDetailsTooltip.tsx', 'span', 'title={branch', 1],
  ['./StandaloneAuth.tsx', 'CardDescription', 'font-mono', 1],
  ['./StandaloneAuth.tsx', 'Input', 'id="daemon-address"', 1],
  ['./StandaloneAuth.tsx', 'Input', 'id="daemon-bearer-token"', 1],
];

function directions(file: string, selector: string): string[] {
  const css = readFileSync(
    fileURLToPath(new URL(file, import.meta.url)),
    'utf8',
  );
  const found: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (!rule.selectors.some((s) => s.trim() === selector)) return;
    rule.walkDecls('direction', (decl) => found.push(decl.value));
  });
  return found;
}

// Opening tags are matched up to their first `>`; an attribute expression
// containing `=>` truncates the match, which is harmless because the marker
// and the pin both precede any handler in the renders listed above.
function pinnedRenders(file: string, tag: string, marker: string): number {
  const src = readFileSync(
    fileURLToPath(new URL(file, import.meta.url)),
    'utf8',
  );
  const openings = src.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? [];
  return openings.filter(
    (opening) => opening.includes(marker) && opening.includes('dir="ltr"'),
  ).length;
}

describe('RTL shell keeps code surfaces LTR', () => {
  it.each(LTR_CODE_SURFACES)(
    '%s pins %s to direction: ltr',
    (file, selector) => {
      expect(directions(file, selector)).toContain('ltr');
    },
  );

  // The shared output classes also render localized placeholders, quota
  // notices and arbitrary tool text, so their machine-output renders carry the
  // pin as `dir` attributes instead: the ShellToolOutput command/notices pres
  // above, its output pre and the ToolGroup result rows conditionally (pinned
  // by the DOM tests in ShellToolOutput.test.tsx and ToolGroup.test.tsx). The
  // payload pre resolves direction from its own content, so Latin output stays
  // LTR without forcing Arabic prose into an LTR paragraph.
  it('leaves the shared output classes to the shell direction', () => {
    expect(
      directions('./messages/tools/ToolChrome.module.css', '.expandedOutput'),
    ).toEqual([]);
    expect(
      directions('./messages/tools/ToolChrome.module.css', '.lineOutput'),
    ).toEqual([]);
    expect(
      directions('./messages/tools/ToolChrome.module.css', '.shellOutput'),
    ).toEqual([]);
    expect(
      directions('./messages/tools/ToolChrome.module.css', '.payloadText'),
    ).toEqual([]);
  });

  it.each(LTR_MACHINE_RENDERS)(
    '%s pins %s renders marked %s to dir="ltr"',
    (file, tag, marker, count) => {
      expect(pinnedRenders(file, tag, marker)).toBe(count);
    },
  );

  // The sibling localized renders of the same shared classes must stay
  // unpinned, or an Arabic placeholder would be forced LTR.
  it('leaves the localized siblings of the shared machine classes unpinned', () => {
    expect(
      directions(
        './messages/TasksStatusMessage.module.css',
        '.shellFieldValue',
      ),
    ).toEqual([]);
    expect(
      directions('./messages/tools/ToolChrome.module.css', '.shellFailure'),
    ).toEqual([]);
  });
});
