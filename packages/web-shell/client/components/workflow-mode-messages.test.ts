import { describe, expect, it } from 'vitest';
import { getWorkflowModeMessages } from './workflow-mode-messages';

// Curated: 析/表/置/系 and friends are shared with Traditional, so a naive
// Simplified block would red on correct zh-TW copy.
const SIMPLIFIED_ONLY_GLYPHS =
  /[这会说时门问为从图对总报无数认让过还进运选项页态码编辑删确认复载链试变]/;

describe('workflow mode copy', () => {
  it('reads the zh-TW table, and every entry in it is Traditional', () => {
    const tw = getWorkflowModeMessages('zh-TW');
    expect(tw.details).toBe('Workflow 模式詳情');
    expect(tw.short.unbound).toBe('需要先有會話');
    expect(tw.nextTurn).toContain('不會中斷當前輪次');
    for (const value of Object.values(tw)) {
      for (const text of typeof value === 'string'
        ? [value]
        : Object.values(value)) {
        expect(text).not.toMatch(SIMPLIFIED_ONLY_GLYPHS);
      }
    }
  });
});
