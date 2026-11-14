package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;

import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Short-lived, single-use tickets that carry a terminal admission from an
 * authenticated HTTP request to the WebSocket upgrade. Browsers cannot set the
 * deployment's authentication headers on a WebSocket, so the caller first
 * obtains a ticket over the normal authenticated surface and then offers it as
 * the upgrade's bearer subprotocol. A ticket is bound to one Session, terminal
 * and admitted binding, expires quickly and is consumed on first use, so it
 * never becomes a long-lived credential.
 */
public final class TerminalTicketStore {
    /** A ticket lives only long enough to complete one upgrade. */
    static final Duration TTL = Duration.ofSeconds(30);
    /** Bounds memory even if a caller mints tickets without upgrading. */
    private static final int MAX_LIVE_TICKETS = 1024;
    /** Per-tenant share of the budget, so one tenant cannot deny minting to
     * every other tenant by holding the whole process-wide cap. */
    private static final int MAX_LIVE_TICKETS_PER_TENANT = 256;

    /** The admission a ticket carries to the upgrade. */
    public record Admission(String tenantId, String actorId, String sessionId,
            String terminalId, RuntimeBindingRecord binding) {
    }

    private record Entry(Admission admission, Instant expiresAt) {
    }

    private final Map<String, Entry> tickets = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();
    private final Clock clock;

    public TerminalTicketStore(Clock clock) {
        this.clock = clock;
    }

    /** Mints a ticket for an already-admitted terminal attach. Capacity
     * refusals are typed (503) rather than an untyped 500, and a per-tenant
     * share keeps one tenant from exhausting the process-wide budget. The
     * evict/check/put sequence is serialized so the cap cannot be raced. */
    public synchronized String issue(Admission admission) {
        evictExpired();
        if (tickets.size() >= MAX_LIVE_TICKETS) {
            throw new ManagedAgentException(503, "terminal_ticket_capacity",
                    "Too many live terminal tickets; retry shortly.");
        }
        long tenantLive = tickets.values().stream()
                .filter(entry -> entry.admission().tenantId().equals(admission.tenantId()))
                .count();
        if (tenantLive >= MAX_LIVE_TICKETS_PER_TENANT) {
            throw new ManagedAgentException(503, "terminal_ticket_capacity",
                    "Too many live terminal tickets for this tenant; retry shortly.");
        }
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String ticket = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        tickets.put(ticket, new Entry(admission, clock.instant().plus(TTL)));
        return ticket;
    }

    /** Consumes a ticket once; null when unknown, expired or already used. */
    public Admission consume(String ticket) {
        if (ticket == null || ticket.isEmpty()) {
            return null;
        }
        Entry entry = tickets.remove(ticket);
        if (entry == null || entry.expiresAt().isBefore(clock.instant())) {
            return null;
        }
        return entry.admission();
    }

    private void evictExpired() {
        Instant now = clock.instant();
        Iterator<Map.Entry<String, Entry>> it = tickets.entrySet().iterator();
        while (it.hasNext()) {
            if (it.next().getValue().expiresAt().isBefore(now)) {
                it.remove();
            }
        }
    }
}
