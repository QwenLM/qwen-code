package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.*;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class JournalLockContractTest {
    private static final String TENANT = "journal-tenant";
    private static final String SESSION = "journal-session";
    private static final String TOKEN = "a".repeat(32);
    protected StoreLockTrace trace;
    private JdbcManagedSessionStore raw;
    private JdbcManagedSessionStore proxy;
    private TransactionTemplate transactions;
    private int notifications;

    protected DataSource dataSource() {
        return new DriverManagerDataSource("jdbc:h2:mem:journal-lock-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1", "sa", "");
    }

    @BeforeEach
    void setUp() {
        trace = new StoreLockTrace(dataSource());
        ManagedSchema.initialize(trace);
        var jdbc = new ManagedSchemaJdbcTemplate(trace);
        raw = VerificationFixtures.managedSessionStore(jdbc, new JdbcManagedExtensionRecordStore(jdbc),
                null, null, null, null, null, bytes -> {
                    assertThat(trace.events()).anyMatch(event -> event.phase() == StoreLockTrace.Phase.COMMIT);
                    notifications++;
                }, com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy.unbound(), null);
        proxy = AgentLockContractTest.transactional(raw, trace);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(trace));
        proxy.acquireWriter(TENANT, SESSION, TOKEN, new AcquireWriterRequest("workspace", "writer", 60_000L));
        trace.clear();
    }

    @ParameterizedTest
    @ValueSource(strings = {"commit", "seal", "block", "publication", "tool-result", "renew"})
    void journalEntriesUseOneRootAndHeadInTheSameTransaction(String route) {
        switch (route) {
            case "commit" -> proxy.commit(TENANT, SESSION, TOKEN, genesis());
            case "seal" -> proxy.sealWriter(TENANT, SESSION, TOKEN, new SealWriterRequest("workspace", "writer", 1));
            case "block" -> proxy.blockRecovery(TENANT, SESSION, TOKEN,
                    new BlockRecoveryRequest("workspace", "writer", 1, "BLOCKED_EXECUTION", "failure"));
            case "publication" -> transactions.execute(status -> raw.lockPublicationWriter(TENANT, "workspace", SESSION, "writer", 1, TOKEN));
            case "tool-result" -> proxy.publishToolResult(TENANT, SESSION, TOKEN,
                    new PublishToolResultRequest("workspace", "writer", 1, "result", "managed-tool-result-content", 1,
                            1, DigestUtils.sha256Hex(new byte[] {1}), "AQ=="));
            case "renew" -> proxy.renewWriter(TENANT, SESSION, TOKEN, new RenewWriterRequest("workspace", "writer", 1, 60_000L));
            default -> throw new IllegalArgumentException(route);
        }
        trace.assertRootBeforeHead(TENANT, SESSION);
        trace.assertOneTransaction(TENANT, SESSION);
        assertThat(heads()).isEqualTo(1);
        assertThat(roots()).isEqualTo(1);
    }

    @Test
    void guardFreePublicationWriterTakesNoTenantGuard() {
        // An ordinary publication lane took the Session root instead of the
        // guards; the writer must not take either after it (design
        // 2026-11-04-managed-publication-placement).
        transactions.execute(status -> raw.lockPublicationWriter(TENANT, "workspace", SESSION, "writer", 1, TOKEN,
                false, false));
        assertThat(trace.events().stream().filter(event -> event.phase() == StoreLockTrace.Phase.SUCCEEDED)
                .map(StoreLockTrace.Event::sql)).noneMatch(sql -> sql.contains("ma_tenant_guard"));
        trace.assertRootBeforeHead(TENANT, SESSION);
        trace.assertOneTransaction(TENANT, SESSION);

        trace.clear();
        transactions.execute(status -> raw.lockPublicationWriter(TENANT, "workspace", SESSION, "writer", 1, TOKEN,
                true, false));
        assertThat(trace.events().stream().filter(event -> event.phase() == StoreLockTrace.Phase.SUCCEEDED)
                .map(StoreLockTrace.Event::sql)).anyMatch(sql -> sql.contains("runtime_placement"))
                .noneMatch(sql -> sql.contains("output_publication"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"publication", "placement-publication", "commit", "tool-result"})
    void ordinaryJournalAndPublicationCheckStorageWithoutLocking(String route) {
        var jdbc = new ManagedSchemaJdbcTemplate(trace);
        String physical = "d".repeat(64);
        jdbc.update("INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id, physical_key,"
                        + " storage_kind, registration_state, registration_revision, registration_json)"
                        + " VALUES (?, ?, ?, ?, 'storage', ?, 'LOCAL', 'REGISTERED', 1, '{}')",
                JdbcRuntimeBindingRepository.storageAliasKey(TENANT, "storage"),
                JdbcRuntimeBindingRepository.storageFenceKey(TENANT),
                JdbcRuntimeBindingRepository.storageFenceKey("storage"), TENANT, physical);
        jdbc.update("INSERT INTO ma_storage_owner (storage_key, physical_key, storage_kind, mount_state)"
                + " VALUES (?, ?, 'LOCAL', 'READY')", physical, physical);
        jdbc.update("UPDATE ma_session SET workspace_storage_id = 'storage' WHERE tenant_id = ?", TENANT);
        trace.clear();
        boolean placement = "placement-publication".equals(route);
        switch (route) {
            case "commit" -> proxy.commit(TENANT, SESSION, TOKEN, genesis());
            case "tool-result" -> proxy.publishToolResult(TENANT, SESSION, TOKEN, toolResult(new byte[] {1}));
            default -> transactions.execute(status -> raw.lockPublicationWriter(TENANT, "workspace", SESSION, "writer", 1, TOKEN,
                    placement, false));
        }
        var reads = trace.events().stream().filter(event -> event.phase() == StoreLockTrace.Phase.SUCCEEDED)
                .map(StoreLockTrace.Event::sql).filter(sql -> sql.contains(" from ma_storage ")
                        || sql.contains(" from ma_storage_owner ")).toList();
        assertThat(reads).hasSize(2).allSatisfy(sql -> assertThat(sql.contains("for update") || sql.contains("for share")).isEqualTo(placement));
        trace.assertRootBeforeHead(TENANT, SESSION);
        trace.assertOneTransaction(TENANT, SESSION);
    }

    @Test
    void ordinaryReplayReturnsBeforeLockingTheHead() {
        proxy.commit(TENANT, SESSION, TOKEN, genesis());
        trace.clear();
        assertThat(proxy.commit(TENANT, SESSION, TOKEN, genesis()).replayed()).isTrue();
        assertThat(heads()).isZero();
        assertThat(notifications).isEqualTo(1);
        assertThat(roots()).isEqualTo(1);
    }

    @Test
    void newToolResultDoesNotLockAMissingResourceOrTenantGuard() {
        proxy.publishToolResult(TENANT, SESSION, TOKEN, toolResult(new byte[] {1}));
        var statements = trace.events().stream()
                .filter(event -> event.phase() == StoreLockTrace.Phase.SUCCEEDED)
                .map(StoreLockTrace.Event::sql).toList();
        assertThat(statements).noneMatch(sql -> sql.contains("ma_tenant_guard"));
        assertThat(statements).filteredOn(sql -> sql.startsWith("select ") && sql.contains(" from ma_resource "))
                .singleElement().satisfies(sql -> assertThat(sql).doesNotContain("for update"));
        trace.assertRootBeforeHead(TENANT, SESSION);
        trace.assertOneTransaction(TENANT, SESSION);
    }

    @Test
    void toolResultReplayRequiresTheSameContent() {
        var request = toolResult(new byte[] {1});
        var first = proxy.publishToolResult(TENANT, SESSION, TOKEN, request);
        assertThat(proxy.publishToolResult(TENANT, SESSION, TOKEN, request)).isEqualTo(first);
        assertThatThrownBy(() -> proxy.publishToolResult(TENANT, SESSION, TOKEN, toolResult(new byte[] {2})))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("managed_session_resource_conflict"));
    }

    @Test
    void toolResultReplayDoesNotReviveACollectedResource() {
        var request = toolResult(new byte[] {1});
        proxy.publishToolResult(TENANT, SESSION, TOKEN, request);
        var jdbc = new ManagedSchemaJdbcTemplate(trace);
        jdbc.update("UPDATE ma_resource SET state = 'COLLECTED', inline_bytes = NULL"
                + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ?", TENANT, SESSION, request.resourceId());
        assertThatThrownBy(() -> proxy.publishToolResult(TENANT, SESSION, TOKEN, request))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("managed_session_resource_corrupt"));
        assertThat(jdbc.queryForObject("SELECT state FROM ma_resource WHERE tenant_id = ? AND session_id = ?"
                + " AND resource_id = ?", String.class, TENANT, SESSION, request.resourceId())).isEqualTo("COLLECTED");
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE tenant_id = ? AND session_id = ?"
                + " AND resource_id = ?", byte[].class, TENANT, SESSION, request.resourceId())).isNull();
    }

    private static PublishToolResultRequest toolResult(byte[] bytes) {
        return new PublishToolResultRequest("workspace", "writer", 1, "result", "managed-tool-result-content", 1,
                bytes.length, DigestUtils.sha256Hex(bytes), Base64.getEncoder().encodeToString(bytes));
    }

    @Test
    void standaloneStillPerformsItsRootRead() {
        raw.sealWriter(TENANT, SESSION, TOKEN, new SealWriterRequest("workspace", "writer", 1));
        assertThat(roots()).isEqualTo(1);
        assertThat(heads()).isEqualTo(1);
        assertThat(trace.successful(TENANT, SESSION)).allMatch(StoreLockTrace.Event::autoCommit);
    }

    @Test
    void anUnrelatedTransactionDoesNotProveTheAutocommitConnectionHoldsRoot() {
        var business = new DriverManagerDataSource("jdbc:h2:mem:business-" + UUID.randomUUID(), "sa", "");
        var external = new TransactionTemplate(new DataSourceTransactionManager(business));
        external.executeWithoutResult(status -> raw.sealWriter(TENANT, SESSION, TOKEN,
                new SealWriterRequest("workspace", "writer", 1)));
        assertThat(roots()).isEqualTo(2);
        assertThat(heads()).isEqualTo(1);
        assertThat(trace.successful(TENANT, SESSION)).allMatch(StoreLockTrace.Event::autoCommit);
    }

    @Test
    void rollbackReacquiresTheRootAndOldWritersAreRefused() {
        transactions.executeWithoutResult(status -> {
            proxy.commit(TENANT, SESSION, TOKEN, genesis());
            assertThat(notifications).isZero();
            status.setRollbackOnly();
        });
        assertThat(trace.events()).anyMatch(event -> event.phase() == StoreLockTrace.Phase.ROLLBACK);
        assertThat(notifications).isZero();
        trace.clear();
        assertThat(proxy.commit(TENANT, SESSION, TOKEN, genesis()).replayed()).isFalse();
        assertThat(notifications).isEqualTo(1);
        trace.assertRootBeforeHead(TENANT, SESSION);
        trace.clear();
        assertThatThrownBy(() -> proxy.renewWriter(TENANT, SESSION, "b".repeat(32),
                new RenewWriterRequest("workspace", "writer", 1, 60_000L))).isInstanceOf(RuntimeException.class);
        trace.assertRootBeforeHead(TENANT, SESSION);
    }

    private long roots() {
        return trace.successful(TENANT, SESSION).stream().filter(event -> event.sql().startsWith("select tenant_id, session_id, is_csi_guard from ma_session ")).count();
    }

    private long heads() {
        return trace.successful(TENANT, SESSION).stream().filter(StoreLockTrace.Event::mappedHead).count();
    }

    static CommitTransactionRequest genesis() {
        String records = "{\"subtype\":\"session_execution_engine\"}\n{\"subtype\":\"managed_session_header_v1\"}\n";
        byte[] bytes = records.getBytes(StandardCharsets.UTF_8);
        String digest = DigestUtils.sha256Hex(bytes);
        byte[] resource = "context".getBytes(StandardCharsets.UTF_8);
        return new CommitTransactionRequest("workspace", "writer", 1, 0, 0, "transaction", "session.create", "command", digest,
                0, 0, 0, null, null, null, 0, null, 2, Base64.getEncoder().encodeToString(bytes), digest,
                List.of(new CommitResource("context", "managed-context", 1, resource.length,
                        DigestUtils.sha256Hex(resource), Base64.getEncoder().encodeToString(resource))));
    }
}
