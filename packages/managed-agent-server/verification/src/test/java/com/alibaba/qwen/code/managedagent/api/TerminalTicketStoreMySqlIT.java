package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.IntFunction;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Terminal tickets under real InnoDB, where control-plane instances share one
 * database. A ticket offered to several instances at once must admit exactly
 * one upgrade, and concurrent issuers, each sweeping expired rows through the
 * expiry index, must never deadlock on its gap locks. H2 cannot reproduce
 * either race.
 */
class TerminalTicketStoreMySqlIT {
    private static final int THREADS = 12;

    private IsolatedManagedSchemaMySqlTestDatabase database;
    private JdbcTemplate jdbc;

    @BeforeEach
    void setUp() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        ManagedSchema.initialize(database.source());
        jdbc = new ManagedSchemaJdbcTemplate(database.source());
    }

    @AfterEach
    void cleanUp() {
        if (database != null) {
            database.close();
        }
    }

    private static TerminalTicketStore.Admission admission(int i) {
        return new TerminalTicketStore.Admission("tenant", "session-" + i, "term-" + i,
                "binding-" + i, 1L);
    }

    @Test
    @Timeout(60)
    void aTicketOfferedToManyInstancesAdmitsOneUpgrade() throws Exception {
        String ticket = new TerminalTicketStore(jdbc).issue(admission(1));
        List<Object> results = race(i -> new TerminalTicketStore(jdbc).consume(ticket));
        assertThat(results).filteredOn(result -> result instanceof TerminalTicketStore.Admission)
                .containsExactly(admission(1));
        assertThat(results).filteredOn(result -> result instanceof Throwable).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_terminal_ticket", Long.class))
                .isZero();
    }

    @Test
    @Timeout(60)
    void concurrentIssuersSweepWithoutDeadlock() throws Exception {
        TerminalTicketStore seed = new TerminalTicketStore(jdbc);
        for (int i = 0; i < THREADS; i += 1) {
            seed.issue(admission(1000 + i));
        }
        jdbc.update("UPDATE ma_terminal_ticket SET expires_at = 1");
        List<Object> results = race(i -> new TerminalTicketStore(jdbc).issue(admission(i)));
        assertThat(results).filteredOn(result -> result instanceof Throwable).isEmpty();
        assertThat(new HashSet<>(results)).hasSize(THREADS);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_terminal_ticket"
                + " WHERE expires_at > 1", Long.class)).isEqualTo((long) THREADS);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_terminal_ticket"
                + " WHERE expires_at = 1", Long.class)).isZero();
    }

    private static List<Object> race(IntFunction<Object> work) throws InterruptedException {
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(THREADS);
        List<Object> results = Collections.synchronizedList(new ArrayList<>());
        for (int i = 0; i < THREADS; i += 1) {
            int index = i;
            Thread.startVirtualThread(() -> {
                try {
                    start.await();
                    Object result = work.apply(index);
                    results.add(result == null ? "refused" : result);
                } catch (Throwable error) {
                    results.add(error);
                } finally {
                    done.countDown();
                }
            });
        }
        start.countDown();
        assertThat(done.await(45, TimeUnit.SECONDS)).isTrue();
        return List.copyOf(results);
    }
}
