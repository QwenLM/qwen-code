package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationDataStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.aop.support.AopUtils;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import org.springframework.transaction.support.DefaultTransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.COMMIT_MARKER;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.PUBLICATION_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.WRITER_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.digest;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

@Timeout(30)
class ToolPublicationStorageMySqlIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PHYSICAL = "d".repeat(64);
    private IsolatedManagedSchemaMySqlTestDatabase database;
    private PublicationJournalFixture journal;
    private String schema;

    @BeforeEach
    void setUp() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        ManagedSchema.initialize(database.source());
    }

    @AfterEach
    void close() {
        if (database != null) {
            database.close();
        }
    }

    @ParameterizedTest
    @CsvSource({"false, alias, reserve, false", "true, owner, reserve, false",
        "false, owner, renew, true", "true, alias, renew, true",
        "false, alias, admission, false", "true, owner, admission, true",
        "false, owner, receipt, false", "true, alias, receipt, true",
        "false, alias, replay, true", "true, owner, replay, false",
        "false, owner, admission-and-receipt, true", "true, alias, admission-and-receipt, true"})
    void ordinaryPublicationDoesNotWaitForStorageMetadata(boolean sessionIsolated, String row, String operation, boolean ambient)
            throws Exception {
        fixture(sessionIsolated);
        var work = work(operation, ambient);
        try (var reader = database.source().getConnection(); var executor = Executors.newSingleThreadExecutor()) {
            reader.setAutoCommit(false);
            lock(reader, row);
            var publication = executor.submit(work);
            boolean blocked;
            try {
                blocked = waits(publication);
                System.out.println("PUBLICATION_STORAGE_NONLOCKING isolation=" + sessionIsolated + " row=" + row
                        + " operation=" + operation + " ambient=" + ambient + " blocked=" + blocked + " "
                        + MySqlLockProbe.describeLockWaits(journal.jdbc, schema));
            } finally {
                reader.rollback();
            }
            JsonNode result = publication.get(5, TimeUnit.SECONDS);
            if ("reserve".equals(operation) || "renew".equals(operation)) {
                assertThat(result.path("state").asText()).isEqualTo("OPEN");
            } else if ("admission".equals(operation)) {
                assertThat(result.path("resourceId").asText()).isNotBlank();
            } else {
                assertThat(result.path("decision").asText()).isEqualTo("blocked");
            }
            assertThat(blocked).as("ordinary %s does not lock %s metadata", operation, row).isFalse();
        }
    }

    @Test
    void ordinaryReserveDoesNotWaitForExclusiveOwner() throws Exception {
        ordinaryPublicationDoesNotWaitForStorageMetadata(false, "owner", "reserve", false);
    }

    @ParameterizedTest
    @CsvSource({"alias, reserve", "owner, reserve", "alias, admission", "owner, admission", "alias, receipt", "owner, receipt"})
    void publicationRejectsAlreadyCommittedUnavailableStorage(String row, String operation) throws Exception {
        fixture(false);
        var work = work(operation, false);
        var before = journal.jdbc.queryForList("SELECT publication_id, producer_phase, receipt_revision, admission_resource_id FROM ma_output_capture");
        assertThat(journal.jdbc.update(mutationSql(row))).isEqualTo(1);
        assertThatThrownBy(work::call).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
        assertThat(journal.jdbc.queryForList("SELECT publication_id, producer_phase, receipt_revision, admission_resource_id FROM ma_output_capture"))
                .isEqualTo(before);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void membershipUpdateDoesNotWaitForPublicationTransaction(boolean sessionIsolated) throws Exception {
        fixture(sessionIsolated);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var publication = journal.manager.getTransaction(new DefaultTransactionDefinition());
            Future<Integer> mutation;
            boolean blocked;
            try {
                assertThat(journal.reserve().path("state").asText()).isEqualTo("OPEN");
                mutation = executor.submit(() -> journal.jdbc.update("UPDATE ma_storage_owner SET member_count = member_count + 1 WHERE storage_key = ?", PHYSICAL));
                blocked = waits(mutation);
            } finally {
                journal.manager.commit(publication);
            }
            assertThat(mutation.get(5, TimeUnit.SECONDS)).isEqualTo(1);
            assertThat(blocked).as("membership bookkeeping does not wait for publication").isFalse();
            assertThat(journal.jdbc.queryForObject("SELECT COUNT(*) FROM ma_output_capture", Long.class)).isEqualTo(1);
        }
    }

    @Test
    void genericJournalNamedRecordToolResultStillLocksStorage() throws Exception {
        fixture(false);
        var generic = work("generic-receipt", false);
        var before = journal.jdbc.queryForList("SELECT journal_revision, committed_sequence FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION'");
        try (var blocker = database.source().getConnection(); var executor = Executors.newSingleThreadExecutor()) {
            blocker.setAutoCommit(false);
            lock(blocker, "owner");
            var commit = executor.submit(generic);
            boolean blocked;
            try {
                blocked = waits(commit);
                System.out.println("GENERIC_PUBLICATION_STORAGE blocked=" + blocked + " "
                        + MySqlLockProbe.describeLockWaits(journal.jdbc, schema));
            } finally {
                blocker.rollback();
            }
            // Bypassing admission leaves the capture resource uninstalled in the Session journal.
            assertThatThrownBy(() -> commit.get(5, TimeUnit.SECONDS))
                    .cause().isInstanceOfSatisfying(ManagedAgentException.class, error ->
                            assertThat(error.getCode()).isEqualTo("managed_session_resource_corrupt"));
            assertThat(journal.jdbc.queryForList("SELECT journal_revision, committed_sequence FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION'"))
                    .isEqualTo(before);
            assertThat(blocked).as("an operation label is not proof that publication validation ran").isTrue();
        }
    }

    private Callable<JsonNode> work(String operation, boolean ambient) {
        if ("reserve".equals(operation)) {
            return transaction(ambient, journal::reserve);
        }
        journal.reserve();
        if ("renew".equals(operation)) {
            return transaction(ambient, () -> journal.store.apply(journal.request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN));
        }
        ToolPublicationObjectStore objects = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) {
                throw new AssertionError("Inline fixture expected");
            }
            @Override
            public InputStream open(String key) {
                throw new AssertionError("Inline fixture expected");
            }
            @Override
            public void validateConfiguration() { }
        };
        var data = new ToolPublicationDataStore(journal.jdbc, journal.manager, journal.store, journal.sessions,
                objects, Duration.ofMinutes(2), Duration.ofSeconds(30),
                new ToolPublicationDataStore.VerificationBudget(16 * 1024 * 1024, Duration.ofMinutes(25)));
        JsonNode key = journal.binding.get("sessionKey");
        var envelope = JSON.createObjectNode().put("executionStatus", "error");
        envelope.putArray("responseParts");
        envelope.set("capture", JSON.createObjectNode().put("captureStatus", "unavailable")
                .put("captureReason", "storage_failed").put("previewTruncated", false)
                .put("deliveryStatus", "pending").putNull("manifest"));
        data.finish(key, "pub-1", PUBLICATION_TOKEN, "finish", envelope.toString().getBytes(StandardCharsets.UTF_8));
        var outcome = JSON.createObjectNode().put("schemaVersion", 1).put("decision", "blocked").putNull("manifestRef");
        outcome.set("envelope", envelope);
        var history = JSON.createObjectNode().put("messageId", "11111111-1111-4111-8111-111111111111")
                .put("timestamp", "2026-10-11T00:00:00Z").put("model", "test");
        history.putArray("parts").addObject().put("text", "Shell capture unavailable");
        outcome.set("history", history);
        if ("admission".equals(operation)) {
            return transaction(ambient, () -> data.prepareAdmission(key, "pub-1", "writer-1", 1, WRITER_TOKEN, outcome));
        }
        boolean combined = "admission-and-receipt".equals(operation);
        JsonNode root = new TransactionTemplate(journal.manager).execute(status -> {
            JsonNode prepared = data.prepareAdmission(key, "pub-1", "writer-1", 1, WRITER_TOKEN, outcome);
            if (combined) {
                status.setRollbackOnly();
            }
            return prepared;
        });
        long sequence = journal.sequence + 1;
        var payload = JSON.createObjectNode().put("executionCallId", "execution-1")
                .put("historyRevision", sequence).putNull("resultRef");
        payload.set("toolOutcomeRef", root);
        payload.putArray("resources");
        String records = journal.event(sequence, "tool.receipt", payload) + COMMIT_MARKER;
        var request = new CommitTransactionRequest("workspace-1", "writer-1", 1, journal.revision,
                journal.sequence, "receipt", "recordToolResult", "execution-1", root.path("digest").asText(),
                sequence, sequence, 1, digest(records), journal.commitDigest, digest(records), 1, null, 2,
                Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)), digest(records),
                List.of(new CommitResource(root.path("resourceId").asText(), "managed-tool-outcome", 1,
                        root.path("byteLength").asLong(), root.path("digest").asText(), null)));
        var sessions = transactionalSessions();
        if ("generic-receipt".equals(operation)) {
            return () -> JSON.valueToTree(sessions.commit("tenant-1", "session-1", WRITER_TOKEN, request));
        }
        var admission = new ToolPublicationAdmissionStore(journal.jdbc, journal.manager, sessions, data);
        JsonNode previous = "replay".equals(operation) ? admission.commitReceipt(key, "pub-1", WRITER_TOKEN, request) : null;
        return transaction(ambient, () -> {
            if (combined) {
                assertThat(data.prepareAdmission(key, "pub-1", "writer-1", 1, WRITER_TOKEN, outcome)).isEqualTo(root);
            }
            JsonNode receipt = admission.commitReceipt(key, "pub-1", WRITER_TOKEN, request);
            if (previous != null) {
                assertThat(receipt).isEqualTo(previous);
            }
            assertThat(journal.sessions.readResource("tenant-1", "workspace-1", "session-1",
                    root.path("resourceId").asText(), WRITER_TOKEN).bytes()).isEqualTo(outcome.toString().getBytes(StandardCharsets.UTF_8));
            return receipt;
        });
    }

    private Callable<JsonNode> transaction(boolean ambient, Callable<JsonNode> work) {
        return () -> {
            if (!ambient) {
                return work.call();
            }
            var transactions = new TransactionTemplate(journal.manager);
            transactions.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
            return transactions.execute(status -> {
                journal.jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage", Long.class);
                try {
                    return work.call();
                } catch (RuntimeException error) {
                    throw error;
                } catch (Exception error) {
                    throw new AssertionError(error);
                }
            });
        };
    }

    private ManagedSessionStore transactionalSessions() {
        var beans = new DefaultListableBeanFactory();
        beans.registerSingleton("managedAgentTransactionManager", journal.manager);
        var interceptor = new TransactionInterceptor();
        interceptor.setBeanFactory(beans);
        interceptor.setTransactionAttributeSource(new AnnotationTransactionAttributeSource());
        interceptor.setTransactionManagerBeanName("managedAgentTransactionManager");
        interceptor.afterPropertiesSet();
        var factory = new ProxyFactory(journal.sessions);
        factory.setProxyTargetClass(true);
        factory.addAdvice(interceptor);
        var result = (ManagedSessionStore) factory.getProxy();
        assertThat(AopUtils.isCglibProxy(result)).isTrue();
        return result;
    }

    private void fixture(boolean sessionIsolated) {
        journal = sessionIsolated ? PublicationJournalFixture.createSessionIsolated(database.source())
                : PublicationJournalFixture.create(database.source());
        schema = journal.jdbc.queryForObject("SELECT DATABASE()", String.class);
        journal.jdbc.update("INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id, physical_key,"
                        + " storage_kind, registration_state, registration_revision, registration_json)"
                        + " VALUES (?, ?, ?, 'tenant-1', 'storage', ?, 'LOCAL', 'REGISTERED', 1, '{}')",
                JdbcRuntimeBindingRepository.storageAliasKey("tenant-1", "storage"),
                JdbcRuntimeBindingRepository.storageFenceKey("tenant-1"),
                JdbcRuntimeBindingRepository.storageFenceKey("storage"), PHYSICAL);
        journal.jdbc.update("INSERT INTO ma_storage_owner (storage_key, physical_key, storage_kind, tenant_id, storage_id, mount_state)"
                + " VALUES (?, ?, 'LOCAL', 'tenant-1', 'storage', 'READY')", PHYSICAL, PHYSICAL);
        journal.jdbc.update("UPDATE ma_session SET workspace_storage_id = 'storage' WHERE tenant_id = 'tenant-1'");
    }

    private void lock(Connection connection, String row) throws Exception {
        String sql = "alias".equals(row) ? "SELECT alias_key FROM ma_storage WHERE alias_key = ? FOR UPDATE"
                : "SELECT storage_key FROM ma_storage_owner WHERE storage_key = ? FOR UPDATE";
        try (var statement = connection.prepareStatement(sql)) {
            statement.setString(1, "alias".equals(row)
                    ? JdbcRuntimeBindingRepository.storageAliasKey("tenant-1", "storage") : PHYSICAL);
            try (var result = statement.executeQuery()) {
                assertThat(result.next()).isTrue();
                assertThat(result.next()).isFalse();
            }
        }
    }

    private boolean waits(Future<?> future) {
        await().atMost(Duration.ofSeconds(5)).until(() -> future.isDone() || MySqlLockProbe.lockWaits(journal.jdbc, schema) > 0);
        return MySqlLockProbe.lockWaits(journal.jdbc, schema) > 0;
    }

    private static String mutationSql(String row) {
        return "alias".equals(row)
                ? "UPDATE ma_storage SET registration_state = 'RETIRED' WHERE storage_id = 'storage'"
                : "UPDATE ma_storage_owner SET mount_state = 'FENCED' WHERE storage_key = '" + PHYSICAL + "'";
    }
}
