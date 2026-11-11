package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.Binding;
import com.alibaba.qwen.code.managedagent.contracts.clientfiles.ClientFilesModels.QueuedRequest;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ClientFilesRelayStoreTest {
    private JdbcTemplate jdbc;
    private ClientFilesRelayStore store;
    private TransactionTemplate transactions;
    private String tenant;
    private final String session = "session";
    private final String actor = "actor";

    @BeforeEach
    void setup() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:client-files-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=10000");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
        store = new ClientFilesRelayStore(jdbc);
        tenant = "tenant-" + UUID.randomUUID();
    }

    @Test
    void registerPersistsOnlyTheTokenDigestAndFindReadsItBack() {
        String tokenHash = "a".repeat(64);
        Binding binding = tx(() -> store.register(tenant, session, actor, "local-files", tokenHash, 9_000L, 1_000L, "conn"));
        assertThat(binding.generation()).isEqualTo(1L);
        assertThat(binding.active()).isTrue();
        Binding read = tx(() -> store.find(tenant, session));
        assertThat(read).isEqualTo(binding);
        assertThat(jdbc.queryForObject("SELECT token_hash FROM ma_client_files_binding", String.class))
                .isEqualTo(tokenHash);
    }

    @Test
    void findBySessionResolvesTheBindingWithoutTheTenant() {
        Binding binding = tx(() -> store.register(tenant, session, actor, "local-files",
                "a".repeat(64), 9_000L, 1_000L, "conn"));
        assertThat(tx(() -> store.findBySession(session))).isEqualTo(binding);
        assertThat(tx(() -> store.findBySession("missing"))).isNull();
    }

    @Test
    void concurrentRegistrationsAdvanceGenerationsWithoutLostUpdates() throws Exception {
        int threads = 8;
        var start = new java.util.concurrent.CountDownLatch(1);
        var done = new java.util.concurrent.CountDownLatch(threads);
        var generations = java.util.Collections.synchronizedList(new java.util.ArrayList<Long>());
        var errors = java.util.Collections.synchronizedList(new java.util.ArrayList<Throwable>());
        for (int i = 0; i < threads; i++) {
            String tokenHash = Integer.toHexString(i + 1).repeat(64).substring(0, 64);
            Thread.startVirtualThread(() -> {
                try {
                    start.await();
                    Binding binding = tx(() -> store.register(tenant, session, actor, "local-files",
                            tokenHash, 9_000L, 1_000L, "conn"));
                    generations.add(binding.generation());
                } catch (Throwable error) {
                    errors.add(error);
                } finally {
                    done.countDown();
                }
            });
        }
        start.countDown();
        assertThat(done.await(30, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        assertThat(errors).isEmpty();
        assertThat(generations).hasSize(threads);
        assertThat(new java.util.HashSet<>(generations)).hasSize(threads);
        assertThat(tx(() -> store.find(tenant, session)).generation()).isEqualTo(threads);
    }

    @Test
    void reRegisterAdvancesTheGenerationAndKeepsCreationTime() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L, "conn"));
        Binding second = tx(() -> store.register(tenant, session, "actor-2", "local-files", "b".repeat(64), 19_000L, 2_000L, "conn"));
        assertThat(second.generation()).isEqualTo(2L);
        assertThat(second.actorId()).isEqualTo("actor-2");
        assertThat(second.tokenHash()).isEqualTo("b".repeat(64));
        assertThat(second.createdAt()).isEqualTo(1_000L);
        assertThat(second.modifiedAt()).isEqualTo(2_000L);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_binding", Integer.class)).isEqualTo(1);
    }

    @Test
    void closeFencesStaleGenerationsAndIsIdempotentOnlyForTheOwner() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L, "conn"));
        tx(() -> store.register(tenant, session, actor, "local-files", "b".repeat(64), 19_000L, 2_000L, "conn"));
        assertThat(tx(() -> store.close(tenant, session, 1L, 3_000L))).isFalse();
        assertThat(tx(() -> store.find(tenant, session)).active()).isTrue();
        assertThat(tx(() -> store.close(tenant, session, 2L, 3_000L))).isTrue();
        assertThat(tx(() -> store.close(tenant, session, 2L, 4_000L))).isFalse();
        assertThat(tx(() -> store.find(tenant, session)).state()).isEqualTo(ClientFilesModels.STATE_CLOSED);
    }

    @Test
    void enqueueOrdersRequestsAndRejectsDuplicateIdentities() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L, "conn"));
        tx(() -> store.enqueue(tenant, session, 1L, "req-1", "{\"id\":\"req-1\"}", 9_000L, 1_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "req-2", "{\"id\":\"req-2\"}", 9_000L, 1_100L));
        assertThat(tx(() -> store.queuedCount(tenant, session, 1L, 2_000L))).isEqualTo(2);
        List<QueuedRequest> queued = tx(() -> store.queued(tenant, session, 1L, 10, 2_000L));
        assertThat(queued).extracting(QueuedRequest::requestId).containsExactly("req-1", "req-2");
        assertThatThrownBy(() -> tx(() -> store.enqueue(tenant, session, 1L, "req-1", "{}", 9_000L, 1_200L)))
                .isInstanceOf(DuplicateKeyException.class);
    }

    @Test
    void answerAndFailOnlyConsumeQueuedRequests() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L, "conn"));
        tx(() -> store.enqueue(tenant, session, 1L, "req-1", "{}", 9_000L, 1_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "req-2", "{}", 9_000L, 1_000L));
        assertThat(tx(() -> store.answer(tenant, session, 1L, "req-1", "{\"ok\":true}", 2_000L))).isTrue();
        assertThat(tx(() -> store.answer(tenant, session, 1L, "req-1", "{\"ok\":false}", 2_100L))).isFalse();
        assertThat(tx(() -> store.fail(tenant, session, 1L, "req-2", ClientFilesModels.ERROR_OFFLINE, 2_200L))).isTrue();
        assertThat(tx(() -> store.queuedCount(tenant, session, 1L, 2_000L))).isZero();
        assertThat(jdbc.queryForObject("SELECT response_json FROM ma_client_files_request WHERE request_id='req-1'",
                String.class)).isEqualTo("{\"ok\":true}");
        assertThat(jdbc.queryForObject("SELECT error_code FROM ma_client_files_request WHERE request_id='req-2'",
                String.class)).isEqualTo(ClientFilesModels.ERROR_OFFLINE);
    }

    @Test
    void failQueuedTearsDownOnlyTheOwnedGeneration() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L, "conn"));
        tx(() -> store.enqueue(tenant, session, 1L, "req-1", "{}", 9_000L, 1_000L));
        tx(() -> store.register(tenant, session, actor, "local-files", "b".repeat(64), 19_000L, 2_000L, "conn"));
        tx(() -> store.enqueue(tenant, session, 2L, "req-2", "{}", 19_000L, 2_000L));
        assertThat(tx(() -> store.failQueued(tenant, session, 1L, ClientFilesModels.ERROR_OFFLINE, 3_000L))).isEqualTo(1);
        assertThat(tx(() -> store.queuedCount(tenant, session, 2L, 3_000L))).isEqualTo(1);
    }

    @Test
    void expireBeforeSweepsOnlyOverdueQueuedRequestsBoundedByLimit() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L, "conn"));
        tx(() -> store.enqueue(tenant, session, 1L, "req-1", "{}", 1_500L, 1_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "req-2", "{}", 1_600L, 1_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "req-3", "{}", 9_000L, 1_000L));
        tx(() -> store.answer(tenant, session, 1L, "req-3", "{}", 1_200L));
        assertThat(tx(() -> store.expireBefore(2_000L, 1))).isEqualTo(1);
        assertThat(tx(() -> store.expireBefore(2_000L, 10))).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_request WHERE request_id='req-3'",
                String.class)).isEqualTo(ClientFilesModels.REQUEST_ANSWERED);
        assertThat(tx(() -> store.queuedCount(tenant, session, 1L, 2_000L))).isZero();
    }

    @Test
    void queuedCountExcludesExpiredButUnwalkedRows() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L, "conn"));
        tx(() -> store.enqueue(tenant, session, 1L, "req-1", "{}", 1_500L, 1_000L));
        // Still state=queued (the sweep has not run), but past its deadline: it
        // must not occupy a queue slot.
        assertThat(tx(() -> store.queuedCount(tenant, session, 1L, 2_000L))).isZero();
        assertThat(tx(() -> store.queuedCount(tenant, session, 1L, 1_000L))).isEqualTo(1);
    }

    @Test
    void closeExpiredBindingsClosesOnlyOverdueActiveBindings() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 5_000L, 1_000L, "conn"));
        tx(() -> store.register(tenant, "session-2", actor, "local-files", "b".repeat(64), 20_000L, 1_000L, "conn"));
        assertThat(tx(() -> store.closeExpiredBindings(10_000L, 10))).isEqualTo(1);
        assertThat(tx(() -> store.find(tenant, session)).state()).isEqualTo(ClientFilesModels.STATE_CLOSED);
        assertThat(tx(() -> store.find(tenant, "session-2")).state()).isEqualTo(ClientFilesModels.STATE_ACTIVE);
        // Idempotent: a closed binding is not counted again.
        assertThat(tx(() -> store.closeExpiredBindings(10_000L, 10))).isZero();
    }

    @Test
    void deleteSettledBeforeDropsOnlyOldSettledRows() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L, "conn"));
        tx(() -> store.enqueue(tenant, session, 1L, "answered", "{}", 9_000L, 1_000L));
        tx(() -> store.answer(tenant, session, 1L, "answered", "{}", 1_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "failed", "{}", 9_000L, 1_000L));
        tx(() -> store.fail(tenant, session, 1L, "failed", ClientFilesModels.ERROR_OFFLINE, 1_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "recent", "{}", 9_000L, 1_000L));
        tx(() -> store.answer(tenant, session, 1L, "recent", "{}", 8_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "queued", "{}", 9_000L, 1_000L));
        // Cutoff 5_000: the rows settled at 1_000 go; the row settled at 8_000
        // and the still-queued row stay.
        assertThat(tx(() -> store.deleteSettledBefore(5_000L, 10))).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_request", Integer.class))
                .isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_request WHERE request_id='queued'",
                Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_request WHERE request_id='recent'",
                Integer.class)).isEqualTo(1);
    }

    @Test
    void deleteSessionRemovesBothTablesForTheScopeOnly() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L, "conn"));
        tx(() -> store.enqueue(tenant, session, 1L, "req-1", "{}", 9_000L, 1_000L));
        tx(() -> store.register(tenant, "session-2", actor, "local-files", "b".repeat(64), 9_000L, 1_000L, "conn"));
        // The surviving scope has its own in-flight request, so the request-table
        // delete must be scope-fenced too — an unscoped delete would destroy it
        // while a zero-count assertion could not tell the difference.
        tx(() -> store.enqueue(tenant, "session-2", 1L, "req-2", "{}", 9_000L, 1_000L));
        tx(() -> store.deleteSession(tenant, session));
        assertThat(tx(() -> store.find(tenant, session))).isNull();
        assertThat(tx(() -> store.find(tenant, "session-2"))).isNotNull();
        assertThat(jdbc.queryForObject("SELECT request_id FROM ma_client_files_request", String.class))
                .isEqualTo("req-2");
    }

    @Test
    void requestKeyIsGenerationScopedSoRestartedIdsDoNotCollide() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L, "conn"));
        tx(() -> store.enqueue(tenant, session, 1L, "0", "{\"gen\":1}", 9_000L, 1_000L));
        tx(() -> store.register(tenant, session, actor, "local-files", "b".repeat(64), 19_000L, 2_000L, "conn"));
        // A re-registered Harness restarts its JSON-RPC ids: "0" must land in a
        // new row, not attach to the previous generation's row, and a read by
        // generation must return that generation's payload.
        tx(() -> store.enqueue(tenant, session, 2L, "0", "{\"gen\":2}", 19_000L, 2_000L));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_request WHERE request_id='0'",
                Integer.class)).isEqualTo(2);
        assertThat(tx(() -> store.request(tenant, session, 2L, "0")).payloadJson()).isEqualTo("{\"gen\":2}");
        assertThat(tx(() -> store.request(tenant, session, 1L, "0")).payloadJson()).isEqualTo("{\"gen\":1}");
    }

    @Test
    void tenantsSharingASessionIdStayIsolated() {
        String otherTenant = "tenant-" + UUID.randomUUID();
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L, "conn"));
        tx(() -> store.register(otherTenant, session, actor, "local-files", "b".repeat(64), 9_000L, 1_000L, "conn"));
        assertThat(tx(() -> store.find(tenant, session)).tokenHash()).isEqualTo("a".repeat(64));
        assertThat(tx(() -> store.find(otherTenant, session)).tokenHash()).isEqualTo("b".repeat(64));
        assertThat(tx(() -> store.close(tenant, session, 1L, 2_000L))).isTrue();
        assertThat(tx(() -> store.find(otherTenant, session)).active()).isTrue();
    }

    @Test
    void expiredRequestsAreNeitherDeliveredNorSettled() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L, "conn"));
        tx(() -> store.enqueue(tenant, session, 1L, "req-1", "{}", 1_500L, 1_000L));
        // Past the deadline but before the sweep flips the row: a resumed
        // downlink must not receive the work, and a late answer must not settle
        // it (the Runtime has already been told it failed).
        assertThat(tx(() -> store.queued(tenant, session, 1L, 10, 2_000L))).isEmpty();
        assertThat(tx(() -> store.answer(tenant, session, 1L, "req-1", "{}", 2_000L))).isFalse();
        assertThat(tx(() -> store.fail(tenant, session, 1L, "req-1", ClientFilesModels.ERROR_OFFLINE, 2_000L))).isFalse();
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_request WHERE request_id='req-1'",
                String.class)).isEqualTo(ClientFilesModels.REQUEST_QUEUED);
    }

    @Test
    void restoreIsFencedAndRewindsToTheConnectedGeneration() {
        Binding first = tx(() -> store.register(tenant, session, actor, "local-files",
                "a".repeat(64), 9_000L, 1_000L, "conn-a"));
        Binding failed = tx(() -> store.register(tenant, session, actor, "local-files",
                "b".repeat(64), 19_000L, 2_000L, "conn-b"));
        assertThat(failed.generation()).isEqualTo(2L);
        // The failed attempt left a request row in its own generation.
        tx(() -> store.enqueue(tenant, session, 2L, "0", "{}", 19_000L, 2_000L));
        // Compensation rewinds to the generation the previous client's downlink
        // was opened with (so it keeps draining) and drops the failed attempt's
        // request rows (so the next registration re-allocating that generation
        // does not attach to them).
        assertThat(tx(() -> store.restore(tenant, session, 2L, first, 3_000L))).isTrue();
        Binding restored = tx(() -> store.find(tenant, session));
        assertThat(restored.generation()).isEqualTo(first.generation());
        assertThat(restored.tokenHash()).isEqualTo("a".repeat(64));
        assertThat(restored.connectionId()).isEqualTo("conn-a");
        assertThat(restored.active()).isTrue();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_request"
                + " WHERE binding_generation=2", Integer.class)).isZero();
        // A late compensation for the same failed attempt is a no-op: the
        // binding no longer sits at that generation.
        assertThat(tx(() -> store.restore(tenant, session, 2L, first, 4_000L))).isFalse();
        assertThat(tx(() -> store.find(tenant, session)).generation()).isEqualTo(first.generation());
    }

    @Test
    void restoreDoesNotReopenARevokedBindingOrClobberANewerRegistration() {
        Binding first = tx(() -> store.register(tenant, session, actor, "local-files",
                "a".repeat(64), 9_000L, 1_000L, "conn-a"));
        tx(() -> store.register(tenant, session, actor, "local-files",
                "b".repeat(64), 19_000L, 2_000L, "conn-b"));
        // An unregister committed after the failed attempt: compensation must
        // not reopen the revoked binding.
        tx(() -> store.close(tenant, session, 2L, 3_000L));
        assertThat(tx(() -> store.restore(tenant, session, 2L, first, 4_000L))).isFalse();
        assertThat(tx(() -> store.find(tenant, session)).active()).isFalse();
        // A newer registration committed after the failed attempt: compensation
        // must not clobber its credential.
        tx(() -> store.register(tenant, session, actor, "local-files",
                "c".repeat(64), 29_000L, 5_000L, "conn-c"));
        assertThat(tx(() -> store.restore(tenant, session, 2L, first, 6_000L))).isFalse();
        assertThat(tx(() -> store.find(tenant, session)).tokenHash()).isEqualTo("c".repeat(64));
    }

    private <T> T tx(Supplier<T> work) {
        return transactions.execute(status -> work.get());
    }

    private void tx(Runnable work) {
        transactions.executeWithoutResult(status -> work.run());
    }
}
