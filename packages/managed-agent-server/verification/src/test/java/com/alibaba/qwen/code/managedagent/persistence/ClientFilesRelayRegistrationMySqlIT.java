package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Binding;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Concurrent first registrations under real InnoDB. Without the Session-root
 * record lock, two tabs registering a Session with no binding row both take
 * non-conflicting gap locks on the absent row and their INSERTs deadlock
 * (error 1213), surfacing as a 500 instead of a registration. The H2 suite
 * cannot reproduce the gap-lock deadlock, so only MySQL witnesses the fix:
 * every concurrent registration must return, and the generations must be
 * exactly 1..N with no lost update.
 */
class ClientFilesRelayRegistrationMySqlIT {
    private static final String TENANT = "tenant-cf-register";
    private static final String SESSION = "session-cf-register";
    private static final String ACTOR = "operator";

    private IsolatedManagedSchemaMySqlTestDatabase database;
    private JdbcTemplate jdbc;
    private TransactionTemplate transactions;
    private ClientFilesRelayStore store;

    @BeforeEach
    void setUp() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        ManagedSchema.initialize(database.source());
        jdbc = new ManagedSchemaJdbcTemplate(database.source());
        transactions = new TransactionTemplate(new DataSourceTransactionManager(database.source()));
        store = new ClientFilesRelayStore(jdbc);
        // The service only registers sessions it has already resolved, so the
        // Session root row exists; the registration locks it to serialize.
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, gmt_create, gmt_modified)"
                + " VALUES (?, ?, 'qwen-code', 0, 0)", TENANT, SESSION);
    }

    @AfterEach
    void cleanUp() {
        if (database != null) {
            database.close();
        }
    }

    @Test
    @Timeout(60)
    void concurrentFirstRegistrationsSerializeWithoutDeadlock() throws Exception {
        int threads = 8;
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(threads);
        List<Long> generations = Collections.synchronizedList(new ArrayList<>());
        List<Throwable> errors = Collections.synchronizedList(new ArrayList<>());
        for (int i = 0; i < threads; i++) {
            String tokenHash = Integer.toHexString(i + 1).repeat(64).substring(0, 64);
            String connectionId = "conn-" + i;
            Thread.startVirtualThread(() -> {
                try {
                    start.await();
                    Binding binding = transactions.execute(status ->
                            store.registerCapturingPrevious(TENANT, SESSION, ACTOR, "local-files",
                                    tokenHash, 9_000L, 1_000L, connectionId).binding());
                    generations.add(binding.generation());
                } catch (Throwable error) {
                    errors.add(error);
                } finally {
                    done.countDown();
                }
            });
        }
        start.countDown();
        assertThat(done.await(45, TimeUnit.SECONDS)).isTrue();
        assertThat(errors).isEmpty();
        assertThat(generations).hasSize(threads);
        Collections.sort(generations);
        assertThat(generations).containsExactly(1L, 2L, 3L, 4L, 5L, 6L, 7L, 8L);
        // The surviving binding is the last generation, still active.
        Binding current = transactions.execute(status -> store.find(TENANT, SESSION));
        assertThat(current.generation()).isEqualTo((long) threads);
        assertThat(current.active()).isTrue();
    }
}
