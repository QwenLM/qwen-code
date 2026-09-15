export interface WebPreviewState {
  url: string;
  viewport: 'desktop' | 'mobile';
}

function protectedOrigin(url: URL): string {
  const normalized = new URL(url);
  normalized.hostname = normalized.hostname.replace(/\.$/, '');
  if (
    normalized.hostname === 'localhost' ||
    normalized.hostname === '[::1]' ||
    normalized.hostname === '0.0.0.0' ||
    normalized.hostname === 'host.docker.internal' ||
    normalized.hostname.endsWith('.localhost') ||
    /^127\./.test(normalized.hostname)
  ) {
    normalized.hostname = 'localhost';
  }
  return normalized.origin;
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
      url.hostname.endsWith('.') ||
      !/^[a-z0-9._-]+$/i.test(url.hostname)
    ) {
      return;
    }
    const protectedOrigins = [
      protectedOrigin(new URL(shellUrl)),
      protectedOrigin(new URL(daemonUrl, shellUrl)),
    ];
    const upgraded = new URL(url);
    upgraded.protocol = 'https:';
    // CSP HTTP sources also permit HTTPS upgrades.
    if (
      protectedOrigins.includes(protectedOrigin(url)) ||
      protectedOrigins.includes(protectedOrigin(upgraded))
    ) {
      return;
    }
    return url;
  } catch {
    return;
  }
}

export function escapeAttribute(value: string): string {
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
