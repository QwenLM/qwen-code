// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  readWaitingGamesEnabled,
  WAITING_GAMES_STORAGE_KEY,
} from './waitingGamesConfig';

type WaitingGamesWindow = Window & {
  __QWEN_CODE_WAITING_GAMES__?: boolean;
};

const reset = () => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  delete (window as WaitingGamesWindow).__QWEN_CODE_WAITING_GAMES__;
};

afterEach(reset);

describe('waiting games configuration', () => {
  it('is off by default', () => {
    expect(readWaitingGamesEnabled()).toBe(false);
  });

  it('reads the persisted storage flag', () => {
    window.localStorage.setItem(WAITING_GAMES_STORAGE_KEY, '1');
    expect(readWaitingGamesEnabled()).toBe(true);
    window.localStorage.setItem(WAITING_GAMES_STORAGE_KEY, '0');
    expect(readWaitingGamesEnabled()).toBe(false);
  });

  it('reads the URL flag and lets it override storage', () => {
    window.localStorage.setItem(WAITING_GAMES_STORAGE_KEY, '1');
    window.history.replaceState({}, '', '/?waitingGames=0');
    expect(readWaitingGamesEnabled()).toBe(false);
    window.history.replaceState({}, '', '/?waitingGames=true');
    expect(readWaitingGamesEnabled()).toBe(true);
    window.history.replaceState({}, '', '/?waiting-games=1');
    expect(readWaitingGamesEnabled()).toBe(true);
  });

  it('reads the host-injected global', () => {
    (window as WaitingGamesWindow).__QWEN_CODE_WAITING_GAMES__ = true;
    expect(readWaitingGamesEnabled()).toBe(true);
    (window as WaitingGamesWindow).__QWEN_CODE_WAITING_GAMES__ = false;
    expect(readWaitingGamesEnabled()).toBe(false);
  });
});
