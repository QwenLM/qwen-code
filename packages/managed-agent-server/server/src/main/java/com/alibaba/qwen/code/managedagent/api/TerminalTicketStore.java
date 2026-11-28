package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.jdbc.core.JdbcTemplate;

import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.List;

/**
 * Short-lived, single-use tickets that carry a terminal admission from an
 * authenticated HTTP request to the WebSocket upgrade. Browsers cannot set the
 * deployment's authentication headers on a WebSocket, so the caller first
 * obtains a ticket over the normal authenticated surface and then offers it as
 * the upgrade's bearer subprotocol. A ticket is bound to one Session, terminal
 * and admitted binding, expires quickly and is consumed on first use, so it
 * never becomes a long-lived credential.
 *
 * <p>Tickets live in SQL so the upgrade may reach a different control-plane
 * instance than the one that issued it. Only the ticket's hash is stored, and
 * the binding is named by identity rather than persisted with its lease token.
 * Deadlines use the database clock, never an instance clock.
 */
public final class TerminalTicketStore {
    /** A ticket lives only long enough to complete one upgrade. */
    static final Duration TTL = Duration.ofSeconds(30);
    /** Bounds the table even if callers mint tickets without upgrading. */
    private static final int MAX_LIVE_TICKETS = 1024;
    /** Per-tenant share of the budget, so one tenant cannot deny minting to
     * every other tenant by holding the whole budget. */
    private static final int MAX_LIVE_TICKETS_PER_TENANT = 256;
    private static final String NOW = ManagedSchemaTime.SQL_NOW;

    /** The admission a ticket carries to the upgrade. */
    public record Admission(String tenantId, String sessionId,
            String terminalId, String bindingId, long bindingGeneration) {
    }

    private final JdbcTemplate jdbc;
    private final SecureRandom random = new SecureRandom();

    public TerminalTicketStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Mints a ticket for an already-admitted terminal attach. Capacity
     * refusals are typed (503) rather than an untyped 500. Each statement
     * commits on its own, so the sweep's range locks are never held while
     * another issuer inserts; concurrent issuers may each pass the check, so
     * the caps bound growth rather than hold an exact count. */
    public String issue(Admission admission) {
        jdbc.update("DELETE FROM ma_terminal_ticket WHERE expires_at <= " + NOW);
        long[] live = jdbc.queryForObject("SELECT COUNT(*),"
                        + " COALESCE(SUM(CASE WHEN tenant_id = ? THEN 1 ELSE 0 END), 0)"
                        + " FROM ma_terminal_ticket WHERE expires_at > " + NOW,
                (row, index) -> new long[] {row.getLong(1), row.getLong(2)},
                admission.tenantId());
        if (live[0] >= MAX_LIVE_TICKETS) {
            throw new ManagedAgentException(503, "terminal_ticket_capacity",
                    "Too many live terminal tickets; retry shortly.");
        }
        if (live[1] >= MAX_LIVE_TICKETS_PER_TENANT) {
            throw new ManagedAgentException(503, "terminal_ticket_capacity",
                    "Too many live terminal tickets for this tenant; retry shortly.");
        }
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String ticket = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        jdbc.update("INSERT INTO ma_terminal_ticket (ticket_hash, tenant_id, session_id,"
                        + " terminal_id, binding_id, binding_generation, expires_at, gmt_create)"
                        + " VALUES (?, ?, ?, ?, ?, ?, " + NOW + " + ?, " + NOW + ")",
                DigestUtils.sha256Hex(ticket), admission.tenantId(), admission.sessionId(),
                admission.terminalId(), admission.bindingId(), admission.bindingGeneration(),
                TTL.toMillis());
        return ticket;
    }

    /** Consumes a ticket once; null when unknown, expired or already used.
     * Rows are never updated, so the admission read before the delete is the
     * one the winning delete consumed. */
    public Admission consume(String ticket) {
        if (ticket == null || ticket.isEmpty()) {
            return null;
        }
        String hash = DigestUtils.sha256Hex(ticket);
        List<Admission> found = jdbc.query("SELECT tenant_id, session_id, terminal_id,"
                        + " binding_id, binding_generation FROM ma_terminal_ticket"
                        + " WHERE ticket_hash = ?",
                (row, index) -> new Admission(row.getString(1), row.getString(2),
                        row.getString(3), row.getString(4), row.getLong(5)),
                hash);
        if (found.isEmpty()) {
            return null;
        }
        int consumed = jdbc.update("DELETE FROM ma_terminal_ticket WHERE ticket_hash = ?"
                + " AND expires_at > " + NOW, hash);
        return consumed == 1 ? found.getFirst() : null;
    }
}
