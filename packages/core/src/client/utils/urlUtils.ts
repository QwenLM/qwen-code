/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function joinOriginPath(origin: string, path: string): string {
  const url = new URL(origin);
  const base = url.pathname.replace(/\/+$/, '');
  const [pathname, query] = path.split('?', 2);
  const segments = pathname.split('/').filter((segment) => segment !== '');
  let joined = `${base}/${segments.join('/')}`;
  for (let overlap = segments.length; overlap > 0; overlap--) {
    if (base.endsWith(`/${segments.slice(0, overlap).join('/')}`)) {
      const rest = segments.slice(overlap).join('/');
      joined = rest === '' ? base : `${base}/${rest}`;
      break;
    }
  }
  url.pathname = joined;
  if (query !== undefined) url.search = query;
  return url.toString();
}
