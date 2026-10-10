import type { LiveHostApi } from '../shared/host-api.ts';
import { LiveView } from './live-view.ts';

declare global {
  interface Window {
    qwenLiveHost: LiveHostApi;
  }
}

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing Live Host root');
const view = new LiveView(app, window.qwenLiveHost);
let receivedState = false;
const unsubscribe = window.qwenLiveHost.onState((state) => {
  receivedState = true;
  view.update(state);
});
const unsubscribeLevel = window.qwenLiveHost.onInputLevel((level) =>
  view.setInputLevel(level),
);
void window.qwenLiveHost.getState().then((state) => {
  if (!receivedState) view.update(state);
});
window.addEventListener('beforeunload', () => {
  unsubscribe();
  unsubscribeLevel();
  view.dispose();
});
