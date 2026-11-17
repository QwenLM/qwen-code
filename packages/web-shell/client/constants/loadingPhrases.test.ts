import { describe, expect, it } from 'vitest';
import { getLoadingPhrases } from './loadingPhrases';

describe('getLoadingPhrases', () => {
  it.each(['zh-TW', 'zh-tw', 'zh-Hant', 'zh-HK', 'zh-MO', 'zh-TW-x-lc'])(
    'serves the Traditional quips for %s',
    (language) => {
      expect(getLoadingPhrases(language)[0]).toBe('正在努力搬磚，請稍候...');
    },
  );

  it('keeps the Simplified and English tables reachable', () => {
    expect(getLoadingPhrases('zh-CN')[0]).toBe('正在努力搬砖，请稍候...');
    expect(getLoadingPhrases('zh')[0]).toBe('正在努力搬砖，请稍候...');
    expect(getLoadingPhrases('en')[0]).toBe("I'm Feeling Lucky");
    expect(getLoadingPhrases()[0]).toBe("I'm Feeling Lucky");
  });
});
