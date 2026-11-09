package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Item;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Query;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Result;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.memory.ManagedMemoryService;
import com.alibaba.qwen.code.managedagent.persistence.ManagedMemoryStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.time.Clock;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedMemoryStoreTest {
    private final ObjectMapper json = new ObjectMapper();
    private final String token = "synthetic-memory-writer-token-0123456789";
    private JdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private TransactionTemplate tx;
    private ManagedAgentProperties settings;
    private ManagedSessionStore sessions;
    private ManagedMemoryStore memory;
    private String tenant;
    private String session;
    private String personal;

    protected DataSource datasource() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:memory-" + UUID.randomUUID() + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        source.setUser("sa");
        return source;
    }

    @BeforeEach
    void setup() {
        DataSource source = datasource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        tx = new TransactionTemplate(manager);
        settings = new ManagedAgentProperties();
        settings.getMemory().setEnabled(true);
        settings.getSessionStore().setEnabled(true);
        sessions = VerificationFixtures.managedSessionStore(jdbc);
        memory = repository();
        tenant = "memory-" + UUID.randomUUID();
        session = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO ma_session (tenant_id,session_id,agent_id,creator_actor_key,owner_actor_key,gmt_create,gmt_modified)"
                        + " VALUES (?,?,'qwen-code',?,?,1,1)", tenant, session,
                ManagedWorkspaceRegistry.actorKey(tenant, "owner"), ManagedWorkspaceRegistry.actorKey(tenant, "owner"));
        jdbc.update("INSERT INTO ma_turn (tenant_id,session_id,turn_id,prompt_id,input_json,payload_digest,status,gmt_create,gmt_modified)"
                + " VALUES (?,?,'turn','prompt','[]',?,'RUNNING',1,1)", tenant, session, "sha256:" + "a".repeat(64));
        tx.execute(status -> sessions.acquireWriter(tenant, session, token, new AcquireWriterRequest("ws", "writer", 60000L)));
        personal = memory.create(tenant, "owner").id();
    }

    private ManagedMemoryStore repository() {
        return new ManagedMemoryStore(jdbc, json, Clock.systemUTC(), settings, sessions, manager);
    }

    private void bind() {
        tx.executeWithoutResult(status -> ManagedMemoryStore.bind(jdbc, tenant, "owner", session, personal));
    }

    private Query query(String operation, String call, String content, String id) {
        return new Query("ws", "writer", 1, operation, "prompt", call,
                "search".equals(operation) || "recall".equals(operation) ? "preference" : null,
                "remember".equals(operation) ? content : null, id, "forget".equals(operation) ? content : null);
    }

    @Test
    void onePersonalStorePerTenantActorAndNoImplicitBinding() {
        assertThat(memory.create(tenant, "owner").id()).isEqualTo(personal);
        String foreign = memory.create(tenant, "other").id();
        assertThat(foreign).isNotEqualTo(personal);
        assertThat(memory.create("other-" + tenant, "owner").id()).isNotEqualTo(personal);
        assertThat(memory.list(tenant, "owner")).extracting("id").containsExactly(personal);
        var service = new ManagedMemoryService(memory, (scope, request) -> { throw new AssertionError("Unexpected provider call"); });
        assertThat(service.query(tenant, session, token, new Query("ws", "writer", 1, "binding", null,
                null, null, null, null, null)).enabled()).isFalse();
        assertThatThrownBy(() -> tx.executeWithoutResult(status ->
                ManagedMemoryStore.bind(jdbc, tenant, "other", session, personal)))
                .isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> tx.executeWithoutResult(status ->
                ManagedMemoryStore.bind(jdbc, tenant, "other", session, foreign)))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(jdbc.queryForObject("SELECT owner_only FROM ma_session WHERE tenant_id=? AND session_id=?",
                Integer.class, tenant, session)).isZero();
    }

    @Test
    void executesOutsideTransactionThenPersistsResultAndReplaysWithoutWritingAgain() {
        bind();
        AtomicInteger calls = new AtomicInteger();
        var service = new ManagedMemoryService(memory, (scope, request) -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            assertThat(scope).startsWith("managed_").doesNotContain(tenant, "owner");
            calls.incrementAndGet();
            return Result.entry("stored", "entry-1", null);
        });
        Query request = query("remember", "call-1", "Use concise replies", null);
        assertThat(service.query(tenant, session, token, request).status()).isEqualTo("stored");
        var restarted = new ManagedMemoryService(repository(), (scope, replay) -> { throw new AssertionError("Duplicate write"); });
        assertThat(restarted.query(tenant, session, token, request).memoryId()).isEqualTo("entry-1");
        assertThat(calls).hasValue(1);
        assertThatThrownBy(() -> service.query(tenant, session, token, query("remember", "call-1", "Changed", null)))
                .isInstanceOf(ManagedAgentException.class).extracting("code").isEqualTo("idempotency_conflict");
    }

    @Test
    void dispatchedWithoutResultStaysUnknownAfterRestartAndStaleWriterCannotReplay() {
        bind();
        Query request = query("remember", "lost", "Use concise replies", null);
        assertThat(memory.admit(tenant, session, token, request).replay()).isNull();
        var restarted = new ManagedMemoryService(repository(), (scope, replay) -> { throw new AssertionError("Unsafe retry"); });
        assertThat(restarted.query(tenant, session, token, request).status()).isEqualTo("unknown");
        assertThatThrownBy(() -> restarted.query(tenant, session, "wrong-token", request)).isInstanceOf(ManagedAgentException.class);
        var stale = new Query("ws", "writer", 2, "remember", "prompt", "lost", null, "Use concise replies", null, null);
        assertThatThrownBy(() -> restarted.query(tenant, session, token, stale)).isInstanceOf(ManagedAgentException.class);
        jdbc.update("UPDATE ma_session_head SET writer_lease_until=0 WHERE tenant_id=? AND session_id=?", tenant, session);
        String nextToken = "replacement-memory-writer-token-0123456789";
        var next = tx.execute(status -> sessions.acquireWriter(tenant, session, nextToken,
                new AcquireWriterRequest("ws", "replacement", 60000L)));
        var takeover = new Query("ws", "replacement", next.writerGeneration(), "remember", "prompt", "lost",
                null, "Use concise replies", null, null);
        assertThat(restarted.query(tenant, session, nextToken, takeover).status()).isEqualTo("unknown");
        assertThatThrownBy(() -> restarted.query(tenant, session, token, request)).isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void filtersUnownedAndDeletedSearchHitsAndPreventsDirectIdReads() {
        bind();
        var save = new ManagedMemoryService(memory, (scope, request) -> Result.entry("stored", "entry-1", null));
        save.query(tenant, session, token, query("remember", "save", "Synthetic memory", null));
        AtomicInteger providerCalls = new AtomicInteger();
        var search = new ManagedMemoryService(memory, (scope, request) -> {
            providerCalls.incrementAndGet();
            return Result.items(List.of(new Item("foreign", "Other user's data"), new Item("entry-1", "Synthetic memory")));
        });
        assertThat(search.query(tenant, session, token, query("search", "search-1", null, null)).items())
                .containsExactly(new Item("entry-1", "Synthetic memory"));
        assertThat(search.query(tenant, session, token, query("get", "foreign-read", null, "foreign")).status()).isEqualTo("unavailable");
        assertThat(providerCalls).hasValue(1);
        var delete = new ManagedMemoryService(memory, (scope, request) -> Result.entry("deleted", "entry-1", null));
        delete.query(tenant, session, token, query("forget", "delete", "Synthetic memory", "entry-1"));
        assertThat(search.query(tenant, session, token, query("search", "search-2", null, null)).items()).isEmpty();
    }

    @Test
    void savedRecallSurvivesRecoveryAndUnknownInputIsRefused() {
        bind();
        AtomicInteger calls = new AtomicInteger();
        var service = new ManagedMemoryService(memory, (scope, request) -> {
            calls.incrementAndGet();
            return Result.status("unavailable");
        });
        Query recall = query("recall", "recall", null, null);
        service.query(tenant, session, token, recall);
        service.query(tenant, session, token, recall);
        assertThat(calls).hasValue(1);
        Query invented = new Query("ws", "writer", 1, "recall", "invented", "recall", "preference", null, null, null);
        assertThatThrownBy(() -> service.query(tenant, session, token, invented)).isInstanceOf(ManagedAgentException.class);
        settings.getMemory().setEnabled(false);
        assertThatThrownBy(() -> memory.create(tenant, "owner")).isInstanceOf(ManagedAgentException.class)
                .extracting("code").isEqualTo("memory_disabled");
    }

    @Test
    void automaticRecallDoesNotConsumeTheModelsToolCallIdentity() {
        bind();
        AtomicInteger calls = new AtomicInteger();
        var service = new ManagedMemoryService(memory, (scope, request) -> {
            calls.incrementAndGet();
            return "remember".equals(request.operation()) ? Result.entry("stored", "entry-1", null)
                    : Result.items(List.of());
        });
        assertThat(service.query(tenant, session, token, query("recall", "recall", null, null)).status()).isEqualTo("ok");
        Query remember = query("remember", "recall", "Synthetic memory", null);
        assertThat(service.query(tenant, session, token, remember).status()).isEqualTo("stored");
        assertThat(service.query(tenant, session, token, remember).memoryId()).isEqualTo("entry-1");
        assertThat(calls).hasValue(2);
    }

    @Test
    void rejectsAnEmbeddingTransactionBeforeAdmittingAnyProviderOperation() {
        bind();
        var service = new ManagedMemoryService(memory, (scope, request) -> { throw new AssertionError("Network inside transaction"); });
        assertThatThrownBy(() -> tx.execute(status -> service.query(tenant, session, token,
                query("remember", "transaction", "Synthetic", null))))
                .isInstanceOf(IllegalStateException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE namespace='MEMORY' AND tenant_id=?",
                Integer.class, tenant)).isZero();
    }
}
