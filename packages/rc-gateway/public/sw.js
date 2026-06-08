/* global self */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let p;
  try {
    p = event.data ? event.data.json() : {};
  } catch {
    p = {};
  }
  if (p.v !== 1) return;
  const title =
    p.kind === 'permission.required' ? 'Permission needed' : 'qwen-code';
  const actions =
    p.kind === 'permission.required'
      ? [
          { action: 'approve', title: 'Approve' },
          { action: 'deny', title: 'Deny' },
        ]
      : [];
  event.waitUntil(
    self.registration.showNotification(title, {
      body: String(p.summary || '').slice(0, 140),
      tag: p.requestId || p.sessionId || undefined,
      data: {
        url: p.url || '/ui/',
        requestId: p.requestId,
        sessionId: p.sessionId,
        kind: p.kind,
      },
      actions,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  // Cycle 11: every click (incl. action buttons) opens/focuses the app at the
  // deep link. Cycle 12 will POST approve/deny inline for the action buttons.
  const url = d.url || '/ui/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const c of all) {
        if ('focus' in c) {
          c.navigate?.(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
