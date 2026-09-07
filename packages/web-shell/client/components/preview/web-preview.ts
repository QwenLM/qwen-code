export interface WebPreviewState {
  url: string;
  viewport: 'desktop' | 'mobile';
}

export function parseWebPreviewUrl(
  input: string,
  shellUrl: string,
  daemonUrl: string,
): URL | undefined {
  try {
    const url = new URL(input.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !/^[a-z0-9._-]+$/i.test(url.hostname)
    ) {
      return;
    }
    const protectedOrigins = [
      new URL(shellUrl).origin,
      new URL(daemonUrl, shellUrl).origin,
    ];
    const upgraded = new URL(url);
    upgraded.protocol = 'https:';
    // CSP HTTP sources also permit HTTPS upgrades.
    if (
      protectedOrigins.includes(url.origin) ||
      protectedOrigins.includes(upgraded.origin)
    ) {
      return;
    }
    return url;
  } catch {
    return;
  }
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function webPreviewDocument(url: URL, title: string): string {
  // Pin direct child navigation; host frame-ancestors also protects against
  // descendant frames created by the application itself.
  const policy = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; frame-src ${url.origin}; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">
<meta name="referrer" content="no-referrer">
<style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block;overflow:hidden}</style>
</head><body><iframe title="${escapeAttribute(title)}" src="${escapeAttribute(url.href)}" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer"></iframe></body></html>`;
}
