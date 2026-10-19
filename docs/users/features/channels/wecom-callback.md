# WeCom Self-Built Application Callback

Use `wecom-callback` to chat with Qwen Code through a WeCom self-built application
(企业微信自建应用). It receives encrypted HTTP callbacks and sends text replies
through the application API. For intelligent robots with a Bot ID and Secret,
use the separate [WeCom WebSocket channel](./wecom).

## Prerequisites

- A WeCom administrator and a self-built application with permission to receive
  messages and send application messages.
- The enterprise Corp ID, application Agent ID and Secret, and the callback Token
  and EncodingAESKey configured under the application's message receiving settings.
- A public HTTPS callback URL forwarded to the local listener. Configure the
  application's trusted outbound IPs and visible member range as required by
  your tenant. Keep the Qwen host's clock synchronized.

See the official [callback encryption](https://developer.work.weixin.qq.com/document/path/90968)
and [application message API](https://developer.work.weixin.qq.com/document/path/90236)
documentation for platform requirements.

## Configuration

Add a named channel to `~/.qwen/settings.json`:

```json
{
  "channels": {
    "my-wecom-app": {
      "type": "wecom-callback",
      "corpId": "$WECOM_CORP_ID",
      "agentId": "$WECOM_AGENT_ID",
      "corpSecret": "$WECOM_APP_SECRET",
      "token": "$WECOM_CALLBACK_TOKEN",
      "encodingAESKey": "$WECOM_ENCODING_AES_KEY",
      "webhookHost": "127.0.0.1",
      "webhookPort": 8645,
      "privatePolicy": "allowlist",
      "allowedUsers": ["zhangsan"],
      "sessionScope": "user",
      "groupPolicy": "disabled",
      "cwd": "/path/to/your/project"
    }
  }
}
```

Set the five environment variables in the process that starts Qwen Code. Agent
ID is a positive integer **string**, such as `"1000002"`. EncodingAESKey is the
43-character key from the WeCom console. The callback Token is distinct from
the application Secret and the API access token; Qwen obtains API access tokens
automatically. The three secret fields are masked in channel management.

The listener defaults to `127.0.0.1:8645`, with the fixed path `/wecom/callback`.
Forward your public URL to that path, preserving its query string and body. For
container deployments, bind to a reachable interface explicitly. Use separate
channel names and ports for multiple applications.

## Running and platform verification

1. Run `qwen channel start my-wecom-app`.
2. In the self-built application's message receiving settings, enter the public
   HTTPS URL ending in `/wecom/callback`, Token, and EncodingAESKey. Save the
   settings; Qwen decrypts and returns the verification challenge.
3. Add a test member to the application's visible range and put their WeCom
   User ID in `allowedUsers`. Send a text message to the application. Expect a
   text reply from that application.
4. Send from a visible member outside `allowedUsers`. Expect no agent task or
   reply. Qwen still acknowledges the callback to avoid platform retries.
5. Request a long reply containing Chinese text and emoji. Expect ordered text
   messages, each within the platform's 2048-byte limit.
6. Stop the channel and confirm the local listener closes.

If URL verification fails, check the reverse proxy, callback path, clock, Corp
ID, Token and EncodingAESKey. If callbacks arrive but replies fail, check the
Agent ID, application Secret, application visibility and trusted outbound IPs.
Application secrets and callback keys must never be posted in logs or issues.

## Supported behavior and limits

- Text private messages and text replies. Shared access policies, pairing,
  commands, permissions and sessions apply. Use member User IDs for access rules.
- Proactive messages can target individual users. Groups, threads, media,
  application events and streaming replies are not supported.
- Callbacks are authenticated, decrypted and acknowledged before agent execution
  finishes. Replies use the application message API, rather than the callback's
  synchronous response. Admitted message IDs are suppressed in memory for at
  least five minutes and until their signed timestamp window expires; requests
  outside the five-minute signature timestamp window fail. Rejected senders do
  not consume retry-cache capacity.
- In-flight work is not durably queued. Restarting the process after an
  acknowledgement can lose that task, and restarting clears the retry cache.

## Testing without an enterprise tenant

From `packages/channels/wecom`, run:

```bash
npx vitest run src/wecom-callback-crypto.test.ts src/wecom-callback-adapter.test.ts src/callback-plugin.test.ts src/WeComAdapter.test.ts
```

The tests use an independent published SDK encryption fixture, real loopback HTTP
requests, the shared inbound access checks and mocked application API responses.
They cover handshake verification, authentication failures, retries, recipient
isolation, Unicode splitting and shutdown. They do not need real credentials or
send messages to WeCom. The platform verification steps above are still needed
to validate a real tenant's public URL, permissions and network configuration.
