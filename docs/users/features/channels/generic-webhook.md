# Generic Webhook Sending

Send task results and explicit notifications to a receiver you control. Each
named `generic-webhook` Channel sends a fixed JSON message to one URL. Use this
when your service can implement the receiving contract; use the platform
adapters for DingTalk, Feishu or WeCom group webhooks.

## Configure a Channel

Add a named instance to your workspace's `settings.json`:

```json
{
  "channels": {
    "build-reports": {
      "type": "generic-webhook",
      "webhookUrl": "$REPORT_WEBHOOK_URL",
      "bearerToken": "$REPORT_WEBHOOK_TOKEN"
    }
  }
}
```

Set these environment variables in the environment that starts Qwen Code.
`bearerToken` is optional: omit it when the receiver does not require Bearer
authentication. Both fields are secrets; configuration reads hide their values.
Keep credentials out of task prompts and delivery targets.

Start the daemon in the workspace:

```bash
qwen serve --channel build-reports
```

Starting makes the Channel locally ready. It does not contact the receiver or
verify credentials. Stopping cancels in-flight requests. Restart or reload the
Channel to apply configuration changes.

The backend provides configuration and delivery APIs. Builds without the
corresponding Web integration do not show Generic Webhook in Channels; use
`settings.json` and `qwen serve --channel` until that integration is available.

## Receiving contract

Qwen Code sends one HTTP `POST` with `Content-Type: application/json`:

```json
{
  "version": 1,
  "text": "# Build report\n\nAll checks passed."
}
```

If configured, the request also includes `Authorization: Bearer <token>`.
The adapter preserves the text it receives, including Markdown. Your receiver chooses how to render,
store or forward it. Version 1 receivers should require `version: 1`, accept a
string `text` and tolerate unknown fields for future compatible additions.

Return **any 2xx status**, including an empty `204`, to acknowledge acceptance.
The response body is ignored. Acceptance does not mean that a downstream
notification has been read or delivered. Redirects are not followed.

There are no custom payload templates, arbitrary headers, attachments, event
metadata, HMAC signatures or automatic retries. Repeated manual submissions can
produce duplicate messages; no exactly-once or idempotency guarantee is made.

## Destination and task delivery

Use the existing workspace Notify API with this body:

```json
{
  "text": "# Build report\n\nAll checks passed.",
  "delivery": {
    "kind": "channel",
    "target": {
      "channelName": "build-reports",
      "type": "chat",
      "id": "default"
    }
  }
}
```

`chat/default` is the configured endpoint's logical destination, not a chat on
an IM platform. Other IDs, user targets and threads are rejected. One Channel
instance represents one endpoint; create another instance for another receiver.

Persistent scheduled tasks can store the same target. Delivery uses the existing
best-effort successful-final-result behavior. Existing per-run session and
manual-trigger restrictions still apply. This integration does not add inbound
webhook tasks, failure/cancellation events or agent conversations.

## Network access

By default, the URL must use **HTTPS** and resolve only to public addresses.
Credentials in URL user-info, fragments and redirects are not supported.

URLs use standard URL parsing, including hostname case, default-port and
internationalized-domain normalization. Validation and delivery use the same
parser; the parsed hostname is resolved and checked before connecting.

To reach your own local or private-network receiver, explicitly set the
per-Channel `allowPrivateNetwork` option:

```json
{
  "channels": {
    "local-reports": {
      "type": "generic-webhook",
      "webhookUrl": "http://127.0.0.1:8787/reports",
      "allowPrivateNetwork": true
    }
  }
}
```

This permits loopback, RFC 1918 IPv4 and IPv6 unique-local destinations over
HTTP or HTTPS. Public HTTP remains rejected. Link-local, multicast, reserved
and known cloud-metadata addresses remain blocked. Hostnames are checked on
every send; all returned addresses must satisfy the policy. The checked address
is pinned to the connection, including when using a proxy, while HTTPS keeps
the original hostname for certificate verification.

Transport honors the resolved workspace proxy and existing `NO_PROXY` behavior.
An endpoint that resolves only inside a remote proxy's network is not supported:
Qwen Code must be able to resolve and validate it locally.

## Limits and failures

Each attempt makes at most one request with a 15-second deadline, including
DNS lookup. The adapter limits the serialized JSON body to **640 KiB**. The
shared delivery layer's **100,000 UTF-16-unit** text bound applies first and can
shorten longer input before it reaches the adapter. The adapter rejects bodies
over its byte limit and does not further truncate or split text.

HTTP 408, 425, 429 and 5xx responses are reported as transient delivery failures;
other non-2xx responses are permanent failures. Neither classification adds
automatic retries. Timeouts and cancellation can leave remote acceptance
unknown. Diagnostics omit the receiver URL, token, body and raw response text.

## Minimal local receiver

Save this as `receiver.mjs` and run `node receiver.mjs`. It listens only on
loopback and demonstrates the unauthenticated local contract above:

```js
import { createServer } from 'node:http';

createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/reports') {
    response.writeHead(404).end();
    return;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 640 * 1024) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (message.version !== 1 || typeof message.text !== 'string') {
      response.writeHead(400).end();
      return;
    }
    console.log(message.text);
    response.writeHead(204).end();
  } catch {
    response.writeHead(400).end();
  }
}).listen(8787, '127.0.0.1');
```

For this IPv4-only example, keep `127.0.0.1` in the webhook URL: `localhost`
may resolve first to IPv6 `::1`, which this receiver does not listen on.

For a hosted receiver, use HTTPS and validate the optional Bearer token before
processing the body. Return 2xx only after your application has accepted the
message.
