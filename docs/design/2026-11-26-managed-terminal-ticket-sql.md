# Managed Terminal Tickets in SQL

[English](2026-11-26-managed-terminal-ticket-sql.md) | [简体中文](2026-11-26-managed-terminal-ticket-sql.zh-CN.md)

Status: implementation design, 2026-11-26. Current-state findings were checked against `main` at `9450cff30a`. This is one slice of running several Java control-plane instances behind a load balancer; it changes only where terminal tickets live. The terminal itself follows the [Managed Web Terminal design](2026-11-10-managed-web-terminal.md).

## 1. Problem and current state

A browser cannot set the deployment's authentication headers on a WebSocket. The Web Terminal therefore uses two requests: an authenticated `POST /api/agent/web-shell/v1/sessions/terminal-ticket` runs the full terminal admission and returns a single-use ticket, and the WebSocket upgrade offers that ticket as its bearer subprotocol.

`TerminalTicketStore` keeps tickets in a process-local map, and each ticket carries the whole admitted `RuntimeBindingRecord`, including the worker lease token. With several control-plane instances behind a load balancer, the two requests can reach different instances, and the upgrade then fails because its instance never saw the ticket.

## 2. Goals and scope

Goals:

- Any instance sharing the database can consume a ticket that another instance issued.
- Keep every existing property: one Session, terminal and binding per ticket; a 30-second lifetime; exactly one successful consumption; typed 503 capacity refusals with a per-tenant share.
- Never persist the ticket or the worker lease token in plaintext.

Out of scope: the other multi-instance gaps (cross-instance SSE, database-clock dispatch leases, Harness attachments, Broker Runtime Sessions), the ticket and upgrade wire contracts, and terminal admission rules.

## 3. Design

### 3.1 Table

The V1 baseline gains `ma_terminal_ticket`: `ticket_hash` (SHA-256 hex, unique), `tenant_id`, `session_id`, `terminal_id`, `binding_id`, `binding_generation`, `expires_at` and `gmt_create`, with an index on `expires_at`. Following the pre-release schema policy, the baseline is edited in place, with no V2 migration and no schema-version change.

### 3.2 Issue

1. Delete expired rows.
2. Count live rows overall and for the tenant in one query; refuse with 503 `terminal_ticket_capacity` at 1024 overall or 256 for the tenant.
3. Insert the new row with `expires_at` set to database time plus 30 seconds.

Each statement commits on its own. The sweep's range locks on the expiry index are therefore never held while another issuer inserts, which avoids the InnoDB gap-lock deadlock that a combined sweep-and-insert transaction would risk.

### 3.3 Consume

Read the row by `ticket_hash`, then `DELETE ... WHERE ticket_hash = ? AND expires_at > <database now>`. The ticket is accepted only when that delete removes exactly one row. Rows are never updated, so the row read first is the one the winning delete consumed. Concurrent consumers on different instances race on the delete, and only one wins.

### 3.4 Binding re-read at upgrade

The ticket names its binding by `binding_id` and `binding_generation` instead of carrying the record. After consuming the ticket, the upgrade re-reads the Session's terminal binding through `WorkspaceTerminalRelayService.terminalBinding`, which applies the same checks as admission: the web-terminal opt-in, READY, not draining, a lease, and the terminal capability digest. It refuses with 409 when the binding no longer passes, or when its identity or generation differs from the ticket. It does not re-run the Session and Workspace grant checks; the upgrade still relies on the admission done when the ticket was issued.

## 4. Design decisions

| Decision              | Choice                                      | Rationale                                                                                                                  |
| --------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Ticket at rest        | SHA-256 hash only                           | A database read never yields a usable ticket.                                                                              |
| Binding in the ticket | Identity and generation, re-read at upgrade | The lease token must not be persisted; a changed binding now fails closed instead of connecting to a stale lease.          |
| Clock                 | Database time (`ManagedSchemaTime.SQL_NOW`) | Instance clock skew cannot extend or cut short a ticket.                                                                   |
| Caps                  | Counted in SQL, not serialized              | Cluster-wide bound; concurrent issuers may overshoot by at most the number of concurrent requests, which is still bounded. |
| Expired rows          | Swept by each issue                         | No new scheduler; leftover rows are bounded by the caps.                                                                   |
| Store placement       | Stays in `server` as a concrete class       | Single consumer; no interface for one use.                                                                                 |

## 5. Risks and constraints

- Capacity is now a soft bound under concurrency, as described above; previously it was exact per process but multiplied by the number of instances.
- A ticket now survives a control-plane restart for the rest of its 30 seconds. The upgrade re-checks the web-terminal opt-in and the binding, so a restart that disables the terminal or replaces the binding still refuses it.
- Every mint and upgrade now costs a few indexed statements on the shared database.

## 6. Validation and acceptance

- H2: tickets are consumed exactly once, including by a second store on the same database; only the hash is stored; expiry follows database time; issuing sweeps expired rows; per-tenant and overall caps return typed 503s.
- Upgrade: a changed binding and a binding that no longer admits a terminal are refused with 409; existing path, terminal and ticket checks still return 400, 401 and 404.
- Real MySQL 8.4 (`TerminalTicketStoreMySqlIT`): a ticket offered to many instances at once admits one upgrade, and concurrent issuers sweeping expired rows never deadlock.
- Schema contract tests list the new table, its business key and its timestamp columns.
