package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * A terminal ticket is a single-use, short-lived carrier of one admission; it
 * must never be replayable or outlive its upgrade window.
 */
class TerminalTicketStoreTest {
    private static final class MutableClock extends Clock {
        private Instant now = Instant.parse("2026-11-10T00:00:00Z");

        @Override
        public ZoneOffset getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }

        void advance(Duration duration) {
            now = now.plus(duration);
        }
    }

    private static TerminalTicketStore.Admission admission() {
        return new TerminalTicketStore.Admission("tenant", "actor", "session-a",
                "term-1", null);
    }

    @Test
    void consumesATicketExactlyOnce() {
        TerminalTicketStore store = new TerminalTicketStore(new MutableClock());
        String ticket = store.issue(admission());
        assertThat(store.consume(ticket)).isNotNull();
        assertThat(store.consume(ticket)).isNull();
    }

    @Test
    void rejectsAnUnknownTicket() {
        TerminalTicketStore store = new TerminalTicketStore(new MutableClock());
        assertThat(store.consume("not-a-ticket")).isNull();
        assertThat(store.consume(null)).isNull();
        assertThat(store.consume("")).isNull();
    }

    @Test
    void expiresAfterTheUpgradeWindow() {
        MutableClock clock = new MutableClock();
        TerminalTicketStore store = new TerminalTicketStore(clock);
        String ticket = store.issue(admission());
        clock.advance(TerminalTicketStore.TTL.plusSeconds(1));
        assertThat(store.consume(ticket)).isNull();
    }

    @Test
    void issuedTicketsAreDistinct() {
        TerminalTicketStore store = new TerminalTicketStore(new MutableClock());
        String first = store.issue(admission());
        String second = store.issue(admission());
        assertThat(first).isNotEqualTo(second);
    }

    @Test
    void capacityRefusalIsTypedAndPerTenant() {
        TerminalTicketStore store = new TerminalTicketStore(new MutableClock());
        for (int i = 0; i < 256; i += 1) {
            store.issue(new TerminalTicketStore.Admission("tenant", "actor",
                    "session-" + i, "term-" + i, null));
        }
        // One tenant holding its share must get a typed 503, not an untyped 500.
        assertThatThrownBy(() -> store.issue(admission()))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(503);
                    assertThat(error.getCode()).isEqualTo("terminal_ticket_capacity");
                });
        // Another tenant can still mint within the process-wide budget.
        assertThat(store.issue(new TerminalTicketStore.Admission("other", "actor",
                "session-x", "term-x", null))).isNotNull();
    }
}
