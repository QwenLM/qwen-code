package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedSessionPhysicalFenceTest {
    private static final String TOKEN = "physical-fence-writer-token-0123456789";
    private static final String TENANT = "physical-tenant";
    private static final String SESSION = "physical-session";
    private static final String STORAGE = "second-alias";
    protected ManagedSchemaJdbcTemplate jdbc;
    protected TransactionTemplate transactions;
    protected ManagedSessionStore sessions;
    protected long generation;
    protected final String physical = ManagedSchemaKeys.key("same-native-device");

    protected DataSource dataSource() {
        var source = new JdbcDataSource();
        source.setURL(
                "jdbc:h2:mem:physical-fence-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return source;
    }

    @BeforeEach
    void setup() {
        var source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
        sessions = new ManagedSessionStore(jdbc);
        generation =
                transactions
                        .execute(
                                status ->
                                        sessions.acquireWriter(
                                                TENANT,
                                                SESSION,
                                                TOKEN,
                                                new ManagedSessionStoreModels.AcquireWriterRequest(
                                                        "workspace", "writer", 60_000L)))
                        .writerGeneration();
        jdbc.update(
                "UPDATE ma_session SET workspace_storage_id = ? WHERE tenant_id = ? AND session_id"
                        + " = ?",
                STORAGE,
                TENANT,
                SESSION);
        jdbc.update(
                "INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id,"
                        + " physical_key, storage_kind, registration_state, registration_revision,"
                        + " registration_json) VALUES (?, ?, ?, ?, ?, ?, 'LOCAL', 'REGISTERED', 1,"
                        + " '{}')",
                JdbcRuntimeBindingRepository.storageAliasKey(TENANT, STORAGE),
                JdbcRuntimeBindingRepository.storageFenceKey(TENANT),
                JdbcRuntimeBindingRepository.storageFenceKey(STORAGE),
                TENANT,
                STORAGE,
                physical);
        jdbc.update(
                "INSERT INTO ma_storage_owner (storage_key, physical_key, storage_kind, tenant_id,"
                        + " storage_id, mount_state) VALUES (?, ?, 'LOCAL', 'first-tenant',"
                        + " 'first-alias', 'READY')",
                physical,
                physical);
    }

    @Test
    void jdbcStringBoundaryRejectsMalformedUnicodeOnEveryEngine() {
        assertThatThrownBy(
                        () ->
                                jdbc.update(
                                        "UPDATE ma_session SET workspace_id = ? WHERE tenant_id = ?"
                                            + " AND session_id = ?",
                                        "\ud800",
                                        TENANT,
                                        SESSION))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT workspace_id FROM ma_session WHERE tenant_id = ? AND"
                                    + " session_id = ?",
                                String.class,
                                TENANT,
                                SESSION))
                .isNull();
    }

    @Test
    void physicalFreezeRejectsExistingWriterMutationsButAllowsSealing() throws Exception {
        jdbc.update(
                "UPDATE ma_storage_owner SET mount_state = 'FENCED' WHERE storage_key = ?",
                physical);
        assertThatThrownBy(
                        () ->
                                transactions.execute(
                                        status ->
                                                sessions.commit(TENANT, SESSION, TOKEN, genesis())))
                .hasMessageContaining("Workspace");
        assertThatThrownBy(
                        () ->
                                transactions.execute(
                                        status ->
                                                sessions.lockPublicationWriter(
                                                        TENANT,
                                                        "workspace",
                                                        SESSION,
                                                        "writer",
                                                        generation,
                                                        TOKEN)))
                .hasMessageContaining("Workspace");
        var result = result();
        assertThatThrownBy(
                        () ->
                                transactions.execute(
                                        status ->
                                                sessions.publishToolResult(
                                                        TENANT, SESSION, TOKEN, result)))
                .hasMessageContaining("Workspace");
        assertThat(
                        jdbc.queryForObject(
                                "SELECT journal_revision FROM ma_session_head WHERE tenant_id = ?"
                                        + " AND session_id = ?",
                                Long.class,
                                TENANT,
                                SESSION))
                .isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx", Integer.class))
                .isZero();
        assertThat(
                        transactions
                                .execute(
                                        status ->
                                                sessions.sealWriter(
                                                        TENANT,
                                                        SESSION,
                                                        TOKEN,
                                                        new ManagedSessionStoreModels
                                                                .SealWriterRequest(
                                                                "workspace", "writer", generation)))
                                .state())
                .isEqualTo("SEALED");
    }

    @Test
    void committedJournalReplayRemainsAvailableDuringPhysicalFreeze() {
        var request = genesis();
        var committed =
                transactions.execute(status -> sessions.commit(TENANT, SESSION, TOKEN, request));
        jdbc.update(
                "UPDATE ma_storage_owner SET mount_state = 'FENCED' WHERE storage_key = ?",
                physical);
        var replay =
                transactions.execute(status -> sessions.commit(TENANT, SESSION, TOKEN, request));
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.journalRevision()).isEqualTo(committed.journalRevision());
        assertThatThrownBy(
                        () ->
                                transactions.execute(
                                        status ->
                                                sessions.commit(
                                                        TENANT,
                                                        SESSION,
                                                        TOKEN,
                                                        genesis("new-command"))))
                .hasMessageContaining("Workspace");
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_session_journal_tx WHERE tenant_id = ? AND"
                                        + " session_id = ?",
                                Integer.class,
                                TENANT,
                                SESSION))
                .isEqualTo(1);
    }

    @Test
    void logicalRetirementAllowsAdmittedFinalResultsWhilePhysicalOwnerIsOpen() throws Exception {
        jdbc.update(
                "UPDATE ma_storage SET registration_state = 'RETIRING', fence_operation_id ="
                        + " 'retirement' WHERE alias_key = ?",
                JdbcRuntimeBindingRepository.storageAliasKey(TENANT, STORAGE));
        assertThatThrownBy(
                        () ->
                                transactions.execute(
                                        status ->
                                                sessions.acquireWriter(
                                                        TENANT,
                                                        SESSION,
                                                        TOKEN,
                                                        new ManagedSessionStoreModels
                                                                .AcquireWriterRequest(
                                                                "workspace", "writer", 60_000L))))
                .hasMessageContaining("Workspace");
        assertThat(
                        transactions
                                .execute(
                                        status ->
                                                sessions.commit(TENANT, SESSION, TOKEN, genesis()))
                                .journalRevision())
                .isEqualTo(1);
        var publicationWriter =
                transactions.execute(
                        status ->
                                sessions.lockPublicationWriter(
                                        TENANT, "workspace", SESSION, "writer", generation, TOKEN));
        assertThat(publicationWriter).isNotNull();
        var result = result();
        assertThat(
                        transactions
                                .execute(
                                        status ->
                                                sessions.publishToolResult(
                                                        TENANT, SESSION, TOKEN, result))
                                .resourceId())
                .isEqualTo("final-result");
    }

    @Test
    void controlWriterUsesItsRegisteredWorkspacePhysicalFence() throws Exception {
        jdbc.update(
                "UPDATE ma_session SET workspace_storage_id = NULL WHERE tenant_id = ? AND"
                        + " session_id = ?",
                TENANT,
                SESSION);
        jdbc.update(
                "INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                        + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?,"
                        + " 'workspace', 1, ?, 'Control workspace', 'config', 'policy', 'ACTIVE')",
                TENANT,
                STORAGE);
        physicalFreezeRejectsExistingWriterMutationsButAllowsSealing();
    }

    @Test
    void registeredControlWriterPersistsItsVerifiedStorageBindingBeforeGrant() {
        jdbc.update(
                "INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                        + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?,"
                        + " 'workspace', 1, ?, 'Control workspace', 'config', 'policy', 'ACTIVE')",
                TENANT,
                STORAGE);
        transactions.execute(
                status ->
                        sessions.acquireWriter(
                                TENANT,
                                "registered-control",
                                TOKEN,
                                new ManagedSessionStoreModels.AcquireWriterRequest(
                                        "workspace", "writer", 60_000L)));
        var control =
                jdbc.queryForMap(
                        "SELECT workspace_id, workspace_storage_id FROM ma_session WHERE tenant_id"
                                + " = ? AND session_id = ?",
                        TENANT,
                        "registered-control");
        assertThat(control.get("workspace_id")).isEqualTo("workspace");
        assertThat(control.get("workspace_storage_id")).isEqualTo(STORAGE);
        jdbc.update(
                "UPDATE ma_storage_owner SET mount_state = 'FENCED' WHERE storage_key = ?",
                physical);
        assertThatThrownBy(
                        () ->
                                transactions.execute(
                                        status ->
                                                sessions.acquireWriter(
                                                        TENANT,
                                                        "not-created",
                                                        TOKEN,
                                                        new ManagedSessionStoreModels
                                                                .AcquireWriterRequest(
                                                                "workspace", "writer", 60_000L))))
                .hasMessageContaining("Workspace");
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_session WHERE tenant_id = ? AND session_id"
                                        + " = ?",
                                Integer.class,
                                TENANT,
                                "not-created"))
                .isZero();
    }

    @Test
    void physicalFreezeBlocksNewPublicAndChildSessionsButPreservesChildReplay() {
        jdbc.update(
                "INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                        + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?,"
                        + " 'workspace', 1, ?, 'Parent workspace', ?, ?, 'ACTIVE')",
                TENANT,
                STORAGE,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONFIG_REF,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update(
                "INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES"
                        + " (?, 'workspace', ?, 'OPERATOR')",
                TENANT,
                ManagedWorkspaceRegistry.actorKey(TENANT, "actor"));
        var publicStore =
                new ManagedAgentStore(
                        jdbc,
                        new com.fasterxml.jackson.databind.ObjectMapper(),
                        java.time.Clock.systemUTC(),
                        ignored -> {},
                        new ManagedWorkspaceRegistry(jdbc),
                        new com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties());
        var selection =
                new com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection("workspace", ".");
        var parent =
                transactions
                        .execute(
                                status ->
                                        publicStore.insertWorkspaceSessionCommand(
                                                TENANT,
                                                "actor",
                                                "parent",
                                                "digest",
                                                "qwen-code",
                                                null,
                                                "parent",
                                                List.of(),
                                                null,
                                                selection))
                        .sessionId();
        var lineage = new StoreModels.SessionLineage(parent, parent, "run", 1);
        var child =
                transactions
                        .execute(
                                status ->
                                        publicStore.insertChildSessionCommand(
                                                TENANT, parent, "child", "digest", "child",
                                                List.of(), null, lineage))
                        .sessionId();
        jdbc.update(
                "UPDATE ma_storage_owner SET mount_state = 'FENCED' WHERE storage_key = ?",
                physical);
        var replay =
                transactions.execute(
                        status ->
                                publicStore.insertChildSessionCommand(
                                        TENANT, parent, "child", "digest", "child", List.of(), null,
                                        lineage));
        assertThat(replay.sessionId()).isEqualTo(child);
        assertThat(replay.replayed()).isTrue();
        assertThatThrownBy(
                        () ->
                                transactions.execute(
                                        status ->
                                                publicStore.insertChildSessionCommand(
                                                        TENANT,
                                                        parent,
                                                        "second-child",
                                                        "digest",
                                                        "child",
                                                        List.of(),
                                                        null,
                                                        new StoreModels.SessionLineage(
                                                                parent, parent, "second-run", 1))))
                .hasMessageContaining("Workspace");
        assertThatThrownBy(
                        () ->
                                transactions.execute(
                                        status ->
                                                publicStore.insertWorkspaceSessionCommand(
                                                        TENANT,
                                                        "actor",
                                                        "second-parent",
                                                        "digest",
                                                        "qwen-code",
                                                        null,
                                                        "parent",
                                                        List.of(),
                                                        null,
                                                        selection)))
                .hasMessageContaining("Workspace");
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_session WHERE tenant_id = ? AND"
                                        + " parent_session_id = ?",
                                Integer.class,
                                TENANT,
                                parent))
                .isEqualTo(1);
    }

    protected void rejectsAConcurrentFenceAfterRepeatableReadSnapshot() {
        transactions.executeWithoutResult(
                status -> {
                    assertThat(
                                    jdbc.queryForObject(
                                            "SELECT mount_state FROM ma_storage_owner WHERE"
                                                    + " storage_key = ?",
                                            String.class,
                                            physical))
                            .isEqualTo("READY");
                    try (var independent = jdbc.getDataSource().getConnection();
                            var freeze =
                                    independent.prepareStatement(
                                            "UPDATE ma_storage_owner SET mount_state = 'FENCED'"
                                                    + " WHERE storage_key = ?")) {
                        freeze.setString(1, physical);
                        assertThat(freeze.executeUpdate()).isEqualTo(1);
                    } catch (java.sql.SQLException error) {
                        throw new IllegalStateException(error);
                    }
                    assertThatThrownBy(
                                    () ->
                                            sessions.lockPublicationWriter(
                                                    TENANT,
                                                    "workspace",
                                                    SESSION,
                                                    "writer",
                                                    generation,
                                                    TOKEN))
                            .hasMessageContaining("Workspace");
                });
    }

    private ManagedSessionStoreModels.CommitTransactionRequest genesis() {
        return genesis("command-genesis");
    }

    private ManagedSessionStoreModels.CommitTransactionRequest genesis(String commandId) {
        byte[] records =
                ("{\"subtype\":\"session_execution_engine\"}\n"
                                + "{\"subtype\":\"managed_session_header_v1\"}\n")
                        .getBytes(StandardCharsets.UTF_8);
        return new ManagedSessionStoreModels.CommitTransactionRequest(
                "workspace",
                "writer",
                generation,
                0,
                0,
                "transaction-genesis",
                "session.create",
                commandId,
                digest("genesis".getBytes(StandardCharsets.UTF_8)),
                0,
                0,
                0,
                null,
                null,
                null,
                0,
                null,
                2,
                Base64.getEncoder().encodeToString(records),
                digest(records),
                List.of());
    }

    private ManagedSessionStoreModels.PublishToolResultRequest result() {
        byte[] bytes = "final bytes".getBytes(StandardCharsets.UTF_8);
        return new ManagedSessionStoreModels.PublishToolResultRequest(
                "workspace",
                "writer",
                generation,
                "final-result",
                "managed-tool-result-content",
                1,
                bytes.length,
                digest(bytes),
                Base64.getEncoder().encodeToString(bytes));
    }

    private static String digest(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }
}
