# Web Shell HTML artifact sharing

## Goal

Give an HTML artifact card a third action, next to Download and Open, that
uploads the artifact to a user-supplied host and hands back a link the user can
send to someone who does not have the workspace.

## Problem

An HTML artifact is only viewable by whoever can reach the daemon. Sharing one
today means downloading the file and uploading it somewhere by hand. The
artifact card already knows how to read the file out of the workspace — that is
what Download does — so the missing piece is the upload and the link, not the
data path.

The upload target cannot be baked in. Qwen Code has no hosting service of its
own, and silently posting a user's artifacts to a third party would be a
privacy failure. So the endpoint is configuration, and it ships empty.

## Design

### Endpoint contract

The endpoint is a single URL. Web Shell sends:

```
POST <endpoint>
content-type: text/html; charset=utf-8
authorization: Bearer <token>        # only when a token is configured

<the artifact's HTML>
```

and expects `2xx` with a JSON body:

```json
{ "url": "https://host.example/s/abc123" }
```

Anything else is surfaced as a failure. The contract carries nothing
provider-specific, so any host that can answer it works — a Cloudflare Worker,
an S3-backed uploader, an intranet service, or a script on localhost.

### Configuration

Endpoint and token live in `localStorage`
(`qwen-web-shell-share-endpoint`, `qwen-web-shell-share-token`), alongside the
existing theme and language preferences. There is no daemon round-trip and no
new settings-schema entry: the target is a property of the browser the user
shares from, and keeping the token out of the daemon's settings file means it is
never written to disk on a shared host.

The endpoint must be `https://`. Plain `http://` is accepted only for loopback
hosts, where there is no wire to intercept — otherwise the bearer token and the
artifact would travel in the clear.

### Flow

The Share button appears on an artifact card when the artifact is HTML
(`kind === 'html'`, an `.html`/`.htm` path, or a `text/html` MIME type) and is
readable from the workspace — the same availability rule Download uses.

Clicking it opens a dialog:

- **Nothing configured** — an endpoint field and an optional token field.
  Saving publishes in the same step.
- **Already configured** — a confirmation naming the endpoint, because
  publishing puts the artifact on the public internet and the returned link
  authorizes whoever holds it.
- **Published** — the returned URL, selectable and copyable.

Uploads are capped at 5 MB and are abandoned if the dialog closes mid-flight.

### Security

The artifact is model-generated HTML, so the published page can run arbitrary
script under the endpoint's origin. The endpoint should therefore serve shared
artifacts from an origin that hosts nothing else — a dedicated domain or
subdomain — so a shared artifact cannot reach another application's cookies or
storage. Web Shell's own preview sandbox (`withArtifactPreviewCsp`) does not
apply to the published copy; the host is responsible for whatever headers it
wants to serve.

Only the returned URL is trusted as far as `http:`/`https:` — any other scheme
in the response is rejected rather than rendered as a link.

## Reference endpoint

A Cloudflare Worker satisfying the contract, for a user who wants one:

```js
// wrangler.toml: kv_namespaces = [{ binding = "SHARES", id = "..." }]
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // The upload is cross-origin and carries an Authorization header and a
    // text/html body, so the browser preflights it.
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '86400',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (req.method === 'POST' && url.pathname === '/publish') {
      if (req.headers.get('authorization') !== `Bearer ${env.PUBLISH_TOKEN}`) {
        return new Response('unauthorized', { status: 401, headers: cors });
      }
      const html = await req.text();
      if (html.length > 5_000_000) {
        return new Response('too large', { status: 413, headers: cors });
      }
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      await env.SHARES.put(id, html, { expirationTtl: 60 * 60 * 24 * 30 });
      return Response.json({ url: `${url.origin}/s/${id}` }, { headers: cors });
    }

    const id = url.pathname.match(/^\/s\/([a-f0-9]{16})$/)?.[1];
    if (!id) return new Response('not found', { status: 404 });
    const html = await env.SHARES.get(id);
    return html
      ? new Response(html, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      : new Response('expired or not found', { status: 404 });
  },
};
```

The endpoint must answer the CORS preflight and allow the `authorization` and
`content-type` request headers; a handler that only sets
`access-control-allow-origin` on the `POST` response will fail before the upload
is ever sent.

## Alternatives considered

**Upload through the daemon.** Keeps the token off the browser, but needs a new
daemon route plus SDK and client plumbing, and writes the token into the
daemon's settings file. Rejected as disproportionate: the browser already holds
a daemon token of comparable value.

**A built-in default endpoint.** Would make the button work out of the box, at
the cost of uploading users' artifacts to a service the project would have to
run and pay for, by default. Rejected.
