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
        Binding binding = tx(() -> store.register(tenant, session, actor, "local-files", tokenHash, 9_000L, 1_000L));
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
                "a".repeat(64), 9_000L, 1_000L));
        assertThat(tx(() -> store.findBySession(session))).isEqualTo(binding);
        assertThat(tx(() -> store.findBySession("missing"))).isNull();
    }

    @Test
    void reRegisterAdvancesTheGenerationAndKeepsCreationTime() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L));
        Binding second = tx(() -> store.register(tenant, session, "actor-2", "local-files", "b".repeat(64), 19_000L, 2_000L));
        assertThat(second.generation()).isEqualTo(2L);
        assertThat(second.actorId()).isEqualTo("actor-2");
        assertThat(second.tokenHash()).isEqualTo("b".repeat(64));
        assertThat(second.createdAt()).isEqualTo(1_000L);
        assertThat(second.modifiedAt()).isEqualTo(2_000L);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_binding", Integer.class)).isEqualTo(1);
    }

    @Test
    void closeFencesStaleGenerationsAndIsIdempotentOnlyForTheOwner() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L));
        tx(() -> store.register(tenant, session, actor, "local-files", "b".repeat(64), 19_000L, 2_000L));
        assertThat(tx(() -> store.close(tenant, session, 1L, 3_000L))).isFalse();
        assertThat(tx(() -> store.find(tenant, session)).active()).isTrue();
        assertThat(tx(() -> store.close(tenant, session, 2L, 3_000L))).isTrue();
        assertThat(tx(() -> store.close(tenant, session, 2L, 4_000L))).isFalse();
        assertThat(tx(() -> store.find(tenant, session)).state()).isEqualTo(ClientFilesModels.STATE_CLOSED);
    }

    @Test
    void enqueueOrdersRequestsAndRejectsDuplicateIdentities() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "req-1", "{\"id\":\"req-1\"}", 9_000L, 1_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "req-2", "{\"id\":\"req-2\"}", 9_000L, 1_100L));
        assertThat(tx(() -> store.queuedCount(tenant, session, 1L))).isEqualTo(2);
        List<QueuedRequest> queued = tx(() -> store.queued(tenant, session, 1L, 10));
        assertThat(queued).extracting(QueuedRequest::requestId).containsExactly("req-1", "req-2");
        assertThatThrownBy(() -> tx(() -> store.enqueue(tenant, session, 1L, "req-1", "{}", 9_000L, 1_200L)))
                .isInstanceOf(DuplicateKeyException.class);
    }

    @Test
    void answerAndFailOnlyConsumeQueuedRequests() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "req-1", "{}", 9_000L, 1_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "req-2", "{}", 9_000L, 1_000L));
        assertThat(tx(() -> store.answer(tenant, session, 1L, "req-1", "{\"ok\":true}", 2_000L))).isTrue();
        assertThat(tx(() -> store.answer(tenant, session, 1L, "req-1", "{\"ok\":false}", 2_100L))).isFalse();
        assertThat(tx(() -> store.fail(tenant, session, 1L, "req-2", ClientFilesModels.ERROR_OFFLINE, 2_200L))).isTrue();
        assertThat(tx(() -> store.queuedCount(tenant, session, 1L))).isZero();
        assertThat(jdbc.queryForObject("SELECT response_json FROM ma_client_files_request WHERE request_id='req-1'",
                String.class)).isEqualTo("{\"ok\":true}");
        assertThat(jdbc.queryForObject("SELECT error_code FROM ma_client_files_request WHERE request_id='req-2'",
                String.class)).isEqualTo(ClientFilesModels.ERROR_OFFLINE);
    }

    @Test
    void failQueuedTearsDownOnlyTheOwnedGeneration() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "req-1", "{}", 9_000L, 1_000L));
        tx(() -> store.register(tenant, session, actor, "local-files", "b".repeat(64), 19_000L, 2_000L));
        tx(() -> store.enqueue(tenant, session, 2L, "req-2", "{}", 19_000L, 2_000L));
        assertThat(tx(() -> store.failQueued(tenant, session, 1L, ClientFilesModels.ERROR_OFFLINE, 3_000L))).isEqualTo(1);
        assertThat(tx(() -> store.queuedCount(tenant, session, 2L))).isEqualTo(1);
    }

    @Test
    void expireBeforeSweepsOnlyOverdueQueuedRequestsBoundedByLimit() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "req-1", "{}", 1_500L, 1_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "req-2", "{}", 1_600L, 1_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "req-3", "{}", 9_000L, 1_000L));
        tx(() -> store.answer(tenant, session, 1L, "req-3", "{}", 1_200L));
        assertThat(tx(() -> store.expireBefore(2_000L, 1))).isEqualTo(1);
        assertThat(tx(() -> store.expireBefore(2_000L, 10))).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT state FROM ma_client_files_request WHERE request_id='req-3'",
                String.class)).isEqualTo(ClientFilesModels.REQUEST_ANSWERED);
        assertThat(tx(() -> store.queuedCount(tenant, session, 1L))).isZero();
    }

    @Test
    void deleteSessionRemovesBothTablesForTheScopeOnly() {
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L));
        tx(() -> store.enqueue(tenant, session, 1L, "req-1", "{}", 9_000L, 1_000L));
        tx(() -> store.register(tenant, "session-2", actor, "local-files", "b".repeat(64), 9_000L, 1_000L));
        tx(() -> store.deleteSession(tenant, session));
        assertThat(tx(() -> store.find(tenant, session))).isNull();
        assertThat(tx(() -> store.find(tenant, "session-2"))).isNotNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_client_files_request", Integer.class)).isZero();
    }

    @Test
    void tenantsSharingASessionIdStayIsolated() {
        String otherTenant = "tenant-" + UUID.randomUUID();
        tx(() -> store.register(tenant, session, actor, "local-files", "a".repeat(64), 9_000L, 1_000L));
        tx(() -> store.register(otherTenant, session, actor, "local-files", "b".repeat(64), 9_000L, 1_000L));
        assertThat(tx(() -> store.find(tenant, session)).tokenHash()).isEqualTo("a".repeat(64));
        assertThat(tx(() -> store.find(otherTenant, session)).tokenHash()).isEqualTo("b".repeat(64));
        assertThat(tx(() -> store.close(tenant, session, 1L, 2_000L))).isTrue();
        assertThat(tx(() -> store.find(otherTenant, session)).active()).isTrue();
    }

    private <T> T tx(Supplier<T> work) {
        return transactions.execute(status -> work.get());
    }

    private void tx(Runnable work) {
        transactions.executeWithoutResult(status -> work.run());
    }
}
