# Email channel

[English](email-channel.md) | [简体中文](email-channel.zh-CN.md)

## Problem and scope

Issue [#8281](https://github.com/QwenLM/qwen-code/issues/8281) requests a dedicated agent mailbox using provider-neutral IMAP and SMTP. Main has no email adapter. Implement a built-in private workspace package with ChannelBase access control, sessions, commands, attachments and agent bridge. OAuth, mailbox management, calendar/cryptographic mail, arbitrary composition and HTML output remain outside this change.

## Architecture

`packages/channels/email` owns configuration, MIME parsing, state and transport. The CLI registry imports its plugin; package manifests, TypeScript references and build/test prerequisites discover the package. CLI start, daemon workers and Web Shell management consume the same descriptor. Core behavior remains unchanged. ChannelBase adds an opt-in execution guard at queue entry and immediately before bridge dispatch. Its default permits execution; Email ties it to connection lifetime so stopped queued tasks cannot begin agent work. This avoids duplicating the base session queue in the adapter.

Load ImapFlow, Nodemailer and MailParser at connection time. Use implicit TLS or mandatory STARTTLS with certificate verification. Existing top-level environment reference resolution handles passwords. Disable protocol logging and replace transport errors with operation-only diagnostics. Management validation and runtime validation share the same configuration rules.

## Admission and execution

Select one folder read-only. Initialize the durable UIDVALIDITY and UID cursor to UIDNEXT minus one, so the first connection skips existing mail. A new UIDVALIDITY starts a new baseline. Search new UIDs and fetch at most 100 actual messages per poll, inspect size and headers, normalize the single From mailbox and apply the existing sender gate before parsing the body or writing attachments. Reject ambiguous From headers, own mailbox, Auto-Submitted other than no, list/bulk/junk mail, null return paths, delivery reports and the outbound marker. A From allowlist is not proof of sender authentication: the operator must use a mailbox provider that filters spoofed mail.

Parse text or HTML-to-text without fetching remote resources. Bound the decoded text, trim conventional quoted replies/signatures, and bound message/attachment sizes and attachment count. Save non-image files to generated names in a private message directory; remove that directory when the handled turn ends. Images use the existing base64 attachment flow. Treat subject, body and attachment names as untrusted user content.

Email supports followup and steer dispatch; collect is rejected because buffered messages outlive their handlers. Admission launches tracked ChannelBase tasks without waiting for an agent turn to end, allowing permission replies to arrive. At most 32 ordinary tasks run or queue; a reserved slot admits control replies and sends a busy response to excess tasks. Persist a claim and advance the admission cursor before exposing content to the bridge. Stopping blocks queued turns before bridge execution; operations that already entered the bridge may finish and retain uncertain claims. Remove a claim after the handler settles while the adapter is running; failed dispatch leaves a claim and stops admission. A crash leaves an uncertain claim: startup refuses to replay or discard it, reports its UID and requires the operator to inspect side effects and acknowledge the claim in the state file. There is no exactly-once claim for arbitrary agent or SMTP side effects.

## State and threading

Use a private atomic JSON state file and an exclusive process lock. Scope its path by channel name, canonical workspace and mailbox endpoint/user/folder, excluding secrets. Corrupt or unreadable state fails closed; a missing file establishes a new baseline. Preserve claims and reply metadata, not bodies or credentials. Use bounded recent message identities and reply routes; eviction does not authorize a fallback target.

Thread identity combines the account/workspace state namespace, normalized sender and the root References / In-Reply-To / Message-ID. Known reply identifiers map back to their saved route. Different senders cannot enter another sender's default session by copying headers. Private policies allowlist, open and disabled are supported; pairing is deferred. Default sessionScope is chat_thread; other explicit common scopes retain ChannelBase semantics. Email thread identity and admission progress survive restart. Agent session restoration remains runtime-owned: current standalone cold startup does not restore its saved sessions, while daemon workers restore routes. Track each inbound message's reply context separately so concurrent messages do not change an active response's parent.

## Delivery

Every base send path passes through the adapter's checked delivery method. Replies require a known sender/thread context and a currently admitted sender. SMTP recipients come from that context, never Reply-To, CC, BCC or model output. Add In-Reply-To, References, Auto-Submitted: auto-replied and X-Qwen-Code-Agent, with an agent display name. Suppress replies to no-reply mailboxes. Completed background work uses the existing background-reply hook with the saved session target and a known, currently allowed sender/thread; it does not require permission to compose a new proactive message.

Proactive delivery requires an exact configured recipient. A threaded target additionally needs a known route; an unknown thread fails instead of sending a new message. No fallback recipient. Each SMTP attempt has a durable outboundPending message ID, including proactive sends. SMTP errors are reported without credentials; uncertain sends are not automatically retried and proactive delivery errors are classified permanent. Interactive commands remain the existing email-text command flow.

## Verification and acceptance

First verify the global CLI lacks the feature. Then check local bundle configuration and a local TLS IMAP/SMTP fixture with a controlled agent response. Tests cover baseline skip, new delivery, same-thread continuation, sender isolation, allowlist before body exposure, HTML and attachments, malformed and oversized mail, loop headers, recipient restriction, secret redaction, reconnect, UIDVALIDITY rollover, restart, uncertain claims, state isolation and shutdown. Include a delayed turn plus its incoming permission/command reply to prove admission remains live. Run build, typecheck, bundle and focused package/registry/build-configuration tests. Record limitations rather than infer provider-wide compatibility from a local fixture.

## Open questions

Maintainer design alignment and any unpublished work from the previous contributor remain external follow-ups. Local implementation and verification do not imply issue assignment or maintainer approval.
