# @qwen-code/channel-plugin-example

A reference channel plugin for Qwen Code. It connects to a WebSocket server and routes messages through the full channel pipeline (access control, session routing, agent bridge).

Use this package to:

- **Try out the channel plugin system** — install it as an extension and run it with the built-in mock server
- **Use it as a starting point** — fork the source to build your own channel adapter (see the [Channel Plugin Developer Guide](../../../docs/developers/channel-plugins.md))

## Quick start

### 1. Install the package

```bash
npm install @qwen-code/channel-plugin-example
```

### 2. Link it as a Qwen Code extension

The package ships a `qwen-extension.json` manifest, so it works as an extension out of the box:

```bash
qwen extensions link ./node_modules/@qwen-code/channel-plugin-example
```

### 3. Configure the channel

Add a channel entry to `~/.qwen/settings.json`:

```json
{
  "channels": {
    "my-plugin-test": {
      "type": "plugin-example",
      "serverWsUrl": "ws://localhost:9201",
      "senderPolicy": "open",
      "sessionScope": "user",
      "cwd": "/path/to/your/project"
    }
  }
}
```

### 4. Start the mock server

```bash
npx qwen-channel-plugin-example-server
```

The server prints the HTTP and WebSocket URLs. You can customize ports with environment variables:

```bash
HTTP_PORT=8080 WS_PORT=8081 npx qwen-channel-plugin-example-server
```

### 5. Start the channel

In a separate terminal:

```bash
qwen channel start my-plugin-test
```

### 6. Send a message

```bash
curl -sX POST http://localhost:9200/message \
  -H 'Content-Type: application/json' \
  -d '{"senderId":"user1","senderName":"Tester","text":"What is 2+2?"}'
```

You should get a JSON response with the agent's reply.

## How it works

```
Mock Server (HTTP + WS)
  ↕ WebSocket
MockPluginChannel (this package)
  → Envelope → ChannelBase.handleInbound()
    → SenderGate → SessionRouter → ChannelAgentBridge.prompt()
      → qwen-code agent → model API
    ← response
  ← sendMessage() → WebSocket → Mock Server
  ← HTTP response
```

## Building your own channel

See `src/MockPluginChannel.ts` for a working example. The key points:

1. Extend `ChannelBase` and implement `connect()`, `sendMessage()`, `disconnect()`
2. Build an `Envelope` from incoming platform messages and call `this.handleInbound(envelope)`
3. Type the adapter constructor bridge parameter as `ChannelAgentBridge`
4. Export a `plugin` object conforming to `ChannelPlugin`
5. Add a `qwen-extension.json` manifest

`AcpBridge` is still the current standalone `qwen channel start` implementation. Plugin adapters should depend on the `ChannelAgentBridge` abstraction provided by `@qwen-code/channel-base`.

Existing TypeScript plugins that explicitly type the adapter constructor or factory `bridge` parameter as `AcpBridge` should change that annotation to `ChannelAgentBridge`. JavaScript plugins are unaffected at runtime.

### Features you get for free

- **Block streaming** — enable `blockStreaming: "on"` in config and the agent's response is automatically split into multiple messages at paragraph boundaries
- **Attachments** — populate `envelope.attachments` with images/files and `handleInbound()` routes them to the agent (images as vision input, files as paths in the prompt)
- **Streaming hooks** — override `onResponseChunk()` for progressive display (e.g., editing a message in-place)
- Access control (allowlist, pairing, open), session routing, slash commands, crash recovery

Full guide: [Channel Plugin Developer Guide](../../../docs/developers/channel-plugins.md)
