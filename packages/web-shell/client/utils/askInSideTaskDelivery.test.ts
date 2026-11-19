import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerAskInSideTaskInsert,
  requestAskInSideTaskQuote,
  resetAskInSideTaskDeliveryForTests,
} from './askInSideTaskDelivery';

afterEach(() => {
  resetAskInSideTaskDeliveryForTests();
  vi.restoreAllMocks();
});

describe('ask in side task delivery', () => {
  it('settles when the composer registers before the quote is requested', () => {
    const insert = vi.fn();
    registerAskInSideTaskInsert('session-a', insert);
    expect(insert).not.toHaveBeenCalled();
    requestAskInSideTaskQuote('session-a', 'quoted text');
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith('quoted text');
  });

  it('settles when the quote is requested before the composer registers', () => {
    requestAskInSideTaskQuote('session-a', 'quoted text');
    const insert = vi.fn();
    registerAskInSideTaskInsert('session-a', insert);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith('quoted text');
  });

  it('delivers a requested session once, even if the pane remounts', () => {
    requestAskInSideTaskQuote('session-a', 'quoted text');
    const firstMount = vi.fn();
    registerAskInSideTaskInsert('session-a', firstMount);
    const remount = vi.fn();
    registerAskInSideTaskInsert('session-a', remount);
    expect(firstMount).toHaveBeenCalledTimes(1);
    expect(remount).not.toHaveBeenCalled();
    requestAskInSideTaskQuote('session-a', 'again');
    expect(firstMount).toHaveBeenCalledTimes(1);
    expect(remount).not.toHaveBeenCalled();
  });

  it('delivers a registered session once across quote re-requests', () => {
    const insert = vi.fn();
    registerAskInSideTaskInsert('session-a', insert);
    requestAskInSideTaskQuote('session-a', 'quoted text');
    requestAskInSideTaskQuote('session-a', 'again');
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith('quoted text');
  });

  it('ignores empty session ids on both sides', () => {
    const insert = vi.fn();
    registerAskInSideTaskInsert('', insert);
    requestAskInSideTaskQuote('', 'ignored');
    registerAskInSideTaskInsert('session-a', insert);
    expect(insert).not.toHaveBeenCalled();
    requestAskInSideTaskQuote('session-a', 'quoted text');
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith('quoted text');
  });

  it('keeps sessions independent', () => {
    const insertA = vi.fn();
    const insertB = vi.fn();
    registerAskInSideTaskInsert('session-a', insertA);
    registerAskInSideTaskInsert('session-b', insertB);
    requestAskInSideTaskQuote('session-a', 'first');
    expect(insertA).toHaveBeenCalledTimes(1);
    expect(insertA).toHaveBeenCalledWith('first');
    expect(insertB).not.toHaveBeenCalled();
    requestAskInSideTaskQuote('session-b', 'second');
    expect(insertB).toHaveBeenCalledTimes(1);
    expect(insertB).toHaveBeenCalledWith('second');
  });
});
