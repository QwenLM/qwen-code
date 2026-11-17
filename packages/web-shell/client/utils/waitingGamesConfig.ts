/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The waiting card's game entry is opt-in. The activity and token views stay
// available without it.
export const WAITING_GAMES_STORAGE_KEY = 'qwen-code-web-shell-waiting-games';

type WaitingGamesWindow = Window & {
  __QWEN_CODE_WAITING_GAMES__?: boolean;
};

export function readWaitingGamesEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const param = params.get('waitingGames') ?? params.get('waiting-games');
    if (param !== null) {
      return param === '1' || param.toLowerCase() === 'true';
    }
    if ((window as WaitingGamesWindow).__QWEN_CODE_WAITING_GAMES__ === true) {
      return true;
    }
    return window.localStorage.getItem(WAITING_GAMES_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
