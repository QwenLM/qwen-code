# Email

Use a dedicated mailbox to send tasks to Qwen Code through IMAP and receive plain-text SMTP replies. The first connection skips mail already in the selected folder. Later connections resume the saved UID cursor.

## Configure and start

Enable IMAP and SMTP for the mailbox and export its credentials into the environment of the process running Qwen Code. Add this channel to `settings.json`:

```json
{
  "channels": {
    "agent-mail": {
      "type": "email",
      "address": "agent@example.com",
      "imapHost": "imap.example.com",
      "imapUser": "agent@example.com",
      "imapPassword": "$AGENT_IMAP_PASSWORD",
      "smtpHost": "smtp.example.com",
      "smtpUser": "agent@example.com",
      "smtpPassword": "$AGENT_SMTP_PASSWORD",
      "privatePolicy": "allowlist",
      "allowedUsers": ["you@example.com"],
      "sessionScope": "chat_thread",
      "cwd": "/path/to/workspace"
    }
  }
}
```

Run `qwen channel start agent-mail`. Password fields support the existing `$ENV_VAR` references; keep plaintext passwords out of settings. The adapter disables protocol logging and reports connection failures without credentials.

Implicit TLS defaults to IMAP port 993 and SMTP port 465. For STARTTLS, set `imapSecure` or `smtpSecure` to `false`; the default ports become 143 and 587 respectively. STARTTLS and certificate verification remain mandatory. Override `imapPort` and `smtpPort` when needed. For a private CA, configure Node's `NODE_EXTRA_CA_CERTS` before launching Qwen Code.

| Option                | Default    | Meaning                                                            |
| --------------------- | ---------- | ------------------------------------------------------------------ |
| `folder`              | `INBOX`    | One read-only IMAP folder                                          |
| `pollInterval`        | `60000`    | Poll interval in milliseconds                                      |
| `maxMessageBytes`     | `10485760` | Maximum raw message size; larger messages are skipped              |
| `maxAttachmentBytes`  | `5242880`  | Maximum individual attachment size; larger attachments are omitted |
| `maxTextLength`       | `32000`    | Maximum text characters before quoted-history/signature trimming   |
| `proactiveRecipients` | `[]`       | Exact bare mailbox addresses permitted for proactive delivery      |

At most 16 attachments are forwarded. PNG, JPEG, GIF and WebP images use the existing image input; other files are stored under generated private paths for the duration of the task. Calendar and encapsulated message/report parts are not supported. HTML is converted to text without loading remote resources. Common channel `cwd`, `model`, `instructions` and `sessionScope` options apply. The default `chat_thread` scope separates senders and threads; choosing `single` explicitly shares an agent session.

## Access and replies

`privatePolicy` supports `allowlist` (default), `open` and `disabled`; the legacy `senderPolicy` is also recognized. Pairing is not supported in this first version. Addresses in `allowedUsers` and `operators` are normalized to lowercase; display names do not grant access. Bare ASCII addresses are supported. Use a mailbox provider that filters forged mail: a From allowlist does not authenticate the sender.

Reply to the agent's email to continue the conversation. `Message-ID`, `In-Reply-To` and `References` associate the conversation with its sender. Replies target that sender alone; `Reply-To`, CC, BCC and addresses inside the task cannot change SMTP recipients. Background task results reply through the saved accepted thread after the initiating turn ends. No-reply senders can start tasks but receive no response. Agent-generated, automatic, mailing-list and delivery-report mail is ignored.

Text commands such as `/help`, `/status` and permission replies work in the email body. Email defaults to `followup` and supports `steer`. `collect` is rejected because buffered messages outlive their admission handler and cannot retain an individual durable completion claim. Admission remains active while a task waits. Up to 32 ordinary deliveries can be in flight; an additional slot permits control replies and busy responses. New tasks at capacity receive a request to resend after an active task finishes.

Proactive delivery is disabled unless `proactiveRecipients` contains the exact target. A threaded proactive target must also resolve to a known, currently allowed sender/thread. Unknown targets fail without selecting another recipient or creating a replacement thread. The adapter retains 256 recent reply routes, up to 64 identifiers per route, and 1024 recent inbound identities. IMAP UID progress continues to prevent replay of older deliveries after those metadata entries expire; an evicted thread route cannot receive proactive replies until another accepted message restores it.

## Recovery

State resides under `$QWEN_HOME/channels/<workspace>/email-<account-hash>/state.json` (default QWEN_HOME is `~/.qwen`). Channel name, canonical workspace and mailbox endpoint/user/folder determine the store. Only one process can own it. Switching accounts establishes a separate baseline; UIDVALIDITY changes also skip the existing folder contents.

The adapter persists an in-flight UID before starting a task and an `outboundPending` message ID before each SMTP send, including proactive sends. It removes each record after its corresponding operation completes. If the process stops during execution or SMTP returns an uncertain result, the record remains. Restart reports the state path, pending UIDs and outgoing message IDs and refuses to replay them. Stop the channel, inspect the mailbox and task side effects, and remove only reconciled UIDs from the state's `pending` array and reconciled outgoing IDs from `outboundPending` before restarting. Keep the cursor and thread metadata intact. Do not delete the state file as a retry mechanism: its absence creates a new baseline and skips existing mail.

Email thread identifiers and admission progress survive restart. Agent history restoration follows the channel runtime: the current standalone `channel start` path does not restore its saved agent sessions on cold startup, while daemon workers restore their routes.

Agent side effects, SMTP acceptance and a local cursor cannot be committed in one transaction. Stopping the channel blocks queued turns before they start agent work. Operations already running in the agent may still complete. This recovery policy avoids automatic re-execution of uncertain work; it requires operator reconciliation after interruption. Corrupt/unreadable state also stops startup. Old attachment directories are removed after reconciliation and before receiving new work.

Provider OAuth, rich HTML output, mailbox management, S/MIME, PGP and calendar handling are outside this version.
