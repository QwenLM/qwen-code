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
  ['./messages/tools/DiffView.module.css', '.line'],
  ['./messages/tools/ToolChrome.module.css', '.lineOutput'],
  ['./messages/tools/ToolChrome.module.css', '.expandedOutput'],
  ['./dialogs/GitDiffDialog.module.css', '.diffLine'],
];

describe('RTL shell keeps code surfaces LTR', () => {
  it.each(LTR_CODE_SURFACES)(
    '%s pins %s to direction: ltr',
    (file, selector) => {
      const css = readFileSync(
        fileURLToPath(new URL(file, import.meta.url)),
        'utf8',
      );
      const directions: string[] = [];
      postcss.parse(css).walkRules((rule) => {
        if (!rule.selectors.some((s) => s.trim() === selector)) return;
        rule.walkDecls('direction', (decl) => directions.push(decl.value));
      });
      expect(directions).toContain('ltr');
    },
  );
});
