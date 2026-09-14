import type { SubagentsWindowApi } from '../shared/subagents-api.ts';
import { SubagentsView } from './subagents-view.ts';

declare global {
  interface Window {
    qwenLiveSubagents: SubagentsWindowApi;
  }
}

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing Subagents root');
const api = window.qwenLiveSubagents;
const view = new SubagentsView(app, api);
let receivedState = false;
let disposed = false;
const unsubscribe = api.onState((state) => {
  receivedState = true;
  view.update(state);
});
void api.getState().then(
  (state) => {
    if (!disposed && !receivedState) view.update(state);
  },
  () => {
    if (!disposed && !receivedState) view.showLoadFailure();
  },
);
window.addEventListener('beforeunload', () => {
  disposed = true;
  unsubscribe();
  view.dispose();
});
