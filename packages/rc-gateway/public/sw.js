/* global self, fetch, indexedDB, URL */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Multi-daemon manifest cache written by the viewer (CLIENTS_KEY) — same
// origin, so the SW shares the page's localStorage. Maps this SW's origin to
// its registry name so push titles can carry the source daemon
// (add-multi-workspace-client "Notification displays source daemon").
// Resolves '' on any error — a missing/corrupt cache just drops the prefix.
function originDaemonName() {
  try {
    const raw = self.localStorage.getItem('qwen-rc:clients');
    if (!raw) return '';
    const obj = JSON.parse(raw);
    const list = Array.isArray(obj.daemons) ? obj.daemons : [];
    for (const d of list) {
      if (!d || typeof d.name !== 'string' || typeof d.url !== 'string')
        continue;
      try {
        if (new URL(d.url).origin === self.location.origin) return d.name;
      } catch {
        /* malformed url entry — skip it */
      }
    }
  } catch {
    /* corrupt cache — no prefix */
  }
  return '';
}

self.addEventListener('push', (event) => {
  let p;
  try {
    p = event.data ? event.data.json() : {};
  } catch {
    p = {};
  }
  if (p.v !== 1) return;
  let title =
    p.kind === 'permission.required' ? 'Permission needed' : 'qwen-code';
  // Push titles only (notification clicks are untouched): when this origin is
  // one of several registered daemons, "[workstation-1] Permission needed".
  const dname = originDaemonName();
  if (dname) title = '[' + dname + '] ' + title;
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
        approveOptionId: p.approveOptionId,
      },
      actions,
    }),
  );
});

// Best-effort read of the bearer token mirrored into IndexedDB by the viewer
// (DB qwen-rc v1, store auth, key token). Resolves undefined on any error so
// voting silently falls back to opening the app.
function idbGetToken() {
  return new Promise((resolve) => {
    try {
      if (!('indexedDB' in self)) return resolve(undefined);
      const req = indexedDB.open('qwen-rc', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('auth')) {
          db.createObjectStore('auth');
        }
      };
      req.onerror = () => resolve(undefined);
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains('auth')) return resolve(undefined);
          const tx = db.transaction('auth', 'readonly');
          const get = tx.objectStore('auth').get('token');
          get.onsuccess = () =>
            resolve(typeof get.result === 'string' ? get.result : undefined);
          get.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      };
    } catch {
      resolve(undefined);
    }
  });
}

// POST a vote to the cycle-6 permission endpoint. Resolves undefined on any
// network/error so the caller can fall back to opening the app.
async function postVote(sessionId, requestId, body, token) {
  try {
    return await fetch(
      '/session/' +
        encodeURIComponent(sessionId) +
        '/permission/' +
        encodeURIComponent(requestId),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify(body),
      },
    );
  } catch {
    return undefined;
  }
}

// Brief confirmation notification, reusing the request tag so it replaces the
// original notification rather than stacking.
function confirmNote(text, tag) {
  return self.registration.showNotification(text, {
    tag: tag || undefined,
  });
}

// Focus an existing window at the deep link, or open a new one.
async function openApp(url) {
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
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const isVote = event.action === 'approve' || event.action === 'deny';
  if (isVote && d.requestId && d.sessionId) {
    event.waitUntil(
      (async () => {
        const token = await idbGetToken();
        const body =
          event.action === 'approve'
            ? d.approveOptionId
              ? { outcome: 'selected', optionId: d.approveOptionId }
              : null
            : { outcome: 'cancelled' };
        if (token && body) {
          const res = await postVote(d.sessionId, d.requestId, body, token);
          if (res && res.ok) {
            await confirmNote(
              event.action === 'approve' ? 'Approved' : 'Denied',
              d.requestId,
            );
            return;
          }
          if (res && res.status === 404) {
            await confirmNote('Already resolved', d.requestId);
            return;
          }
        }
        // fall through: open the app so the user can act manually
        await openApp(d.url || '/ui/');
      })(),
    );
    return;
  }
  event.waitUntil(openApp(d.url || '/ui/'));
});
