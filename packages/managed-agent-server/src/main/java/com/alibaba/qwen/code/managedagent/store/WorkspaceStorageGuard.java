package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.MacOsHostIdentity;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.HmacAlgorithms;
import org.apache.commons.codec.digest.HmacUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AccessDeniedException;
import java.nio.file.AccessMode;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.security.GeneralSecurityException;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.ResolverStyle;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

@Component
public class WorkspaceStorageGuard {
    private static final String MARKER = ".qwen-managed-storage.json";
    private static final DateTimeFormatter LINUX_BIRTH_TIME_FORMAT = DateTimeFormatter
            .ofPattern("uuuu-MM-dd HH:mm:ss.SSSSSSSSS xx", Locale.ROOT)
            .withResolverStyle(ResolverStyle.STRICT);
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final Map<Storage, Path> roots;
    private final WorkspaceCreationRoots createdRoots;
    private final boolean enabled;
    private final IdentityReader identities;
    private SshWorkspaceStore ssh;
    private final ObjectMapper json = new ObjectMapper();

    @Autowired
    public WorkspaceStorageGuard(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ManagedAgentProperties properties) {
        this(jdbc, manager, properties, WorkspaceStorageGuard::nativeIdentity);
        if (enabled && !List.of("Linux", "Mac OS X").contains(System.getProperty("os.name"))) {
            throw new IllegalStateException("Verified Workspace recovery requires Linux or macOS");
        }
    }

    WorkspaceStorageGuard(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ManagedAgentProperties properties, IdentityReader identities) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.enabled = properties.getRuntimeBroker().isVerifiedWorkspaceRecoveryEnabled();
        this.identities = identities;
        this.createdRoots = new WorkspaceCreationRoots(jdbc, properties);
        this.roots = enabled ? properties.getRuntimeBroker().getWorkspaceMounts().stream()
                .collect(Collectors.toMap(mount -> new Storage(mount.tenantId(), mount.storageId()),
                        mount -> Path.of(mount.root()), (left, right) -> {
                            throw new IllegalStateException("Workspace storage mount is duplicated");
                        })) : Map.of();
    }

    public boolean enabled() {
        return enabled;
    }

    @Autowired
    void configureSsh(SshWorkspaceStore store, ManagedAgentProperties properties) {
        this.ssh = properties.getRuntimeBroker().getSsh().getNodes().isEmpty() ? null : store;
    }

    public String inspect(String tenantId, String storageId) {
        if (!enabled) {
            return "disabled";
        }
        WorkspaceStorageKindGuard.requireLocalAlias(jdbc, tenantId, storageId);
        Path root = configuredRoot(tenantId, storageId);
        if (root == null) {
            return "unconfigured";
        }
        var alias = LocalStorageOwners.alias(jdbc, tenantId, storageId, false);
        if (alias == null || !(alias.get("physical_key") instanceof String physical)) {
            return "unverified";
        }
        Registration row = row(physical, false);
        if (row == null) {
            return "unverified";
        }
        String identityStatus = "unavailable";
        try {
            Identity current = identity(root);
            identityStatus = "mismatch";
            requireMatching(row, current, tenantId, storageId);
            identityStatus = "match";
        } catch (RuntimeException error) {
            // Keep unreadable identity distinct from a verified mismatch.
        }
        String markerStatus = "match";
        try {
            if (!marker(row).equals(readMarker(root))) {
                markerStatus = "mismatch";
            }
        } catch (RuntimeException error) {
            markerStatus = "unavailable";
        }
        boolean held = row.holderKey() != null || row.bindingId() != null
                || row.runtimeGeneration() != null || row.runtimeSessionId() != null;
        boolean valid = "READY".equals(row.state()) && row.revision() > 0
                && row.operationId() == null && validId(row.completedOperationId())
                || "FENCED".equals(row.state()) && row.revision() > 0
                && validId(row.operationId()) && row.completedOperationId() == null
                || "UNVERIFIED".equals(row.state()) && row.revision() == 0;
        return "state=" + row.state().toLowerCase(Locale.ROOT) + " revision=" + row.revision()
                + " operation=" + row.operationId() + " completed=" + row.completedOperationId()
                + " holder=" + held + " identity=" + identityStatus + " marker=" + markerStatus
                + " registration=" + (valid ? "valid" : "invalid");
    }

    public record RecoveryRegistration(String tenantId, String storageId, String registrationId,
            long mountRevision, String fenceOperationId, String root, String hostId,
            String device, String inode, String birthTime) {
    }

    public RecoveryRegistration recoveryRegistration(String tenantId, String storageId,
            long revision, String operationId) {
        if (!enabled || !validId(operationId)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return authorityRead(() -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, tenantId);
            String physical = LocalStorageOwners.lockCovered(jdbc, tenantId, storageId);
            Registration saved = row(physical, true);
            requireFenced(saved, revision, operationId);
            Path original = root(tenantId, storageId);
            requireMatching(saved, identity(original), tenantId, storageId);
            if (!marker(saved).equals(readMarker(original))) {
                throw WorkspaceExecutionStore.unavailable();
            }
            return new RecoveryRegistration(tenantId, storageId, saved.registrationId(), revision,
                    operationId, saved.root(), saved.hostId(), saved.device(), saved.inode(), saved.birthTime());
        });
    }

    void verifyCapturedRegistration(RecoveryRegistration expected) {
        authorityRead(() -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, expected.tenantId());
            String physical = LocalStorageOwners.lockCovered(jdbc, expected.tenantId(), expected.storageId());
            Registration saved = row(physical, true);
            requireFenced(saved, expected.mountRevision(), expected.fenceOperationId());
            var metadata = new RecoveryRegistration(expected.tenantId(), expected.storageId(), saved.registrationId(),
                    saved.revision(), saved.operationId(), saved.root(), saved.hostId(), saved.device(), saved.inode(), saved.birthTime());
            if (!metadata.equals(expected) || !physical.equals(LocalStorageOwners.physicalKey(new Identity(
                    saved.root(), saved.hostId(), saved.device(), saved.inode(), saved.birthTime())))) {
                throw WorkspaceExecutionStore.unavailable();
            }
            return null;
        });
    }

    private <T> T authorityRead(java.util.function.Supplier<T> action) {
        if (org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()) {
            return action.get();
        }
        return transaction.execute(status -> action.get());
    }

    private static void requireFenced(Registration saved, long revision, String operationId) {
        if (saved == null || !"FENCED".equals(saved.state()) || saved.revision() != revision
                || !operationId.equals(saved.operationId()) || saved.holderKey() != null
                || saved.bindingId() != null || saved.runtimeGeneration() != null
                || saved.runtimeSessionId() != null || !validId(saved.registrationId())
                || saved.completedOperationId() != null) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    public void verify(ContextBinding binding) {
        if (ssh != null && ssh.verify(binding)) {
            return;
        }
        WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        if (!enabled) {
            return;
        }
        WorkspaceMigrationAdmission.requireOpen(jdbc, binding.getTenantId(), binding.getStorageId());
        verify(binding.getTenantId(), binding.getStorageId(), binding.getCwdRelative(), false);
    }

    void verifyLocked(ContextBinding binding) {
        if (ssh != null && ssh.verify(binding)) {
            return;
        }
        WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        if (enabled) {
            WorkspaceMigrationAdmission.requireOpen(jdbc, binding.getTenantId(), binding.getStorageId());
            verify(binding.getTenantId(), binding.getStorageId(), binding.getCwdRelative(), true);
        }
    }

    void verifyMaintenanceRecovery(ContextBinding binding) {
        WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        if (!enabled) {
            throw WorkspaceExecutionStore.unavailable();
        }
        verify(binding.getTenantId(), binding.getStorageId(), binding.getCwdRelative(), true);
    }

    public Path createdStorageRoot(String tenantId, String storageId) {
        return createdRoots.resolve(tenantId, storageId, false);
    }

    Path verifiedRoot(ContextBinding binding) {
        if (!enabled) {
            throw WorkspaceExecutionStore.unavailable();
        }
        WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        verify(binding);
        return root(binding.getTenantId(), binding.getStorageId());
    }

    void registerCreated(String tenantId, String storageId, String operationId) {
        Path path = createdRoots.resolve(tenantId, storageId, true);
        if (path == null) {
            throw WorkspaceExecutionStore.unavailable();
        }
        register(tenantId, storageId, operationId, path);
    }

    public void register(String tenantId, String storageId, String operationId) {
        register(tenantId, storageId, operationId, root(tenantId, storageId));
    }

    private void register(String tenantId, String storageId, String operationId, Path root) {
        if (!enabled || !validId(operationId)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        WorkspaceStorageKindGuard.requireFreshTransaction();
        Identity identity = identity(root);
        String key = LocalStorageOwners.physicalKey(identity);
        Registration prepared = transaction.execute(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, tenantId);
            requireNonOverlapping(identity);
            WorkspaceStorageKindGuard.requireLocalAlias(jdbc, tenantId, storageId);
            prepareAlias(tenantId, storageId, key, operationId);
            jdbc.update("INSERT INTO ma_storage_owner"
                    + " (storage_key, physical_key, tenant_id, storage_id) VALUES (?, ?, ?, ?)"
                    + " ON DUPLICATE KEY UPDATE storage_key = storage_key",
                    key, key, tenantId, storageId);
            Registration row = row(key, true);
            if (row == null || row.holderKey() != null || row.bindingId() != null
                    || row.runtimeGeneration() != null || row.runtimeSessionId() != null) {
                throw WorkspaceExecutionStore.unavailable();
            }
            if ("READY".equals(row.state()) && row.operationId() == null && row.revision() > 0) {
                requireMatching(row, identity, tenantId, storageId);
                return row;
            }
            if (!"UNVERIFIED".equals(row.state())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            if (row.operationId() == null && row.registrationId() == null) {
                String registrationId = UUID.randomUUID().toString();
                jdbc.update("UPDATE ma_storage_owner SET tenant_id = ?, storage_id = ?,"
                        + " mount_operation_id = ?, mount_root = ?, mount_host_id = ?,"
                        + " mount_device = ?, mount_inode = ?, mount_birth_time = ?, mount_registration_id = ?"
                        + " WHERE storage_key = ? AND storage_kind = 'LOCAL' AND mount_state = 'UNVERIFIED'",
                        tenantId, storageId, operationId, identity.root(), identity.hostId(),
                        identity.device(), identity.inode(), identity.birthTime(), registrationId, key);
                return row(key, true);
            }
            if (!operationId.equals(row.operationId())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            requireMatching(row, identity, tenantId, storageId);
            return row;
        });
        if (prepared == null) {
            throw WorkspaceExecutionStore.unavailable();
        }
        Marker marker = marker(prepared);
        if ("READY".equals(prepared.state())) {
            requireMatching(prepared, identity(root), tenantId, storageId);
            if (!marker.equals(readMarker(root))) {
                throw WorkspaceExecutionStore.unavailable();
            }
        } else {
            publishMarker(root, marker);
        }
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, tenantId);
            WorkspaceStorageKindGuard.requireLocalAlias(jdbc, tenantId, storageId);
            prepareAlias(tenantId, storageId, key, operationId);
            Registration row = row(key, true);
            if (row == null || row.holderKey() != null || row.bindingId() != null
                    || row.runtimeGeneration() != null || row.runtimeSessionId() != null) {
                throw WorkspaceExecutionStore.unavailable();
            }
            requireMatching(row, identity(root), tenantId, storageId);
            if (!marker.equals(marker(row)) || !marker.equals(readMarker(root))) {
                throw WorkspaceExecutionStore.unavailable();
            }
            if ("READY".equals(row.state()) && row.operationId() == null && row.revision() > 0) {
                completeAlias(tenantId, storageId, key);
                return;
            }
            if (!"UNVERIFIED".equals(row.state()) || !operationId.equals(row.operationId())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            int changed = jdbc.update("UPDATE ma_storage_owner"
                    + " SET mount_state = 'READY', mount_revision = mount_revision + 1,"
                    + " mount_operation_id = NULL, mount_completed_operation_id = ? WHERE storage_key = ? AND storage_kind = 'LOCAL' "
                    + " AND mount_state = 'UNVERIFIED' AND mount_operation_id = ?"
                    + " AND mount_revision = 0", operationId, key, operationId);
            if (changed != 1) {
                throw WorkspaceExecutionStore.unavailable();
            }
            completeAlias(tenantId, storageId, key);
        });
    }

    private void prepareAlias(String tenant, String storage, String physical, String operation) {
        String request = "{\"schemaVersion\":1,\"operationId\":\"" + operation + "\"}";
        jdbc.update("INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id, physical_key,"
                + " storage_kind, registration_json, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, ?, ?, 'LOCAL', ?, " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")"
                + " ON DUPLICATE KEY UPDATE gmt_modified = CASE WHEN physical_key IS NULL OR registration_json IS NULL OR storage_kind = 'UNREGISTERED' THEN VALUES(gmt_modified) ELSE gmt_modified END, physical_key = COALESCE(physical_key, VALUES(physical_key)),"
                + " storage_kind = CASE WHEN storage_kind = 'UNREGISTERED' THEN 'LOCAL' ELSE storage_kind END,"
                + " registration_json = COALESCE(registration_json, VALUES(registration_json))",
                com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage),
                com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.storageFenceKey(tenant),
                com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.storageFenceKey(storage), tenant, storage, physical, request);
        var alias = LocalStorageOwners.alias(jdbc, tenant, storage, true);
        if (alias == null || !physical.equals(alias.get("physical_key")) || !"LOCAL".equals(alias.get("storage_kind"))
                || !List.of("FENCE_ONLY", "REGISTERED").contains(alias.get("registration_state"))
                || alias.get("fence_operation_id") != null
                || !operation.equals(WorkspaceRecoveryStore.parse((String) alias.get("registration_json")).path("operationId").asText())) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    private void completeAlias(String tenant, String storage, String physical) {
        if (jdbc.update("UPDATE ma_storage SET gmt_modified = CASE WHEN registration_state <> 'REGISTERED' OR registration_revision IS NULL THEN " + ManagedSchemaTime.SQL_NOW + " ELSE gmt_modified END, registration_state = 'REGISTERED', registration_revision = COALESCE(registration_revision, 1) WHERE alias_key = ? AND physical_key = ? AND storage_kind = 'LOCAL'",
                com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage), physical) != 1) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    public void fence(String tenantId, String storageId, long revision, String operationId) {
        if (!enabled || !validId(operationId)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, tenantId);
            WorkspaceStorageKindGuard.requireLocalAlias(jdbc, tenantId, storageId);
            String migration = WorkspaceMigrationAdmission.owner(jdbc, tenantId, storageId);
            if (migration != null) {
                var saved = new WorkspaceOperations(jdbc, tenantId).find(
                        WorkspaceOperations.Kind.STORAGE_MIGRATION, migration, false);
                if (saved == null || !operationId.equals(WorkspaceRecoveryStore.parse((String) saved.get("request_json"))
                        .path("fenceOperationId").asText())) {
                    throw WorkspaceExecutionStore.unavailable();
                }
            }
            String physical = LocalStorageOwners.lockCovered(jdbc, tenantId, storageId);
            Registration current = row(physical, true);
            if (current != null && "FENCED".equals(current.state())
                    && current.revision() == revision && operationId.equals(current.operationId())) {
                return;
            }
            verify(tenantId, storageId, ".", true);
            int changed = jdbc.update("UPDATE ma_storage_owner"
                    + " SET mount_state = 'FENCED', mount_operation_id = ?,"
                    + " mount_completed_operation_id = NULL"
                    + " WHERE storage_key = ? AND storage_kind = 'LOCAL'"
                    + " AND mount_state = 'READY' AND mount_revision = ?"
                    + " AND holder_key IS NULL AND binding_id IS NULL"
                    + " AND runtime_generation IS NULL AND runtime_session_id IS NULL",
                    operationId, physical, revision);
            if (changed != 1) {
                throw WorkspaceExecutionStore.unavailable();
            }
        });
    }

    public void restoreOriginal(String tenantId, String storageId, long revision,
            String operationId) {
        if (!enabled || !validId(operationId)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        Path root = root(tenantId, storageId);
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, tenantId);
            WorkspaceStorageKindGuard.requireLocalAlias(jdbc, tenantId, storageId);
            if (WorkspaceMigrationAdmission.owner(jdbc, tenantId, storageId) != null) {
                throw WorkspaceExecutionStore.unavailable();
            }
            String physical = LocalStorageOwners.lockCovered(jdbc, tenantId, storageId);
            Registration row = row(physical, true);
            if (row != null && "READY".equals(row.state())
                    && row.revision() == revision + 1 && row.operationId() == null
                    && operationId.equals(row.completedOperationId())) {
                requireMatching(row, identity(root), tenantId, storageId);
                if (!marker(row).equals(readMarker(root))) {
                    throw WorkspaceExecutionStore.unavailable();
                }
                return;
            }
            if (row == null || !"FENCED".equals(row.state())
                    || row.revision() != revision || !operationId.equals(row.operationId())
                    || row.holderKey() != null || row.bindingId() != null
                    || row.runtimeGeneration() != null || row.runtimeSessionId() != null) {
                throw WorkspaceExecutionStore.unavailable();
            }
            requireMatching(row, identity(root), tenantId, storageId);
            if (!marker(row).equals(readMarker(root))) {
                throw WorkspaceExecutionStore.unavailable();
            }
            int changed = jdbc.update("UPDATE ma_storage_owner"
                    + " SET mount_state = 'READY', mount_revision = mount_revision + 1,"
                    + " mount_operation_id = NULL, mount_completed_operation_id = ?"
                    + " WHERE storage_key = ? AND storage_kind = 'LOCAL' AND mount_state = 'FENCED'"
                    + " AND mount_revision = ? AND mount_operation_id = ?",
                    operationId, physical, revision, operationId);
            if (changed != 1) {
                throw WorkspaceExecutionStore.unavailable();
            }
        });
    }

    private void verify(String tenantId, String storageId, String cwd, boolean lock) {
        Path root = root(tenantId, storageId);
        Identity actual = identity(root);
        Registration row = row(key(tenantId, storageId), lock);
        if (row == null || !"READY".equals(row.state()) || row.operationId() != null
                || row.revision() <= 0) {
            throw WorkspaceExecutionStore.unavailable();
        }
        requireMatching(row, actual, tenantId, storageId);
        verifyHistory(tenantId, storageId, false);
        if (!marker(row).equals(readMarker(root))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        Path directory = root.resolve(cwd).normalize();
        try {
            if (!directory.startsWith(root)
                    || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)
                    || !directory.toRealPath().equals(directory)) {
                throw WorkspaceExecutionStore.unavailable();
            }
        } catch (IOException | IllegalArgumentException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    private void verifyHistory(String tenantId, String storageId, boolean probe) {
        var migrations = jdbc.query("SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_kind = 'STORAGE_MIGRATION'"
                + " AND tenant_id = ? AND storage_key = ? AND state = 'COMPLETED' ORDER BY gmt_modified DESC LIMIT 1",
                (row, index) -> WorkspaceOperations.operation(row), tenantId,
                JdbcRuntimeBindingRepository.storageAliasKey(tenantId, storageId));
        if (!migrations.isEmpty()) {
            Identity expected;
            try {
                expected = json.readValue((String) migrations.getFirst().get("history_identity_json"), Identity.class);
            } catch (IOException error) {
                throw WorkspaceExecutionStore.unavailable();
            }
            String home = System.getenv("QWEN_HOME");
            if (home == null || !Path.of(home).isAbsolute()
                    || !Path.of(home).resolve("file-history").toString().equals(expected.root())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            try {
                if (!Path.of(home).toRealPath().equals(Path.of(home))
                        || !expected.equals(identities.read(Path.of(expected.root())))) {
                    throw WorkspaceExecutionStore.unavailable();
                }
            } catch (NoSuchFileException | AccessDeniedException error) {
                throw WorkspaceExecutionStore.unavailable();
            } catch (IOException error) {
                if (probe) {
                    throw WorkspaceExecutionStore.unavailableTransient(error);
                }
                throw WorkspaceExecutionStore.unavailable();
            } catch (RuntimeException error) {
                throw WorkspaceExecutionStore.unavailable();
            }
        }
    }

    // Probe-only verification: identical structural checks to verify(), but
    // the cwd settlement probe classifies by the verdict — a momentary I/O
    // failure on an identity or marker read, or on the directory liveness
    // calls, is retryable-with-cause so the delivery machine re-arms the
    // operation and the refusal log keeps the cause. Everything structural
    // keeps the terminal unavailable(), and the shared acquire path above
    // is deliberately untouched: re-classifying inside verify() would flip
    // tool-turn verdicts.
    public void verifyProbe(ContextBinding binding) {
        if (ssh != null && ssh.verify(binding)) {
            return;
        }
        WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        if (!enabled) {
            return;
        }
        WorkspaceMigrationAdmission.requireOpen(jdbc, binding.getTenantId(), binding.getStorageId());
        verifyProbe(binding.getTenantId(), binding.getStorageId(),
                binding.getCwdRelative());
    }

    private void verifyProbe(String tenantId, String storageId, String cwd) {
        Path root = root(tenantId, storageId);
        Identity actual;
        try {
            actual = identities.read(root);
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailableTransient(error);
        } catch (RuntimeException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
        Registration row = row(key(tenantId, storageId), false);
        if (row == null || !"READY".equals(row.state()) || row.operationId() != null
                || row.revision() <= 0) {
            throw WorkspaceExecutionStore.unavailable();
        }
        requireMatching(row, actual, tenantId, storageId);
        verifyHistory(tenantId, storageId, true);
        if (!marker(row).equals(readMarkerProbe(root))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        Path directory = root.resolve(cwd).normalize();
        try {
            if (!directory.startsWith(root)
                    || !Files.readAttributes(directory,
                            BasicFileAttributes.class,
                            LinkOption.NOFOLLOW_LINKS).isDirectory()
                    || !directory.toRealPath().equals(directory)) {
                throw WorkspaceExecutionStore.unavailable();
            }
            directory.getFileSystem().provider().checkAccess(directory,
                    AccessMode.READ, AccessMode.EXECUTE);
        } catch (NoSuchFileException | AccessDeniedException
                | SecurityException | IllegalArgumentException error) {
            throw WorkspaceExecutionStore.unavailable();
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailableTransient(error);
        }
    }

    private Marker readMarkerProbe(Path root) {
        Path file = root.resolve(MARKER);
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        try (FileChannel channel = FileChannel.open(file,
                StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            if (channel.size() > 4096) {
                throw WorkspaceExecutionStore.unavailable();
            }
            ByteBuffer bytes = ByteBuffer.allocate((int) channel.size());
            while (bytes.hasRemaining()) {
                if (channel.read(bytes) <= 0) {
                    throw WorkspaceExecutionStore.unavailable();
                }
            }
            return json.readValue(bytes.array(), Marker.class);
        } catch (JsonProcessingException error) {
            throw WorkspaceExecutionStore.unavailable();
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailableTransient(error);
        }
    }

    private Registration row(String key, boolean lock) {
        List<Registration> rows = jdbc.query("SELECT physical_key, tenant_id, storage_id, holder_key,"
                + " binding_id, runtime_generation, runtime_session_id,"
                + " mount_revision, mount_state, mount_operation_id, mount_root,"
                + " mount_host_id, mount_device, mount_inode, mount_birth_time, mount_registration_id,"
                + " mount_completed_operation_id"
                + " FROM ma_storage_owner WHERE storage_key = ? AND storage_kind = 'LOCAL'"
                + (lock ? " FOR UPDATE" : ""), (result, index) -> {
                    if (!key.equals(result.getString("physical_key"))) {
                        throw WorkspaceExecutionStore.unavailable();
                    }
                    return new Registration(
                        result.getString("tenant_id"), result.getString("storage_id"),
                        result.getString("holder_key"), result.getString("binding_id"),
                        result.getObject("runtime_generation", Long.class),
                        result.getString("runtime_session_id"), result.getLong("mount_revision"),
                        result.getString("mount_state"), result.getString("mount_operation_id"),
                        result.getString("mount_root"), result.getString("mount_host_id"),
                        result.getString("mount_device"), result.getString("mount_inode"),
                        result.getString("mount_birth_time"),
                        result.getString("mount_registration_id"),
                        result.getString("mount_completed_operation_id"));
                }, key);
        return rows.size() == 1 ? rows.getFirst() : null;
    }

    RecoveryRegistration migrationSource(String tenant, String storage, long revision, String fence) {
        WorkspaceStorageKindGuard.requireLocalAlias(jdbc, tenant, storage);
        return authorityRead(() -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, tenant);
            String physical = LocalStorageOwners.lockCovered(jdbc, tenant, storage);
            Registration saved = row(physical, true);
            if (saved == null || saved.revision() != revision || !List.of("READY", "FENCED").contains(saved.state())
                    || "FENCED".equals(saved.state()) && !fence.equals(saved.operationId())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            requireMatching(saved, identity(root(tenant, storage)), tenant, storage);
            if (!marker(saved).equals(readMarker(root(tenant, storage)))) {
                throw WorkspaceExecutionStore.unavailable();
            }
            return new RecoveryRegistration(tenant, storage, saved.registrationId(), revision, fence,
                    saved.root(), saved.hostId(), saved.device(), saved.inode(), saved.birthTime());
        });
    }

    Identity migrationIdentity(Path path) {
        return identity(path);
    }

    byte[] migrationMarker(String tenant, String storage, Identity target, String registration) {
        try {
            return json.writeValueAsBytes(new Marker(2, tenant, storage, target.root(), target.hostId(),
                    target.device(), target.inode(), target.birthTime(), registration));
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    static Path migrationTemporary(Path root, String operation) {
        return root.resolve(MARKER + "." + operation + ".tmp");
    }

    void discardMigrationTemporary(Path root, byte[] expected, String operation) {
        Path temporary = migrationTemporary(root, operation);
        if (!Files.exists(temporary, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        try {
            if (!Files.isRegularFile(temporary, LinkOption.NOFOLLOW_LINKS)
                    || ((Number) Files.getAttribute(temporary, "unix:nlink", LinkOption.NOFOLLOW_LINKS)).longValue() != 1
                    || Files.size(temporary) > expected.length) {
                throw WorkspaceExecutionStore.unavailable();
            }
            byte[] partial = Files.readAllBytes(temporary);
            if (!java.util.Arrays.equals(partial, java.util.Arrays.copyOf(expected, partial.length))) {
                throw WorkspaceExecutionStore.unavailable();
            }
            Files.delete(temporary);
            try (FileChannel directory = FileChannel.open(root, StandardOpenOption.READ)) {
                directory.force(true);
            }
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    void publishMigrationMarker(Path root, byte[] expectedBytes, RecoveryRegistration original, String operation) {
        Marker expected;
        try {
            expected = json.readValue(expectedBytes, Marker.class);
            Registration provenance = row(key(original.tenantId(), original.storageId()), false);
            if (provenance == null || !original.registrationId().equals(provenance.registrationId())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            Marker old = marker(provenance);
            Marker current = readMarker(root);
            if (expected.equals(current)) {
                return;
            }
            if (!old.equals(current)) {
                throw WorkspaceExecutionStore.unavailable();
            }
            Path temporary = migrationTemporary(root, operation);
            if (Files.exists(temporary, LinkOption.NOFOLLOW_LINKS)) {
                if (!Files.isRegularFile(temporary, LinkOption.NOFOLLOW_LINKS)
                        || ((Number) Files.getAttribute(temporary, "unix:nlink", LinkOption.NOFOLLOW_LINKS)).longValue() != 1
                        || Files.size(temporary) != expectedBytes.length
                        || !java.util.Arrays.equals(Files.readAllBytes(temporary), expectedBytes)) {
                    throw WorkspaceExecutionStore.unavailable();
                }
            } else {
                try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE_NEW,
                        StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                    ByteBuffer buffer = ByteBuffer.wrap(expectedBytes);
                    while (buffer.hasRemaining()) {
                        channel.write(buffer);
                    }
                    channel.force(true);
                }
                Files.setPosixFilePermissions(temporary, Files.getPosixFilePermissions(root.resolve(MARKER),
                        LinkOption.NOFOLLOW_LINKS));
            }
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                channel.force(true);
            }
            Files.move(temporary, root.resolve(MARKER), java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            try (FileChannel directory = FileChannel.open(root, StandardOpenOption.READ)) {
                directory.force(true);
            }
            try (FileChannel directory = FileChannel.open(root.getParent(), StandardOpenOption.READ)) {
                directory.force(true);
            }
            if (!expected.equals(readMarker(root))) {
                throw WorkspaceExecutionStore.unavailable();
            }
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    void promoteMigration(RecoveryRegistration source, Identity target, String registration, String operation) {
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, source.tenantId());
            requireNonOverlapping(target);
            recoveryRegistration(source.tenantId(), source.storageId(), source.mountRevision(), source.fenceOperationId());
            if (!source.hostId().equals(target.hostId()) || !target.equals(identity(Path.of(target.root())))
                    || !new String(migrationMarker(source.tenantId(), source.storageId(), target, registration), StandardCharsets.UTF_8)
                        .equals(markerJson(Path.of(target.root())))) {
                throw WorkspaceExecutionStore.unavailable();
            }
            String previous = LocalStorageOwners.lockCovered(jdbc, source.tenantId(), source.storageId());
            String physical = LocalStorageOwners.physicalKey(target);
            if (physical.equals(previous)) {
                throw WorkspaceExecutionStore.unavailable();
            }
            int created = jdbc.update("INSERT INTO ma_storage_owner (storage_key, physical_key, storage_kind, tenant_id, storage_id,"
                    + " mount_root, mount_host_id, mount_device, mount_inode, mount_birth_time, mount_registration_id,"
                    + " mount_revision, mount_state, mount_completed_operation_id) VALUES (?, ?, 'LOCAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'READY', ?)",
                    physical, physical, source.tenantId(), source.storageId(), target.root(), target.hostId(), target.device(), target.inode(),
                    target.birthTime(), registration, source.mountRevision() + 1, operation);
            if (created != 1 || jdbc.update("UPDATE ma_storage SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", physical_key = ?, registration_revision = registration_revision + 1 WHERE alias_key = ? AND physical_key = ? AND storage_kind = 'LOCAL'",
                    physical, JdbcRuntimeBindingRepository.storageAliasKey(source.tenantId(), source.storageId()), previous) != 1) {
                throw WorkspaceExecutionStore.unavailable();
            }
        });
    }

    private String markerJson(Path root) {
        try {
            return json.writeValueAsString(readMarker(root));
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    private void requireNonOverlapping(Identity identity) {
        try {
            LocalStorageOwners.requireNonOverlapping(jdbc, identity);
        } catch (com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException conflict) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    private Path configuredRoot(String tenantId, String storageId) {
        Path root = roots.get(new Storage(tenantId, storageId));
        return root == null ? createdStorageRoot(tenantId, storageId) : root;
    }

    private Path root(String tenantId, String storageId) {
        Path root = configuredRoot(tenantId, storageId);
        if (root == null) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return root;
    }

    private Identity identity(Path root) {
        try {
            return identities.read(root);
        } catch (IOException | RuntimeException error) {
            throw WorkspaceExecutionStore.unavailable(error);
        }
    }

    private static Identity nativeIdentity(Path root) throws IOException {
        String os = System.getProperty("os.name");
        if (!List.of("Linux", "Mac OS X").contains(os)) {
            throw new IOException("Unsupported mount identity provider");
        }
        Map<String, Object> attributes = Files.readAttributes(root,
                "unix:isDirectory,dev,ino,creationTime,lastModifiedTime", LinkOption.NOFOLLOW_LINKS);
        if (!Boolean.TRUE.equals(attributes.get("isDirectory")) || !root.isAbsolute()
                || !root.equals(root.toRealPath())) {
            throw new IOException("Workspace root is not canonical");
        }
        String device = Long.toUnsignedString(((Number) attributes.get("dev")).longValue());
        String inode = Long.toUnsignedString(((Number) attributes.get("ino")).longValue());
        String birthTime = "Mac OS X".equals(os) ? MacOsHostIdentity.birthTime(root, device, inode)
                : linuxBirthTime(root, device, inode, (FileTime) attributes.get("creationTime"),
                        (FileTime) attributes.get("lastModifiedTime"));
        String machineId = "Mac OS X".equals(os) ? MacOsHostIdentity.machineId()
                : Files.readString(Path.of("/etc/machine-id")).strip();
        if (machineId.isEmpty() || machineId.length() > 256) {
            throw new IOException("Host identity is unavailable");
        }
        String host;
        try {
            host = new HmacUtils(HmacAlgorithms.HMAC_SHA_256,
                    machineId.getBytes(StandardCharsets.UTF_8)).hmacHex(
                            "Qwen-Code/verified-workspace/v2".getBytes(StandardCharsets.UTF_8));
        } catch (IllegalArgumentException error) {
            if (error.getCause() instanceof GeneralSecurityException cause) {
                throw new IOException("Host identity is unavailable", cause);
            }
            throw error;
        }
        return new Identity(root.toString(), host, device, inode, birthTime);
    }

    private static String linuxBirthTime(Path root, String device, String inode,
            FileTime creation, FileTime modified) throws IOException {
        if (!creation.equals(modified) || creation.compareTo(FileTime.fromMillis(0)) <= 0) {
            return verifiedBirthTime(creation, modified);
        }
        // A marker write can share the birth clock tick. Confirm the exact root,
        // rather than treating the JDK's possible mtime fallback as birth evidence.
        ProcessBuilder builder = new ProcessBuilder("/usr/bin/stat", "-c", "%d|%i|%w", "--", root.toString())
                .redirectError(ProcessBuilder.Redirect.DISCARD);
        builder.environment().put("LC_ALL", "C");
        builder.environment().put("TZ", "UTC");
        Process process = builder.start();
        try {
            process.getOutputStream().close();
            if (!process.waitFor(5, TimeUnit.SECONDS) || process.exitValue() != 0) {
                throw new IOException("Workspace birth time probe failed");
            }
            byte[] output = process.getInputStream().readNBytes(257);
            if (output.length > 256) {
                throw new IOException("Workspace birth time probe exceeds its size limit");
            }
            return verifiedNativeBirthTime(new String(output, StandardCharsets.UTF_8).strip(),
                    device, inode, creation);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("Workspace birth time probe interrupted", error);
        } finally {
            process.destroyForcibly();
            process.getInputStream().close();
            process.getErrorStream().close();
        }
    }

    static String verifiedNativeBirthTime(String output, String device, String inode,
            FileTime creation) throws IOException {
        String[] fields = output.split("\\|", -1);
        if (fields.length != 3 || !device.equals(fields[0]) || !inode.equals(fields[1])) {
            throw new IOException("Workspace storage identity changed or is unavailable");
        }
        try {
            Instant birth = OffsetDateTime.parse(fields[2], LINUX_BIRTH_TIME_FORMAT).toInstant();
            if (!birth.isAfter(Instant.EPOCH) || !birth.equals(creation.toInstant())) {
                throw new IOException("Workspace birth time is unavailable or ambiguous");
            }
            return creation.toInstant().toString();
        } catch (DateTimeException error) {
            throw new IOException("Workspace native birth time is invalid", error);
        }
    }

    static String verifiedBirthTime(FileTime creation, FileTime modified) throws IOException {
        // OpenJDK 21 substitutes mtime or epoch when Linux does not provide birth time.
        if (creation.compareTo(FileTime.fromMillis(0)) <= 0 || creation.equals(modified)) {
            throw new IOException("Workspace birth time is unavailable or ambiguous");
        }
        return creation.toInstant().toString();
    }

    private void requireMatching(Registration row, Identity identity,
            String tenantId, String storageId) {
        var alias = LocalStorageOwners.alias(jdbc, tenantId, storageId, false);
        if (alias == null || !LocalStorageOwners.physicalKey(identity).equals(alias.get("physical_key"))
                || row.tenantId() == null || row.storageId() == null
                || !identity.root().equals(row.root()) || !identity.hostId().equals(row.hostId())
                || !identity.device().equals(row.device()) || !identity.inode().equals(row.inode())
                || !identity.birthTime().equals(row.birthTime()) || row.registrationId() == null) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    private Marker marker(Registration row) {
        return new Marker(2, row.tenantId(), row.storageId(), row.root(), row.hostId(),
                row.device(), row.inode(), row.birthTime(), row.registrationId());
    }

    private Marker readMarker(Path root) {
        Path file = root.resolve(MARKER);
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.READ,
                LinkOption.NOFOLLOW_LINKS)) {
            if (channel.size() > 4096) {
                throw WorkspaceExecutionStore.unavailable();
            }
            ByteBuffer bytes = ByteBuffer.allocate((int) channel.size());
            while (bytes.hasRemaining()) {
                if (channel.read(bytes) <= 0) {
                    throw WorkspaceExecutionStore.unavailable();
                }
            }
            return json.readValue(bytes.array(), Marker.class);
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    private void publishMarker(Path root, Marker expected) {
        Path file = root.resolve(MARKER);
        Path temporary = root.resolve(MARKER + "." + UUID.randomUUID() + ".tmp");
        try {
            byte[] bytes = json.writeValueAsBytes(expected);
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE_NEW,
                    StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                ByteBuffer content = ByteBuffer.wrap(bytes);
                while (content.hasRemaining()) {
                    channel.write(content);
                }
                channel.force(true);
            }
            try {
                Files.createLink(file, temporary);
            } catch (java.nio.file.FileAlreadyExistsException ignored) {
                if (!expected.equals(readMarker(root))) {
                    throw WorkspaceExecutionStore.unavailable();
                }
            }
            try (FileChannel directory = FileChannel.open(root, StandardOpenOption.READ)) {
                directory.force(true);
            }
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailable();
        } finally {
            try {
                Files.deleteIfExists(temporary);
            } catch (IOException ignored) {
                // A leftover temporary file cannot authorize a mount.
            }
        }
        if (!expected.equals(readMarker(root))) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    private static boolean validId(String value) {
        try {
            return value != null && UUID.fromString(value).toString().equals(value);
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private String key(String tenantId, String storageId) {
        return LocalStorageOwners.key(jdbc, tenantId, storageId);
    }

    interface IdentityReader {
        Identity read(Path root) throws IOException;
    }

    record Identity(String root, String hostId, String device, String inode, String birthTime) {
    }

    private record Storage(String tenantId, String storageId) {
    }

    private record Registration(String tenantId, String storageId, String holderKey,
            String bindingId, Long runtimeGeneration, String runtimeSessionId,
            long revision, String state, String operationId, String root, String hostId,
            String device, String inode, String birthTime, String registrationId, String completedOperationId) {
    }

    private record Marker(int version, String tenantId, String storageId, String root,
            String hostId, String device, String inode, String birthTime, String registrationId) {
    }
}
