package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilities;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.managedagent.harness.QwenHostedHarnessConnector;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.DefaultTransactionStatus;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class WorkspaceStorageGuardTest {
    @TempDir
    Path temp;
    private JdbcTemplate jdbc;
    private DriverManagerDataSource dataSource;
    private ManagedAgentProperties properties;
    private Path root;
    private ContextBinding binding;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = new DriverManagerDataSource("jdbc:h2:mem:w1-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        ManagedSchema.initialize(dataSource);
        jdbc = new ManagedSchemaJdbcTemplate(dataSource);
        root = Files.createDirectory(temp.resolve("root")).toRealPath();
        Files.createDirectory(root.resolve("child"));
        properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new WorkspaceMount("tenant", "storage", root.toString())));
        binding = new ContextBinding("tenant", "workspace", 1, "storage", "child",
                "config", 1);
    }

    @Test
    @org.junit.jupiter.api.condition.EnabledOnOs(org.junit.jupiter.api.condition.OS.MAC)
    void nativeMacRegistrationPreservesTheIndependentNanosecondBirthOfAnEmptyRoot() throws Exception {
        root = Files.createDirectory(temp.resolve("empty-native-root")).toRealPath();
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new WorkspaceMount("tenant", "storage", root.toString())));
        var guard = new WorkspaceStorageGuard(jdbc, new DataSourceTransactionManager(dataSource), properties);
        guard.register("tenant", "storage", UUID.randomUUID().toString());
        Process probe = new ProcessBuilder("node", "-e",
                "console.log(require('node:fs').lstatSync(process.argv[1],{bigint:true}).birthtimeNs.toString())",
                root.toString()).start();
        try {
            assertThat(probe.waitFor(5, TimeUnit.SECONDS)).isTrue();
            assertThat(probe.exitValue()).isZero();
            long nanos = Long.parseLong(new String(probe.getInputStream().readAllBytes(),
                    java.nio.charset.StandardCharsets.UTF_8).strip());
            String expected = Instant.ofEpochSecond(nanos / 1_000_000_000L, nanos % 1_000_000_000L).toString();
            assertThat(new ObjectMapper().readTree(Files.readString(root.resolve(".qwen-managed-storage.json")))
                    .path("birthTime").asText()).isEqualTo(expected);
            assertThat(guard.inspect("tenant", "storage")).contains("identity=match");
        } finally {
            probe.destroyForcibly();
        }
    }

    @Test
    @org.junit.jupiter.api.condition.EnabledOnOs({org.junit.jupiter.api.condition.OS.MAC,
            org.junit.jupiter.api.condition.OS.LINUX})
    void nativeRegistrationSurvivesNewGuardAndMtimeChangesButRefusesRootReplacement() throws Exception {
        if ("Linux".equals(System.getProperty("os.name"))) {
            Files.setLastModifiedTime(root, FileTime.fromMillis(1));
        }
        var manager = new DataSourceTransactionManager(dataSource);
        var first = new WorkspaceStorageGuard(jdbc, manager, properties);
        String operation = UUID.randomUUID().toString();
        first.register("tenant", "storage", operation);
        var restarted = new WorkspaceStorageGuard(jdbc, manager, properties);
        if ("Linux".equals(System.getProperty("os.name"))) {
            FileTime birth = Files.readAttributes(root, BasicFileAttributes.class).creationTime();
            Files.setLastModifiedTime(root, birth);
            BasicFileAttributes ambiguous = Files.readAttributes(root, BasicFileAttributes.class);
            assertThat(ambiguous.lastModifiedTime()).isEqualTo(ambiguous.creationTime());
        }
        restarted.verify(binding);
        Files.createDirectory(root.resolve("another-child"));
        restarted.verify(binding);
        Path marker = root.resolve(".qwen-managed-storage.json");
        byte[] savedMarker = Files.readAllBytes(marker);
        Files.writeString(marker, "{}");
        assertUnavailable(() -> restarted.verify(binding));
        assertUnavailable(() -> restarted.register("tenant", "storage", operation));
        Files.write(marker, savedMarker);
        restarted.verify(binding);
        Path previous = root.resolveSibling("previous-native-root");
        Files.move(root, previous);
        Files.createDirectory(root);
        Files.createDirectory(root.resolve("child"));
        Files.write(root.resolve(".qwen-managed-storage.json"), savedMarker);
        assertUnavailable(() -> restarted.verify(binding));
        assertUnavailable(() -> restarted.register("tenant", "storage", operation));
    }

    @Test
    void requiresRegistrationAcrossInstancesAndRejectsReplacedRoot() throws Exception {
        WorkspaceStorageGuard first = guard();
        assertThat(first.inspect("tenant", "storage")).isEqualTo("unverified");
        assertUnavailable(() -> first.verify(binding));
        String operation = UUID.randomUUID().toString();
        first.register("tenant", "storage", operation);
        first.verify(binding);
        guard().verify(binding);
        assertThat(guard().inspect("tenant", "storage")).contains("state=ready revision=1", "holder=false identity=match marker=match");

        Path previous = temp.resolve("previous");
        Files.move(root, previous);
        Files.createDirectory(root);
        Files.createDirectory(root.resolve("child"));
        Files.copy(previous.resolve(".qwen-managed-storage.json"),
                root.resolve(".qwen-managed-storage.json"));
        assertUnavailable(() -> guard().verify(binding));
        assertThat(guard().inspect("tenant", "storage")).contains("identity=mismatch");
        assertUnavailable(() -> guard().register("tenant", "storage", operation));
    }

    @Test
    void probeEnforcesMigrationFenceEvenWhileMountIsReady() throws Exception {
        Path other = Files.createDirectory(temp.resolve("other")).toRealPath();
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new WorkspaceMount("tenant", "storage", root.toString()),
                new WorkspaceMount("tenant", "other", other.toString())));
        guard().register("tenant", "storage", UUID.randomUUID().toString());
        guard().register("tenant", "other", UUID.randomUUID().toString());
        guard().verifyProbe(binding);
        var registrations = jdbc.queryForList("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner ORDER BY storage_key");
        jdbc.update("UPDATE ma_storage SET fence_operation_id = ? WHERE alias_key = ?",
                UUID.randomUUID().toString(), JdbcRuntimeBindingRepository.storageAliasKey("tenant", "storage"));
        assertUnavailable(() -> guard().verify(binding));
        assertUnavailable(() -> guard().verifyProbe(binding));
        guard().verifyProbe(new ContextBinding("tenant", "other-workspace", 1, "other", ".", "config", 1));
        assertThat(jdbc.queryForList("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner ORDER BY storage_key"))
                .isEqualTo(registrations);
    }

    @Test
    void probeRejectsCompletedMigrationWithMismatchedHistoryWithoutMutating() {
        guard().register("tenant", "storage", UUID.randomUUID().toString());
        guard().verifyProbe(binding);
        new WorkspaceOperations(jdbc, "tenant").create(WorkspaceOperations.Kind.STORAGE_MIGRATION, UUID.randomUUID().toString(),
                WorkspaceOperations.values("storage_id", "storage", "state", "COMPLETED", "history_identity_json",
                        "{\"root\":\"" + temp.resolve("missing-history") + "\",\"hostId\":\"test-host\",\"device\":\"test-device\",\"inode\":\"missing\",\"birthTime\":\"missing\"}",
                        "target_registration_id", UUID.randomUUID().toString()));
        var registration = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner");
        var migration = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation");
        assertUnavailable(() -> guard().verify(binding));
        assertUnavailable(() -> guard().verifyProbe(binding));
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner")).isEqualTo(registration);
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation")).isEqualTo(migration);
    }

    @Test
    void historyProbeRetriesIoWithoutChangingAcquireOrStructuralVerdicts() throws Exception {
        Path home = Files.createDirectory(temp.resolve("home")).toRealPath();
        Path fixture = Files.createDirectory(temp.resolve("fork"));
        Path output = temp.resolve("history-probe.log");
        var builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                WorkspaceStorageGuardTest.class.getName(), fixture.toString())
                .redirectErrorStream(true).redirectOutput(output.toFile());
        builder.environment().put("QWEN_HOME", home.toString());
        Process child = builder.start();
        try {
            assertThat(child.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(child.exitValue()).withFailMessage(Files.readString(output)).isZero();
        } finally {
            if (child.isAlive()) {
                child.destroyForcibly();
                child.waitFor(10, TimeUnit.SECONDS);
            }
        }
    }

    public static void main(String[] args) throws Exception {
        var fixture = new WorkspaceStorageGuardTest();
        fixture.temp = Path.of(args[0]);
        fixture.setUp();
        Path history = Files.createDirectory(Path.of(System.getenv("QWEN_HOME")).resolve("file-history"));
        WorkspaceStorageGuard stable = fixture.guard();
        stable.register("tenant", "storage", UUID.randomUUID().toString());
        var attributes = Files.readAttributes(history, BasicFileAttributes.class);
        String identity = new ObjectMapper().writeValueAsString(new WorkspaceStorageGuard.Identity(
                history.toString(), "test-host", "test-device", attributes.fileKey().toString(),
                attributes.creationTime().toInstant().toString()));
        String migrationId = UUID.randomUUID().toString();
        var migrationOperations = new WorkspaceOperations(fixture.jdbc, "tenant");
        migrationOperations.create(WorkspaceOperations.Kind.STORAGE_MIGRATION, migrationId,
                WorkspaceOperations.values("storage_id", "storage", "state", "COMPLETED", "history_identity_json", identity,
                        "target_registration_id", UUID.randomUUID().toString()));
        stable.verifyProbe(fixture.binding);
        stable.verify(fixture.binding);
        var lease = fixture.jdbc.queryForList("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner");
        var migration = fixture.jdbc.queryForList("SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation");
        IOException fault = new IOException("Input/output error");
        var transientHistory = new WorkspaceStorageGuard(fixture.jdbc, new DataSourceTransactionManager(fixture.dataSource),
                fixture.properties, path -> {
                    if (path.equals(history)) {
                        throw fault;
                    }
                    return stable.migrationIdentity(path);
                });
        assertThatThrownBy(() -> transientHistory.verifyProbe(fixture.binding))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getCode()).isEqualTo("workspace_unavailable");
                    assertThat(error.isRetryable()).isTrue();
                    assertThat(error.getCause()).isSameAs(fault);
                });
        assertThatThrownBy(() -> transientHistory.verify(fixture.binding))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> assertThat(error.isRetryable()).isFalse());
        assertThat(fixture.jdbc.queryForList("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner")).isEqualTo(lease);
        assertThat(fixture.jdbc.queryForList("SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation")).isEqualTo(migration);
        for (String invalid : List.of(identity.replace("test-host", "mismatched-host"), "{broken")) {
            migrationOperations.update(WorkspaceOperations.Kind.STORAGE_MIGRATION, migrationId, WorkspaceOperations.values("history_identity_json", invalid));
            assertThatThrownBy(() -> stable.verifyProbe(fixture.binding))
                    .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> assertThat(error.isRetryable()).isFalse());
        }
    }

    @Test
    void rejectsDeletedAndRestoredRootWhenInodeIsReusedButBirthTimeChanges() throws Exception {
        AtomicReference<String> birth = new AtomicReference<>("2026-09-30T00:00:00.123456789Z");
        WorkspaceStorageGuard.IdentityReader reader = path -> new WorkspaceStorageGuard.Identity(
                path.toString(), "test-host", "same-device", "reused-inode", birth.get());
        var manager = new DataSourceTransactionManager(dataSource);
        var original = new WorkspaceStorageGuard(jdbc, manager, properties, reader);
        String operation = UUID.randomUUID().toString();
        original.register("tenant", "storage", operation);
        original.verify(binding);
        Path marker = root.resolve(".qwen-managed-storage.json");
        byte[] backup = Files.readAllBytes(marker);
        var registration = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner");
        Files.delete(marker);
        Files.delete(root.resolve("child"));
        Files.delete(root);
        Files.createDirectory(root);
        Files.createDirectory(root.resolve("child"));
        Files.write(marker, backup);
        birth.set("2026-09-30T00:00:00.123456790Z");
        var restarted = new WorkspaceStorageGuard(jdbc, manager, properties, reader);
        assertThat(restarted.inspect("tenant", "storage"))
                .contains("identity=mismatch", "marker=match");
        assertUnavailable(() -> restarted.verify(binding));
        assertUnavailable(() -> restarted.register("tenant", "storage", operation));
        assertUnavailable(() -> restarted.fence("tenant", "storage", 1, UUID.randomUUID().toString()));
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner"))
                .isEqualTo(registration);
    }

    @Test
    void refusesMissingPersistedBirthTime() {
        guard().register("tenant", "storage", UUID.randomUUID().toString());
        jdbc.update("UPDATE ma_storage_owner SET mount_birth_time = NULL");
        assertUnavailable(() -> guard().verify(binding));
        assertThat(guard().inspect("tenant", "storage")).contains("identity=mismatch");
    }

    @Test
    void reportsUnreadableIdentityWithoutClaimingMismatch() {
        guard().register("tenant", "storage", UUID.randomUUID().toString());
        var unavailable = new WorkspaceStorageGuard(jdbc,
                new DataSourceTransactionManager(dataSource), properties, path -> {
                    throw new IOException("identity is unreadable");
                });
        assertThat(unavailable.inspect("tenant", "storage"))
                .contains("identity=unavailable", "marker=match");
        assertUnavailable(() -> unavailable.verify(binding));
    }

    @Test
    void actionResponseRetriesAMomentaryMountReadWithoutChangingAcquireVerdicts() {
        AtomicInteger unreadable = new AtomicInteger();
        var manager = new DataSourceTransactionManager(dataSource);
        var guard = new WorkspaceStorageGuard(jdbc, manager, properties, path -> {
            if (unreadable.get() != 0) {
                throw new IOException("momentary mount failure");
            }
            return new WorkspaceStorageGuard.Identity(path.toString(), "host", "device", "inode",
                    "2026-10-07T00:00:00Z");
        });
        guard.register("tenant", "storage", UUID.randomUUID().toString());
        String sessionId = UUID.randomUUID().toString();
        var session = new SessionRecord("tenant", sessionId, "qwen-code", null,
                null, "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1,
                binding, "default", "hosted-workspace-files/1");
        var execution = spy(new WorkspaceExecutionStore(jdbc, manager, guard));
        doNothing().when(execution).authorizeActionResponse(session);
        doNothing().when(execution).authorizePassiveAttachment(session);
        var sessions = mock(AgentStateStore.class);
        when(sessions.requireSession("tenant", sessionId)).thenReturn(session);
        var actions = mock(ManagedActionStore.class);
        when(actions.approvalMode("tenant", sessionId)).thenReturn("default");
        properties.getHarness().setToken("test-token");
        properties.getHarness().setCapabilityDigest("sha256:" + "a".repeat(64));
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var connector = new QwenHostedHarnessConnector(properties, sessions, execution, actions);
        var client = mock(HostedHarnessClient.class);
        var capabilities = mock(HostedHarnessCapabilities.class);
        when(client.capabilities()).thenReturn(capabilities);
        String bootId = UUID.randomUUID().toString();
        when(capabilities.getBootId()).thenReturn(bootId);
        var attached = mock(HarnessSessionRef.class);
        when(attached.getHarnessBootId()).thenReturn(bootId);
        when(attached.getApprovalMode()).thenReturn("default");
        when(client.loadSession(any())).thenReturn(attached);
        ReflectionTestUtils.setField(connector, "client", client);
        var response = new ObjectMapper().createObjectNode().put("optionId", "allow")
                .put("inputRevision", 1).put("policyRevision", "policy");
        unreadable.set(1);
        assertThatThrownBy(() -> connector.resolveAction("tenant", sessionId, "action", response))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getCode()).isEqualTo("workspace_unavailable");
                    assertThat(error.isRetryable()).isTrue();
                    assertThat(error.getCause()).isInstanceOf(IOException.class);
                });
        verify(client, never()).resolveAction(any(), any(), any(), anyLong(), any());
        assertThatThrownBy(() -> guard.verify(binding))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.isRetryable()).isFalse());
        unreadable.set(0);
        connector.resolveAction("tenant", sessionId, "action", response);
        verify(client).resolveAction(attached, "action", "allow", 1L, "policy");
        // Positive control: the probe-only retry leaves the shared acquire
        // path's verdict untouched — a settled mount still authorizes.
        guard.verify(binding);
    }

    @Test
    void actionResponseRetriesARevokedGrantWhileKeepingStructuralRefusalsTerminal() {
        var manager = new DataSourceTransactionManager(dataSource);
        var guard = new WorkspaceStorageGuard(jdbc, manager, properties, path ->
                new WorkspaceStorageGuard.Identity(path.toString(), "host", "device", "inode",
                        "2026-10-07T00:00:00Z"));
        guard.register("tenant", "storage", UUID.randomUUID().toString());
        // The action-response authority is derived from the real grant rows,
        // not injected.
        var execution = spy(new WorkspaceExecutionStore(jdbc, manager, guard));
        var bound = new ContextBinding("tenant", "workspace", 1, "storage", "child",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        String sessionId = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status,"
                + " gmt_create, gmt_modified, workspace_id, workspace_generation, workspace_storage_id,"
                + " cwd_relative, context_config_ref, context_revision, workspace_config_ref,"
                + " workspace_policy_ref) VALUES ('tenant', ?, 'qwen-code', 'ACTIVE', 0, 0,"
                + " 'workspace', 1, 'storage', 'child', ?, 1, ?, ?)",
                sessionId, WorkspaceExecutionProfile.CONTEXT_CONFIG_REF,
                WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id,"
                + " workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                + " VALUES ('tenant', 'workspace', 1, 'storage', 'workspace', ?, ?, 'ACTIVE')",
                WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("UPDATE ma_session SET creator_actor_key = ?, owner_actor_key = ? WHERE tenant_id = X'74656e616e74' AND session_id = ?",
                "owner".getBytes(java.nio.charset.StandardCharsets.UTF_8), "owner".getBytes(java.nio.charset.StandardCharsets.UTF_8), sessionId);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id,"
                + " role) VALUES ('tenant', 'workspace', ?, 'OPERATOR')",
                "owner".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        var session = new SessionRecord("tenant", sessionId, "qwen-code", null,
                null, "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1,
                bound, "default", "hosted-workspace-files/1");
        var sessions = mock(AgentStateStore.class);
        when(sessions.requireSession("tenant", sessionId)).thenReturn(session);
        var actions = mock(ManagedActionStore.class);
        when(actions.approvalMode("tenant", sessionId)).thenReturn("default");
        properties.getHarness().setToken("test-token");
        properties.getHarness().setCapabilityDigest("sha256:" + "a".repeat(64));
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var connector = new QwenHostedHarnessConnector(properties, sessions, execution, actions);
        var client = mock(HostedHarnessClient.class);
        var capabilities = mock(HostedHarnessCapabilities.class);
        when(client.capabilities()).thenReturn(capabilities);
        String bootId = UUID.randomUUID().toString();
        when(capabilities.getBootId()).thenReturn(bootId);
        var attached = mock(HarnessSessionRef.class);
        when(attached.getHarnessBootId()).thenReturn(bootId);
        when(attached.getApprovalMode()).thenReturn("default");
        when(client.loadSession(any())).thenReturn(attached);
        ReflectionTestUtils.setField(connector, "client", client);
        var response = new ObjectMapper().createObjectNode().put("optionId", "allow")
                .put("inputRevision", 1).put("policyRevision", "policy");
        doAnswer(invocation -> {
            invocation.callRealMethod();
            assertThat(jdbc.update("UPDATE ma_workspace_access SET role = 'READER'"
                    + " WHERE tenant_id = X'74656e616e74' AND workspace_id = X'776f726b7370616365'")).isEqualTo(1);
            return null;
        }).doCallRealMethod().when(execution).authorizeActionResponse(session);
        assertThatThrownBy(() -> connector.resolveAction("tenant", sessionId, "action", response))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getCode()).isEqualTo("workspace_unavailable");
                    assertThat(error.isRetryable()).isTrue();
                });
        // A revoked creation grant is operator-reversible: the refusal must
        // stay retryable so a restored grant still delivers the answer.
        jdbc.update("UPDATE ma_workspace_access SET role = 'READER'"
                + " WHERE tenant_id = X'74656e616e74' AND workspace_id = X'776f726b7370616365'");
        assertThatThrownBy(() -> connector.resolveAction("tenant", sessionId, "action", response))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getCode()).isEqualTo("workspace_unavailable");
                    assertThat(error.isRetryable()).isTrue();
                });
        // So is a registry that left ACTIVE.
        jdbc.update("UPDATE ma_workspace_access SET role = 'OPERATOR'"
                + " WHERE tenant_id = X'74656e616e74' AND workspace_id = X'776f726b7370616365'");
        jdbc.update("UPDATE ma_workspace SET state = 'DRAINING'"
                + " WHERE tenant_id = X'74656e616e74' AND workspace_id = X'776f726b7370616365'");
        assertThatThrownBy(() -> connector.resolveAction("tenant", sessionId, "action", response))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getCode()).isEqualTo("workspace_unavailable");
                    assertThat(error.isRetryable()).isTrue();
                });
        verify(client, never()).resolveAction(any(), any(), any(), anyLong(), any());
        // Restored, the committed decision reaches the Harness.
        jdbc.update("UPDATE ma_workspace SET state = 'ACTIVE'"
                + " WHERE tenant_id = X'74656e616e74' AND workspace_id = X'776f726b7370616365'");
        connector.resolveAction("tenant", sessionId, "action", response);
        verify(client).resolveAction(attached, "action", "allow", 1L, "policy");
        // Generation drift after a re-registration stays structural: the
        // terminal exit keeps its verdict.
        jdbc.update("UPDATE ma_workspace SET workspace_generation = 2"
                + " WHERE tenant_id = X'74656e616e74' AND workspace_id = X'776f726b7370616365'");
        assertThatThrownBy(() -> connector.resolveAction("tenant", sessionId, "action", response))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getCode()).isEqualTo("workspace_unavailable");
                    assertThat(error.isRetryable()).isFalse();
                });
        verify(client).resolveAction(any(), any(), any(), anyLong(), any());
    }

    @Test
    void refusesDirectoryAndSymlinkMarkersWithoutChangingRegistration() throws Exception {
        String operation = UUID.randomUUID().toString();
        guard().register("tenant", "storage", operation);
        var registration = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner");
        Path marker = root.resolve(".qwen-managed-storage.json");
        Path saved = temp.resolve("marker-backup");
        Files.move(marker, saved);
        Files.createDirectory(marker);
        assertUnavailable(() -> guard().verify(binding));
        assertThat(guard().inspect("tenant", "storage")).contains("marker=unavailable");
        assertUnavailable(() -> guard().register("tenant", "storage", operation));
        assertUnavailable(() -> guard().fence("tenant", "storage", 1, UUID.randomUUID().toString()));
        Files.delete(marker);
        Files.createSymbolicLink(marker, saved);
        assertUnavailable(() -> guard().verify(binding));
        assertThat(guard().inspect("tenant", "storage")).contains("marker=unavailable");
        assertUnavailable(() -> guard().register("tenant", "storage", operation));
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner"))
                .isEqualTo(registration);
        Files.delete(marker);
        Files.move(saved, marker);
        guard().verify(binding);
    }

    @Test
    void nativeBirthEvidenceRequiresTheSameRootAndFullNanosecondBirthTime() throws Exception {
        FileTime birth = FileTime.from(Instant.parse("2026-09-30T00:00:00.123456789Z"));
        String evidence = "7|42|2026-09-30 00:00:00.123456789 +0000";
        assertThat(WorkspaceStorageGuard.verifiedNativeBirthTime(evidence, "7", "42", birth))
                .isEqualTo(birth.toInstant().toString());
        for (String invalid : List.of(
                "8|42|2026-09-30 00:00:00.123456789 +0000",
                "7|43|2026-09-30 00:00:00.123456789 +0000",
                "7|42|2026-09-30 00:00:00.987654321 +0000",
                "7|42|-",
                "7|42|1970-01-01 00:00:00.000000000 +0000",
                "7|42|2026-02-30 00:00:00.123456789 +0000",
                evidence + "|extra")) {
            assertThatThrownBy(() -> WorkspaceStorageGuard.verifiedNativeBirthTime(invalid, "7", "42", birth))
                    .isInstanceOf(IOException.class);
        }
    }

    @Test
    void rejectsUnavailableAndAmbiguousBirthTimeWithoutUsingDirectoryMtimeAsIdentity() throws Exception {
        FileTime birth = FileTime.from(Instant.parse("2026-09-30T00:00:00.123456789Z"));
        assertThatThrownBy(() -> WorkspaceStorageGuard.verifiedBirthTime(birth, birth))
                .isInstanceOf(java.io.IOException.class);
        assertThatThrownBy(() -> WorkspaceStorageGuard.verifiedBirthTime(FileTime.fromMillis(0), birth))
                .isInstanceOf(java.io.IOException.class);
        assertThat(WorkspaceStorageGuard.verifiedBirthTime(birth, FileTime.fromMillis(1)))
                .isEqualTo("2026-09-30T00:00:00.123456789Z");
        assertThat(WorkspaceStorageGuard.verifiedBirthTime(birth, FileTime.fromMillis(2)))
                .isEqualTo("2026-09-30T00:00:00.123456789Z");
    }

    @Test
    void retriesOnlyOriginalRegistrationAndNeverRecreatesMissingMarker() throws Exception {
        String operation = UUID.randomUUID().toString();
        guard().register("tenant", "storage", operation);
        assertUnavailable(() -> guard().register("tenant", "storage", UUID.randomUUID().toString()));
        jdbc.update("UPDATE ma_storage_owner"
                + " SET mount_state = 'UNVERIFIED', mount_revision = 0, mount_operation_id = ?",
                operation);
        assertUnavailable(() -> guard().register("tenant", "storage", UUID.randomUUID().toString()));
        guard().register("tenant", "storage", operation);
        assertThat(jdbc.queryForObject("SELECT mount_revision FROM ma_storage_owner",
                Long.class)).isEqualTo(1);
        Files.delete(root.resolve(".qwen-managed-storage.json"));
        assertUnavailable(() -> guard().verify(binding));
        assertThat(guard().inspect("tenant", "storage")).contains("marker=unavailable");
        assertUnavailable(() -> guard().register("tenant", "storage", operation));
        assertThat(Files.exists(root.resolve(".qwen-managed-storage.json"))).isFalse();
    }

    @Test
    void persistedFenceBlocksNewWorkAndRequiresExactRevision() {
        guard().register("tenant", "storage", UUID.randomUUID().toString());
        String operation = UUID.randomUUID().toString();
        assertUnavailable(() -> guard().fence("tenant", "storage", 0, operation));
        guard().fence("tenant", "storage", 1, operation);
        guard().fence("tenant", "storage", 1, operation);
        assertThat(guard().inspect("tenant", "storage")).contains("state=fenced revision=1", "operation=" + operation);
        assertUnavailable(() -> guard().verify(binding));
        assertUnavailable(() -> guard().fence("tenant", "storage", 1,
                UUID.randomUUID().toString()));
        assertThat(jdbc.queryForObject("SELECT mount_operation_id"
                + " FROM ma_storage_owner", String.class)).isEqualTo(operation);
        assertUnavailable(() -> guard().restoreOriginal("tenant", "storage", 1,
                UUID.randomUUID().toString()));
        guard().restoreOriginal("tenant", "storage", 1, operation);
        guard().restoreOriginal("tenant", "storage", 1, operation);
        assertThat(guard().inspect("tenant", "storage")).contains("state=ready revision=2", "identity=match marker=match");
        assertUnavailable(() -> guard().fence("tenant", "storage", 1, operation));
        guard().verify(binding);
    }

    @Test
    void concurrentRegistrationConvergesAfterBothPreparedTransactionsCommit() throws Exception {
        CountDownLatch prepared = new CountDownLatch(2);
        ThreadLocal<Integer> commits = ThreadLocal.withInitial(() -> 0);
        DataSourceTransactionManager manager = new DataSourceTransactionManager(dataSource) {
            @Override
            protected void doCommit(DefaultTransactionStatus status) {
                super.doCommit(status);
                commits.set(commits.get() + 1);
                if (commits.get() == 1) {
                    prepared.countDown();
                    try {
                        if (!prepared.await(5, TimeUnit.SECONDS)) {
                            throw new IllegalStateException("Both registrations must prepare");
                        }
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException(error);
                    }
                }
            }
        };
        String operation = UUID.randomUUID().toString();
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> guard(manager).register("tenant", "storage", operation));
            var second = executor.submit(() -> guard(manager).register("tenant", "storage", operation));
            first.get(10, TimeUnit.SECONDS);
            second.get(10, TimeUnit.SECONDS);
        }
        assertThat(jdbc.queryForObject("SELECT mount_revision FROM ma_storage_owner",
                Long.class)).isEqualTo(1);
        guard().verify(binding);
        guard().register("tenant", "storage", operation);
    }

    @Test
    void retriesRegistrationAfterReadyCommitAcknowledgmentIsLost() {
        AtomicInteger commits = new AtomicInteger();
        DataSourceTransactionManager manager = new DataSourceTransactionManager(dataSource) {
            @Override
            protected void doCommit(DefaultTransactionStatus status) {
                super.doCommit(status);
                if (commits.incrementAndGet() == 2) {
                    throw new IllegalStateException("READY acknowledgment lost");
                }
            }
        };
        String operation = UUID.randomUUID().toString();
        assertThatThrownBy(() -> guard(manager).register("tenant", "storage", operation))
                .isInstanceOf(IllegalStateException.class);
        var committed = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner");
        assertThat(committed.get("mount_state")).isEqualTo("READY");
        guard().register("tenant", "storage", operation);
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner")).isEqualTo(committed);
        guard().verify(binding);
    }

    @Test
    void restoreRetryVerifiesPhysicalStateAndPreservesNewHolder() throws Exception {
        guard().register("tenant", "storage", UUID.randomUUID().toString());
        String operation = UUID.randomUUID().toString();
        guard().fence("tenant", "storage", 1, operation);
        guard().restoreOriginal("tenant", "storage", 1, operation);
        jdbc.update("UPDATE ma_storage_owner SET holder_key = 'new-holder'");
        var committed = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner");
        guard().restoreOriginal("tenant", "storage", 1, operation);
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner")).isEqualTo(committed);
        Path marker = root.resolve(".qwen-managed-storage.json");
        byte[] original = Files.readAllBytes(marker);
        Files.delete(marker);
        assertUnavailable(() -> guard().restoreOriginal("tenant", "storage", 1, operation));
        Files.write(marker, original);
        Files.move(root, temp.resolve("old-root"));
        Files.createDirectory(root);
        Files.write(root.resolve(".qwen-managed-storage.json"), original);
        assertUnavailable(() -> guard().restoreOriginal("tenant", "storage", 1, operation));
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner")).isEqualTo(committed);
    }

    @Test
    void fencedInspectionReportsPhysicalDamageAndHolderWithoutMutating() throws Exception {
        guard().register("tenant", "storage", UUID.randomUUID().toString());
        String operation = UUID.randomUUID().toString();
        guard().fence("tenant", "storage", 1, operation);
        jdbc.update("UPDATE ma_storage_owner SET holder_key = 'retained-owner'");
        Files.move(root, temp.resolve("old-root"));
        Files.createDirectory(root);
        var committed = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner");
        assertThat(guard().inspect("tenant", "storage"))
                .contains("state=fenced revision=1", "operation=" + operation,
                        "holder=true", "identity=mismatch", "marker=unavailable");
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner")).isEqualTo(committed);
        assertThat(Files.exists(root.resolve(".qwen-managed-storage.json"))).isFalse();
    }

    @Test
    void sameOperationConcurrentFencesConvergeAndOtherOperationsRefuse() throws Exception {
        guard().register("tenant", "storage", UUID.randomUUID().toString());
        String operation = UUID.randomUUID().toString();
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> guard().fence("tenant", "storage", 1, operation));
            var second = executor.submit(() -> guard().fence("tenant", "storage", 1, operation));
            first.get(10, TimeUnit.SECONDS);
            second.get(10, TimeUnit.SECONDS);
        }
        assertUnavailable(() -> guard().fence("tenant", "storage", 1, UUID.randomUUID().toString()));
        assertThat(guard().inspect("tenant", "storage")).contains("operation=" + operation);
    }

    private WorkspaceStorageGuard guard() {
        return guard(new DataSourceTransactionManager(dataSource));
    }

    private WorkspaceStorageGuard guard(PlatformTransactionManager manager) {
        return new WorkspaceStorageGuard(jdbc, manager, properties, path -> {
            BasicFileAttributes attributes = Files.readAttributes(path,
                            BasicFileAttributes.class);
            if (!attributes.isDirectory() || !path.equals(path.toRealPath())) {
                throw new java.io.IOException("Root changed");
            }
            return new WorkspaceStorageGuard.Identity(path.toString(), "test-host",
            "test-device", attributes.fileKey().toString(), attributes.creationTime().toInstant().toString());
        });
    }

    private static void assertUnavailable(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
    }
}
