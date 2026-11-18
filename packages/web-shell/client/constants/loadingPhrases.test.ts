import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLoadingPhrases } from './loadingPhrases';

describe('getLoadingPhrases', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    'zh-TW',
    'zh-tw',
    'zh_TW',
    'zh-Hant',
    'zh-HK',
    'zh-MO',
    'zh-TW-x-lc',
  ])('serves the Traditional quips for %s', (language) => {
    expect(getLoadingPhrases(language)[0]).toBe('正在努力搬磚，請稍候...');
  });

  it('keeps the Simplified and English tables reachable', () => {
    expect(getLoadingPhrases('zh-CN')[0]).toBe('正在努力搬砖，请稍候...');
    expect(getLoadingPhrases('zh')[0]).toBe('正在努力搬砖，请稍候...');
    expect(getLoadingPhrases('zh-Hans-CN')[0]).toBe('正在努力搬砖，请稍候...');
    expect(getLoadingPhrases('en')[0]).toBe("I'm Feeling Lucky");
  });

  it('reads the navigator language when no argument is given', () => {
    vi.stubGlobal('navigator', { language: 'zh_TW' });
    expect(getLoadingPhrases()[0]).toBe('正在努力搬磚，請稍候...');
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(getLoadingPhrases()[0]).toBe("I'm Feeling Lucky");
  });
});
