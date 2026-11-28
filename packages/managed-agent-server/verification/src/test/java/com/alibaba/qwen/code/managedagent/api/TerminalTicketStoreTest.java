package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * A terminal ticket is a single-use, short-lived carrier of one admission; it
 * must never be replayable or outlive its upgrade window, and any instance
 * sharing the database must be able to consume it.
 */
class TerminalTicketStoreTest {
    private JdbcTemplate jdbc;
    private TerminalTicketStore store;

    @BeforeEach
    void setUp() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:terminal-ticket-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        store = new TerminalTicketStore(jdbc);
    }

    private static TerminalTicketStore.Admission admission(String tenant, int i) {
        return new TerminalTicketStore.Admission(tenant, "session-" + i, "term-" + i,
                "binding-" + i, 7L);
    }

    @Test
    void consumesATicketExactlyOnceWithItsAdmission() {
        TerminalTicketStore.Admission admitted = admission("tenant", 1);
        String ticket = store.issue(admitted);
        assertThat(store.consume(ticket)).isEqualTo(admitted);
        assertThat(store.consume(ticket)).isNull();
    }

    @Test
    void anotherStoreOnTheSameDatabaseConsumesTheTicket() {
        String ticket = store.issue(admission("tenant", 1));
        assertThat(new TerminalTicketStore(jdbc).consume(ticket)).isNotNull();
        assertThat(store.consume(ticket)).isNull();
    }

    @Test
    void storesOnlyTheTicketHash() {
        String ticket = store.issue(admission("tenant", 1));
        assertThat(jdbc.queryForObject("SELECT ticket_hash FROM ma_terminal_ticket", String.class))
                .isEqualTo(DigestUtils.sha256Hex(ticket));
    }

    @Test
    void rejectsAnUnknownTicket() {
        assertThat(store.consume("not-a-ticket")).isNull();
        assertThat(store.consume(null)).isNull();
        assertThat(store.consume("")).isNull();
    }

    @Test
    void expiresAfterTheUpgradeWindowByDatabaseTime() {
        String ticket = store.issue(admission("tenant", 1));
        long deadline = jdbc.queryForObject("SELECT expires_at - gmt_create FROM ma_terminal_ticket", Long.class);
        assertThat(deadline).isEqualTo(TerminalTicketStore.TTL.toMillis());
        jdbc.update("UPDATE ma_terminal_ticket SET expires_at = 1");
        assertThat(store.consume(ticket)).isNull();
    }

    @Test
    void issuingSweepsExpiredTickets() {
        store.issue(admission("tenant", 1));
        jdbc.update("UPDATE ma_terminal_ticket SET expires_at = 1");
        store.issue(admission("tenant", 2));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_terminal_ticket", Long.class))
                .isEqualTo(1L);
    }

    @Test
    void issuedTicketsAreDistinct() {
        assertThat(store.issue(admission("tenant", 1)))
                .isNotEqualTo(store.issue(admission("tenant", 1)));
    }

    @Test
    void capacityRefusalIsTypedAndPerTenant() {
        for (int i = 0; i < 256; i += 1) {
            store.issue(admission("tenant", i));
        }
        // One tenant holding its share must get a typed 503, not an untyped 500.
        assertThatThrownBy(() -> store.issue(admission("tenant", 256)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(503);
                    assertThat(error.getCode()).isEqualTo("terminal_ticket_capacity");
                });
        // Another tenant can still mint within the overall budget.
        assertThat(store.issue(admission("other", 0))).isNotNull();
    }

    @Test
    void overallCapacityRefusalIsTyped() {
        for (int t = 0; t < 4; t += 1) {
            for (int i = 0; i < 256; i += 1) {
                store.issue(admission("tenant-" + t, i));
            }
        }
        assertThatThrownBy(() -> store.issue(admission("tenant-4", 0)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(503);
                    assertThat(error.getCode()).isEqualTo("terminal_ticket_capacity");
                });
    }
}
