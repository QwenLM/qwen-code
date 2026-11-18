import { describe, expect, it } from 'vitest';
import { getWorkflowModeMessages } from './workflow-mode-messages';
import { SIMPLIFIED_ONLY_GLYPHS } from '../test/zh-tw-glyphs';

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
