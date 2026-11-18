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
  ['./messages/tools/ToolChrome.module.css', '.lineOutput'],
  ['./messages/tools/ToolChrome.module.css', '.shellOutput'],
  ['./messages/tools/ToolChrome.module.css', '.payloadText'],
  ['./messages/TasksStatusMessage.module.css', '.shellOutput'],
  ['./dialogs/GitDiffDialog.module.css', '.diffLine'],
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

describe('RTL shell keeps code surfaces LTR', () => {
  it.each(LTR_CODE_SURFACES)(
    '%s pins %s to direction: ltr',
    (file, selector) => {
      expect(directions(file, selector)).toContain('ltr');
    },
  );

  // The shared class also renders localized placeholders and the user's own
  // answer, so its machine-output paths carry the pin instead: `.shellOutput`
  // above, and `dir="ltr"` on the read/edit content.
  it('leaves the shared output class to the shell direction', () => {
    expect(
      directions('./messages/tools/ToolChrome.module.css', '.expandedOutput'),
    ).toEqual([]);
  });
});
