# Remote Control Feature

The Remote Control feature allows you to connect to your local Qwen Code CLI session from a web browser or mobile device, enabling you to interact with the agent remotely.

## Overview

When you start the remote control server, Qwen Code creates:

- An HTTP server serving a web interface
- A WebSocket server for real-time bidirectional communication
- A secure authentication system using tokens

## Usage

### Starting the Remote Control Server

#### Using the Slash Command

In an interactive Qwen Code session:

```bash
/remote-control
```

This will:

1. Start the remote control server on port 7373 (default)
2. Display a QR code for easy connection
3. Show the WebSocket URL and authentication token

#### Using the CLI Subcommand

From the terminal:

```bash
qwen remote-control
```

Or with custom options:

```bash
# Custom port
qwen remote-control --port 8080

# Custom session name
qwen remote-control "My Project"

# Custom host (e.g., to allow connections from other devices on your network)
qwen remote-control --host 0.0.0.0
```

### Stopping the Server

#### Slash Command

```bash
/remote-control stop
```

#### CLI Subcommand

```bash
qwen remote-control --stop
```

## Connection Methods

### 1. QR Code (Recommended)

Scan the displayed QR code with your device to automatically connect.

### 2. Manual Token Entry

1. Open the WebSocket URL in your browser: `ws://localhost:7373/ws`
2. Enter the authentication token when prompted

### 3. Direct URL Connection

Connect directly using the WebSocket URL (token entered separately):

```
ws://localhost:7373/ws
```

## Security

### Security Features

- **Token-based Authentication**: Each session generates a unique random 64-character hex token
- **Rate Limiting**: Maximum 5 authentication attempts per minute per IP address
- **Connection Limits**: Maximum 5 concurrent connections
- **Message Size Validation**: Maximum 1MB per message to prevent DoS
- **Idle Session Timeout**: Connections timeout after 30 minutes of inactivity
- **Input Sanitization**: All user input is HTML-escaped to prevent XSS
- **Security Headers**: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection
- **No Token in URLs**: Tokens are sent via WebSocket messages, not URL parameters

### Security Best Practices

1. **Use WSS in Production**: Enable WebSocket Secure (WSS) for encrypted connections

   ```typescript
   const server = new RemoteControlServer({
     secure: true,
     port: 7373,
   });
   ```

2. **Keep the token secret** - anyone with the token can connect to your session

3. **Stop the server when done** using `/remote-control stop`

4. **Use in trusted networks only** - the default connection is not encrypted

5. **Don't expose to the public internet** unless you have WSS enabled and proper firewall rules

6. **Monitor connections** - check the terminal for connection notifications

### Security Limitations

- **No encryption by default**: Use WSS for production environments
- **Local binding recommended**: Only bind to `0.0.0.0` when necessary
- **Token rotation**: Tokens are not rotated during a session
- **No multi-factor authentication**: Single token authentication only

## Architecture

```
┌─────────────────┐         WebSocket          ┌─────────────────┐
│   Browser UI    │◄──────────────────────────►│  Local CLI      │
│ (remote device) │  HTTP + WS (port 7373)     │  Server         │
└─────────────────┘                            └─────────────────┘
         │                                            │
         │ QR Code / URL                              │ Session
         │ Connection                                 │ Sync
         ▼                                            ▼
┌─────────────────┐                            ┌─────────────────┐
│  Auth Token     │◄──────────────────────────►│  Qwen Code      │
│  (in message)   │      Secure Channel        │  Core           │
└─────────────────┘                            └─────────────────┘
```

## Protocol

The remote control uses a custom WebSocket protocol with the following message types:

### Client → Server Messages

- `auth_request`: Authenticate with a token (sent in message body, NOT URL)
- `sync_request`: Request session state and message history
- `user_input`: Send a message to the agent
- `command_request`: Execute a command
- `control_command`: Control the session (pause, resume, stop)
- `ping`: Health check

### Server → Client Messages

- `auth_response`: Authentication result
- `sync_response`: Session state and history
- `message_update`: New message in the conversation
- `session_update`: Session state changed
- `user_input_ack`: Acknowledgment of user input
- `command_response`: Command execution result
- `control_command_ack`: Control command acknowledgment
- `pong`: Health check response
- `error`: Error message

## API Endpoints

### HTTP Endpoints

- `GET /health`: Health check
- `GET /api/connect?token=XXX`: Get connection info (requires token)
- `GET /api/qr-data?token=XXX`: Get QR code connection data (requires token)
- `GET /`: Web UI interface
- `GET /ws`: WebSocket endpoint

## Configuration

### Default Settings

| Setting           | Default      | Description                      |
| ----------------- | ------------ | -------------------------------- |
| Port              | 7373         | HTTP/WebSocket server port       |
| Host              | localhost    | Network interface to bind        |
| Token Expiry      | 5 minutes    | How long tokens remain valid     |
| Max Connections   | 5            | Maximum concurrent connections   |
| Max Auth Attempts | 5 per minute | Rate limit for authentication    |
| Idle Timeout      | 30 minutes   | Session timeout after inactivity |
| Max Message Size  | 1 MB         | Maximum WebSocket message size   |

### Custom Configuration

You can customize the server configuration:

```typescript
const server = new RemoteControlServer({
  port: 8080,
  host: '0.0.0.0',
  sessionName: 'My Session',
  secure: true, // Enable WSS
  tokenExpiryMs: 10 * 60 * 1000, // 10 minutes
  maxConnections: 10,
});
```

## Troubleshooting

### Server Won't Start

**Error: Port already in use**

```bash
# Try a different port
qwen remote-control --port 8080
```

**Error: Permission denied**

```bash
# On Unix-like systems, ports < 1024 require root
qwen remote-control --port 7373  # Use a port > 1024
```

### Can't Connect from Remote Device

1. **Check firewall settings**: Ensure the port is open
2. **Use correct host**: Start with `--host 0.0.0.0` to allow external connections
3. **Verify network**: Ensure both devices are on the same network
4. **Check IP address**: Use your machine's local IP, not localhost

```bash
# Find your local IP
# Windows
ipconfig

# macOS/Linux
ifconfig
```

### Authentication Fails

1. **Check token**: Ensure you're using the correct token
2. **Rate limited**: Too many failed attempts - wait 1 minute
3. **Token expired**: Tokens expire after 5 minutes - restart the server
4. **Case sensitivity**: Tokens are case-sensitive

### Connection Timeout

- **Idle timeout**: Sessions timeout after 30 minutes of inactivity
- **Reconnect**: Simply reconnect with the same token

## Security Audit Checklist

Before deploying to production:

- [ ] Enable WSS (WebSocket Secure)
- [ ] Use strong firewall rules
- [ ] Rotate tokens regularly
- [ ] Monitor connection logs
- [ ] Limit max connections appropriately
- [ ] Set appropriate idle timeout
- [ ] Review rate limiting settings
- [ ] Test on isolated network first

## Limitations

- **Read-only mode**: Some features may be limited in remote mode
- **No file uploads**: Cannot upload files through the remote interface
- **Limited tool execution**: Some tools require local terminal access
- **Single session**: Only one local session can be controlled at a time
- **No encryption by default**: WSS must be explicitly enabled

## Future Enhancements

Planned improvements:

- [ ] End-to-end encryption for WebSocket connections
- [ ] Multi-session support
- [ ] Enhanced remote tool execution
- [ ] File transfer capabilities
- [ ] Mobile app integration
- [ ] Session recording and playback
- [ ] OAuth integration
- [ ] Role-based access control

## Related Files

- `packages/cli/src/remote-control/` - Core remote control implementation
- `packages/cli/src/commands/remote-control/` - CLI subcommand
- `packages/cli/src/ui/commands/remoteControlCommand.ts` - Slash command
- `packages/cli/src/remote-control/types.ts` - Protocol type definitions
- `packages/cli/src/remote-control/server/RemoteControlServer.ts` - Server implementation
- `packages/cli/src/remote-control/utils/htmlSanitizer.ts` - Security utilities

## Security Contact

For security issues or vulnerabilities, please report them through the project's security channel.
