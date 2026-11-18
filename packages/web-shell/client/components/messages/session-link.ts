export function openSessionLink(target: string): void {
  const queryStart = target.indexOf('?');
  const workspaceCwd =
    queryStart === -1
      ? undefined
      : new URLSearchParams(target.slice(queryStart + 1)).get('workspace');
  const detail = workspaceCwd
    ? {
        sessionId: target.slice(0, queryStart),
        workspaceCwd,
        source: 'session-link',
      }
    : target;
  window.dispatchEvent(new CustomEvent('qwen:open-session', { detail }));
}
