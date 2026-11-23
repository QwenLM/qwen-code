package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.managedagent.contracts.workspace.StorageIdentityReader;
import com.alibaba.qwen.code.managedagent.contracts.workspace.StorageIdentityReader.Identity;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Plan;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class WorkspaceIdentityReattestationStoreTest {
    private static final ObjectMapper JSON = new ObjectMapper().enable(DeserializationFeature.USE_LONG_FOR_INTS);
    private static final String VOLUME = "0123456789abcdef0123456789abcdef";
    @TempDir Path temp;
    private Path root;
    private JdbcTemplate jdbc;
    private WorkspaceStorageGuard guard;
    private WorkspaceIdentityReattestationStore store;
    private WorktreeFiles worktrees;
    private AtomicReference<Identity> observed;
    private AtomicReference<Identity> numeric;
    private Identity legacy;
    private ObjectNode input;
    private ContextBinding binding;

    @BeforeEach
    void setup() throws Exception {
        root = temp.toRealPath();
        var data = new DriverManagerDataSource("jdbc:h2:mem:reattest-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1", "sa", "");
        ManagedSchema.initialize(data);
        jdbc = new ManagedSchemaJdbcTemplate(data);
        var manager = new DataSourceTransactionManager(data);
        var settings = new ManagedAgentProperties();
        settings.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        settings.getRuntimeBroker().setWorkspaceMounts(List.of(new WorkspaceMount("tenant", "storage", root.toString())));
        legacy = new Identity(root.toString(), "host", "16777234", "123", "2026-01-01T00:00:00Z");
        observed = new AtomicReference<>(legacy);
        numeric = new AtomicReference<>(legacy);
        StorageIdentityReader reader = new StorageIdentityReader() {
            public Identity read(Path path) { return observed.get(); }
            public Identity readLegacy(Path path) { return numeric.get(); }
        };
        guard = new WorkspaceStorageGuard(jdbc, manager, settings, reader);
        guard.register("tenant", "storage", UUID.randomUUID().toString());
        observed.set(new Identity(root.toString(), "host", VOLUME, "123", legacy.birthTime()));
        worktrees = mock(WorktreeFiles.class);
        store = new WorkspaceIdentityReattestationStore(jdbc, manager, guard, reader, worktrees);
        input = JSON.createObjectNode().put("type", WorkspaceIdentityReattestationStore.TYPE)
                .put("operationId", UUID.randomUUID().toString()).put("tenantId", "tenant").put("storageId", "storage")
                .put("physicalKey", LocalStorageOwners.physicalKey(legacy)).put("hostId", "host").put("volumeUuid", VOLUME);
        binding = new ContextBinding("tenant", "workspace", 1, "storage", ".", "config", 1);
    }

    @Test
    void explicitUpgradeRetainsOldEvidenceAndStableKeyAcrossTransientDeviceChange() throws Exception {
        byte[] original = Files.readAllBytes(root.resolve(WorkspaceStorageMarkers.FILE_NAME));
        guard.verify(binding);
        numeric.set(new Identity(root.toString(), legacy.hostId(), "16777229", legacy.inode(), legacy.birthTime()));
        assertThatThrownBy(() -> guard.verify(binding)).isInstanceOf(RuntimeException.class);
        JsonNode plan = store.plan(input);
        assertThat(Files.readAllBytes(root.resolve(WorkspaceStorageMarkers.FILE_NAME))).isEqualTo(original);
        store.begin(plan);
        assertThatThrownBy(() -> guard.verify(binding)).isInstanceOf(RuntimeException.class);
        store.complete(plan);
        guard.verify(binding);
        assertThat(guard.fileRoot(binding).get("device")).isEqualTo(numeric.get().device());
        assertThat(jdbc.queryForObject("SELECT physical_id FROM ma_storage", String.class))
                .isEqualTo(LocalStorageOwners.physicalKey(observed.get())).isNotEqualTo(input.path("physicalKey").asText());
        assertThat(JSON.readTree(Files.readString(root.resolve(WorkspaceStorageMarkers.FILE_NAME))).path("version").asInt()).isEqualTo(3);
        assertThat(jdbc.queryForObject("SELECT phase FROM ma_operation WHERE operation_kind = 'STORAGE_MIGRATION'", String.class))
                .isEqualTo("IDENTITY_REATTESTATION");
        assertThat(jdbc.queryForObject("SELECT request_json FROM ma_operation WHERE operation_kind = 'STORAGE_MIGRATION'", String.class))
                .contains(Base64.getEncoder().encodeToString(original));
        long revision = jdbc.queryForObject("SELECT mount_revision FROM ma_storage_owner", Long.class);
        store.begin(plan);
        store.complete(plan);
        assertThat(jdbc.queryForObject("SELECT mount_revision FROM ma_storage_owner", Long.class)).isEqualTo(revision);
        observed.set(new Identity(root.toString(), "host", "a".repeat(32), "123", legacy.birthTime()));
        assertThatThrownBy(() -> guard.verify(binding)).isInstanceOf(RuntimeException.class);
    }

    @Test
    void refusesChangedInodeBirthHostVolumeAndUnlistedAliasWithoutInstallingFence() throws Exception {
        var stable = observed.get();
        for (Identity changed : List.of(new Identity(root.toString(), "foreign", VOLUME, "123", legacy.birthTime()),
                new Identity(root.toString(), "host", VOLUME, "124", legacy.birthTime()),
                new Identity(root.toString(), "host", VOLUME, "123", "2026-01-02T00:00:00Z"),
                new Identity(root.toString(), "host", "a".repeat(32), "123", legacy.birthTime()))) {
            observed.set(changed);
            assertThatThrownBy(() -> store.plan(input)).hasMessageContaining("identity_changed");
        }
        observed.set(stable);
        JsonNode plan = store.plan(input);
        jdbc.update("UPDATE ma_storage SET registration_revision = registration_revision + 1");
        assertThatThrownBy(() -> store.begin(plan)).hasMessageContaining("inventory_changed");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE fence_operation_id IS NOT NULL", Long.class)).isZero();
    }

    @Test
    void markerConflictLeavesDurableFenceAndExactRequestCanRetry() throws Exception {
        JsonNode plan = store.plan(input);
        store.begin(plan);
        Path marker = root.resolve(WorkspaceStorageMarkers.FILE_NAME);
        byte[] original = Files.readAllBytes(marker);
        Files.writeString(marker, "{}");
        assertThatThrownBy(() -> store.complete(plan)).hasMessageContaining("marker_changed");
        assertThat(jdbc.queryForObject("SELECT fence_operation_id FROM ma_storage", String.class)).isEqualTo(input.path("operationId").asText());
        var conflict = ((ObjectNode) plan).deepCopy().put("hostId", "other");
        assertThatThrownBy(() -> store.begin(conflict)).hasMessageContaining("operation_conflict");
        Files.write(marker, original);
        byte[] after = Base64.getDecoder().decode(plan.path("inventory").path("files").get(0).path("after").asText());
        Files.write(marker.resolveSibling(marker.getFileName() + "." + input.path("operationId").asText() + ".tmp"), java.util.Arrays.copyOf(after, 10),
                StandardOpenOption.CREATE_NEW);
        store.complete(plan);
        assertThat(Files.readAllBytes(marker)).isEqualTo(after);
        jdbc.update("UPDATE ma_storage SET registration_revision = registration_revision + 1");
        assertThatThrownBy(() -> store.complete(plan)).hasMessageContaining("committed_alias_changed");
    }

    @Test
    void activeHolderAndExecutionMembershipCannotBeClearedByTheUpgrade() throws Exception {
        JsonNode plan = store.plan(input);
        store.begin(plan);
        jdbc.update("UPDATE ma_storage_owner SET member_count = 1");
        assertThatThrownBy(() -> store.complete(plan)).hasMessageContaining("writers_active");
        assertThat(jdbc.queryForObject("SELECT member_count FROM ma_storage_owner", Long.class)).isEqualTo(1);
        jdbc.update("UPDATE ma_storage_owner SET member_count = 0, holder_id = ?", "a".repeat(64));
        assertThatThrownBy(() -> store.complete(plan)).hasMessageContaining("writers_active");
        assertThat(jdbc.queryForObject("SELECT holder_id FROM ma_storage_owner", String.class)).isEqualTo("a".repeat(64));
    }

    @Test
    void copiedMarkerOnOverlappingOwnerDoesNotAuthorizeMerge() throws Exception {
        jdbc.update("INSERT INTO ma_storage_owner (physical_id, mount_host_id, mount_root, storage_kind)"
                + " VALUES (?, 'host', ?, 'LOCAL')", "b".repeat(64), root.toString());
        assertThatThrownBy(() -> store.plan(input)).hasMessageContaining("overlapping_owner");
    }

    @Test
    void incompleteAliasRegistrationCannotJoinTheUpgrade() {
        jdbc.update("UPDATE ma_storage SET registration_state = 'FENCE_ONLY', registration_revision = NULL");
        assertThatThrownBy(() -> store.plan(input)).hasMessageContaining("alias_inventory_conflict");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'STORAGE_MIGRATION'", Long.class)).isZero();
    }

    @Test
    void onlyAParkedHarnessTurnCanRetainItsStatusAcrossTheIdentityUpgrade() throws Exception {
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified,"
                + " workspace_id, workspace_generation, workspace_storage_id, cwd_relative, context_config_ref,"
                + " context_revision, workspace_config_ref, workspace_policy_ref)"
                + " VALUES ('tenant', 'session', 'qwen-code', 'ACTIVE', 1, 1, 'workspace', 1, 'storage', '.', 'config', 1, 'config', 'policy')");
        jdbc.update("INSERT INTO ma_turn (tenant_id, session_id, turn_id, prompt_id, input_json, payload_digest,"
                + " status, is_submission_attempted, gmt_create, gmt_modified, version)"
                + " VALUES ('tenant', 'session', 'turn', 'prompt', '[]', 'digest', 'RUNNING', TRUE, 1, 1, 1)");
        JsonNode plan = store.plan(input);
        store.begin(plan);
        assertThatThrownBy(() -> store.complete(plan)).hasMessageContaining("turn_active");
        jdbc.update("UPDATE ma_turn SET error_code = 'runtime_other_failure'");
        assertThatThrownBy(() -> store.complete(plan)).hasMessageContaining("turn_active");
        jdbc.update("UPDATE ma_turn SET error_code = 'hosted_harness_recovery_blocked', is_submission_attempted = FALSE");
        assertThatThrownBy(() -> store.complete(plan)).hasMessageContaining("turn_active");
        jdbc.update("UPDATE ma_turn SET is_submission_attempted = TRUE");
        store.complete(plan);
        assertThat(jdbc.queryForObject("SELECT status FROM ma_turn", String.class)).isEqualTo("RUNNING");
        assertThat(jdbc.queryForObject("SELECT error_code FROM ma_turn", String.class)).isEqualTo("hosted_harness_recovery_blocked");
    }

    @Test
    void mixedAnchorInventoryUpgradesLegacyWorktreesAndCarriesStableOnesUnchanged() throws Exception {
        String prefix = "macos-volume/1:" + VOLUME + ":";
        String legacyRoot = "(dev=1000003,ino=123):2026-01-01T00:00:00Z";
        String legacyCommon = "(dev=1000003,ino=124):2026-01-01T00:00:00Z";
        String stableRoot = prefix + "123:2026-01-01T00:00:00Z";
        String stableCommon = prefix + "124:2026-01-01T00:00:00Z";
        String legacyCompletion = completion("(dev=1000003,ino=201):2026-01-01T00:00:00Z",
                "(dev=1000003,ino=202):2026-01-01T00:00:00Z", "(dev=1000003,ino=203):2026-01-01T00:00:00Z");
        String stableCompletion = completion(prefix + "201:2026-01-01T00:00:00Z",
                prefix + "202:2026-01-01T00:00:00Z", prefix + "203:2026-01-01T00:00:00Z");
        Plan legacyCheckout = seedCheckout("session-legacy", legacyRoot, legacyCommon, legacyCompletion);
        Plan stableCheckout = seedCheckout("session-stable", stableRoot, stableCommon, stableCompletion);
        Plan mixedCheckout = seedCheckout("session-mixed", legacyRoot, legacyCommon, stableCompletion);
        when(worktrees.reattest(any(), any(), any())).thenAnswer(invocation -> {
            Plan plan = invocation.getArgument(0);
            String saved = invocation.getArgument(1);
            if (!plan.rootIdentity().startsWith("(dev=")) {
                throw new ManagedAgentException(409, "worktree_identity_conflict", "Offline re-attestation requires a legacy anchor.");
            }
            ObjectNode upgraded = (ObjectNode) JSON.valueToTree(plan);
            upgraded.put("rootIdentity", stableRoot).put("commonIdentity", stableCommon);
            String identity = JSON.readTree(saved).path("target").asText().startsWith("macos-volume/1:") ? saved : stableCompletion;
            return Map.of("plan", JSON.writeValueAsString(upgraded), "identity", identity);
        });
        JsonNode plan = store.plan(input);
        verify(worktrees, times(2)).reattest(any(), any(), any());
        verify(worktrees, times(1)).verify(any(), any());
        JsonNode rows = plan.path("inventory").path("worktrees");
        JsonNode stableRow = row(rows, stableCheckout.worktreeId());
        assertThat(stableRow.path("new_plan_json").asText()).isEqualTo(JSON.writeValueAsString(stableCheckout));
        assertThat(stableRow.path("new_identity_json").asText()).isEqualTo(stableCompletion);
        JsonNode mixedRow = row(rows, mixedCheckout.worktreeId());
        assertThat(mixedRow.path("new_identity_json").asText()).isEqualTo(stableCompletion);
        assertThat(JSON.readTree(mixedRow.path("new_plan_json").asText()).path("rootIdentity").asText()).isEqualTo(stableRoot);
        for (JsonNode file : plan.path("inventory").path("files")) {
            if (file.path("path").asText().contains(stableCheckout.worktreeId())) {
                assertThat(file.path("before").asText()).isEqualTo(file.path("after").asText());
            }
        }
        store.begin(plan);
        store.complete(plan);
        String nextKey = plan.path("inventory").path("newPhysicalKey").asText();
        assertThat(jdbc.queryForObject("SELECT plan_json FROM ma_session_worktree WHERE session_id = ?", String.class, "session-stable"))
                .isEqualTo(JSON.writeValueAsString(stableCheckout));
        assertThat(jdbc.queryForObject("SELECT identity_json FROM ma_session_worktree WHERE session_id = ?", String.class, "session-stable"))
                .isEqualTo(stableCompletion);
        assertThat(jdbc.queryForList("SELECT session_id FROM ma_session_worktree WHERE physical_id = ? AND state = 'READY' AND revision = 2",
                String.class, nextKey)).containsExactlyInAnyOrder("session-legacy", "session-stable", "session-mixed");
    }

    @Test
    void stableAnchorsOutsideTheAttestedVolumeOrGenerationAreRefusedWithoutFence() throws Exception {
        String foreign = "macos-volume/1:" + "a".repeat(32) + ":";
        String stableRoot = "macos-volume/1:" + VOLUME + ":123:2026-01-01T00:00:00Z";
        String stableCommon = "macos-volume/1:" + VOLUME + ":124:2026-01-01T00:00:00Z";
        seedCheckout("session-foreign", foreign + "123:2026-01-01T00:00:00Z", foreign + "124:2026-01-01T00:00:00Z",
                completion(foreign + "201:2026-01-01T00:00:00Z", foreign + "202:2026-01-01T00:00:00Z", foreign + "203:2026-01-01T00:00:00Z"));
        assertThatThrownBy(() -> store.plan(input)).hasMessageContaining("worktree_identity_conflict");
        jdbc.update("DELETE FROM ma_session_worktree");
        seedCheckout("session-mixed-generation", stableRoot, stableCommon,
                completion("(dev=1000003,ino=201):2026-01-01T00:00:00Z", "(dev=1000003,ino=202):2026-01-01T00:00:00Z",
                        "(dev=1000003,ino=203):2026-01-01T00:00:00Z"));
        assertThatThrownBy(() -> store.plan(input)).hasMessageContaining("worktree_identity_conflict");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE fence_operation_id IS NOT NULL", Long.class)).isZero();
    }

    private Plan seedCheckout(String sessionId, String rootIdentity, String commonIdentity, String identityJson) throws Exception {
        String worktreeId = UUID.randomUUID().toString().replace("-", "");
        String directory = ".qwen-managed-worktrees/" + worktreeId;
        Plan plan = new Plan("tenant", "workspace", 1, "storage", "project", "config", 1, root.toString(),
                rootIdentity, "project", ".", root.resolve("project/.git").toString(), commonIdentity,
                null, "a".repeat(40), worktreeId, directory, directory, "worktree-managed-" + worktreeId);
        String planJson = JSON.writeValueAsString(plan);
        String operationId = "worktree-op-" + worktreeId;
        new WorkspaceOperations(jdbc, "tenant").create(WorkspaceOperations.Kind.SESSION_WORKTREE, operationId,
                WorkspaceOperations.values("storage_id", "storage", "session_id", sessionId, "state", "READY"));
        jdbc.update("INSERT INTO ma_session_worktree (tenant_id, session_id, workspace_id, storage_id, physical_id,"
                + " worktree_id, owner_actor_key, state, revision, plan_json, identity_json, operation_id, failure_code,"
                + " gmt_create, gmt_modified) VALUES ('tenant', ?, 'workspace', 'storage', ?, ?, 'actor', 'READY', 1, ?, ?, ?, NULL, 1, 1)",
                sessionId, input.path("physicalKey").asText(), worktreeId, planJson, identityJson, operationId);
        Path container = Files.createDirectories(root.resolve(".qwen-managed-worktrees"));
        Files.writeString(container.resolve(worktreeId + ".json"), planJson);
        Files.writeString(container.resolve(worktreeId + ".ready"), identityJson);
        return plan;
    }

    private String completion(String target, String gitfile, String gitdirIdentity) {
        return JSON.createObjectNode().put("target", target).put("gitfile", gitfile)
                .put("gitdir", root.resolve(".git/worktrees/checkout").toString())
                .put("gitdirIdentity", gitdirIdentity).toString();
    }

    private static JsonNode row(JsonNode rows, String worktreeId) {
        for (JsonNode row : rows) {
            if (worktreeId.equals(row.path("worktree_id").asText())) {
                return row;
            }
        }
        throw new AssertionError("Missing worktree row " + worktreeId);
    }
}
