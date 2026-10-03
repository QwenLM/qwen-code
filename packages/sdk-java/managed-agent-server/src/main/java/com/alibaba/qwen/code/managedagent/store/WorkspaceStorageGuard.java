package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.FileTime;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Component
public class WorkspaceStorageGuard {
    private static final String MARKER = ".qwen-managed-storage.json";
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final Map<Storage, Path> roots;
    private final boolean enabled;
    private final IdentityReader identities;
    private final ObjectMapper json = new ObjectMapper();

    @Autowired
    public WorkspaceStorageGuard(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ManagedAgentProperties properties) {
        this(jdbc, manager, properties, WorkspaceStorageGuard::linuxIdentity);
        if (enabled && !"Linux".equals(System.getProperty("os.name"))) {
            throw new IllegalStateException("Verified Workspace recovery requires Linux");
        }
    }

    WorkspaceStorageGuard(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ManagedAgentProperties properties, IdentityReader identities) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.enabled = properties.getRuntimeBroker().isVerifiedWorkspaceRecoveryEnabled();
        this.identities = identities;
        this.roots = enabled ? properties.getRuntimeBroker().getWorkspaceMounts().stream()
                .collect(Collectors.toMap(mount -> new Storage(mount.tenantId(), mount.storageId()),
                        mount -> Path.of(mount.root()), (left, right) -> {
                            throw new IllegalStateException("Workspace storage mount is duplicated");
                        })) : Map.of();
    }

    public boolean enabled() {
        return enabled;
    }

    public String inspect(String tenantId, String storageId) {
        if (!enabled) {
            return "disabled";
        }
        Path root = roots.get(new Storage(tenantId, storageId));
        if (root == null) {
            return "unconfigured";
        }
        Registration row = row(key(tenantId, storageId), false);
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
        Registration saved = row(key(tenantId, storageId), false);
        if (saved == null || !"FENCED".equals(saved.state()) || saved.revision() != revision
                || !operationId.equals(saved.operationId()) || !tenantId.equals(saved.tenantId())
                || !storageId.equals(saved.storageId()) || saved.holderKey() != null
                || saved.bindingId() != null || saved.runtimeGeneration() != null
                || saved.runtimeSessionId() != null || !validId(saved.registrationId())
                || saved.completedOperationId() != null) {
            throw WorkspaceExecutionStore.unavailable();
        }
        Path original = root(tenantId, storageId);
        requireMatching(saved, identity(original), tenantId, storageId);
        if (!marker(saved).equals(readMarker(original))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return new RecoveryRegistration(tenantId, storageId, saved.registrationId(), revision,
                operationId, saved.root(), saved.hostId(), saved.device(), saved.inode(), saved.birthTime());
    }

    public void verify(ContextBinding binding) {
        if (!enabled) {
            return;
        }
        verify(binding.getTenantId(), binding.getStorageId(), binding.getCwdRelative(), false);
    }

    void verifyLocked(ContextBinding binding) {
        if (enabled) {
            verify(binding.getTenantId(), binding.getStorageId(), binding.getCwdRelative(), true);
        }
    }

    public void register(String tenantId, String storageId, String operationId) {
        if (!enabled || !validId(operationId)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        Path root = root(tenantId, storageId);
        Identity identity = identity(root);
        String key = key(tenantId, storageId);
        Registration prepared = transaction.execute(status -> {
            jdbc.update("INSERT INTO managed_workspace_execution_lease"
                    + " (storage_key, tenant_id, storage_id) VALUES (?, ?, ?)"
                    + " ON DUPLICATE KEY UPDATE storage_key = storage_key",
                    key, tenantId, storageId);
            Registration row = row(key, true);
            if (row == null || row.holderKey() != null || row.bindingId() != null
                    || row.runtimeGeneration() != null || row.runtimeSessionId() != null
                    || row.tenantId() != null && !tenantId.equals(row.tenantId())
                    || row.storageId() != null && !storageId.equals(row.storageId())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            if ("READY".equals(row.state()) && row.operationId() == null && row.revision() == 1) {
                if (!operationId.equals(row.completedOperationId())) {
                    throw WorkspaceExecutionStore.unavailable();
                }
                requireMatching(row, identity, tenantId, storageId);
                return row;
            }
            if (!"UNVERIFIED".equals(row.state())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            if (row.operationId() == null && row.registrationId() == null) {
                String registrationId = UUID.randomUUID().toString();
                jdbc.update("UPDATE managed_workspace_execution_lease SET tenant_id = ?, storage_id = ?,"
                        + " mount_operation_id = ?, mount_root = ?, mount_host_id = ?,"
                        + " mount_device = ?, mount_inode = ?, mount_birth_time = ?, mount_registration_id = ?"
                        + " WHERE storage_key = ? AND mount_state = 'UNVERIFIED'",
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
            return;
        }
        publishMarker(root, marker);
        transaction.executeWithoutResult(status -> {
            Registration row = row(key, true);
            if (row == null || row.holderKey() != null || row.bindingId() != null
                    || row.runtimeGeneration() != null || row.runtimeSessionId() != null) {
                throw WorkspaceExecutionStore.unavailable();
            }
            requireMatching(row, identity(root), tenantId, storageId);
            if (!marker.equals(marker(row)) || !marker.equals(readMarker(root))) {
                throw WorkspaceExecutionStore.unavailable();
            }
            if ("READY".equals(row.state()) && row.operationId() == null && row.revision() == 1
                    && operationId.equals(row.completedOperationId())) {
                return;
            }
            if (!"UNVERIFIED".equals(row.state()) || !operationId.equals(row.operationId())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            int changed = jdbc.update("UPDATE managed_workspace_execution_lease"
                    + " SET mount_state = 'READY', mount_revision = mount_revision + 1,"
                    + " mount_operation_id = NULL, mount_completed_operation_id = ? WHERE storage_key = ?"
                    + " AND mount_state = 'UNVERIFIED' AND mount_operation_id = ?"
                    + " AND mount_revision = 0", operationId, key, operationId);
            if (changed != 1) {
                throw WorkspaceExecutionStore.unavailable();
            }
        });
    }

    public void fence(String tenantId, String storageId, long revision, String operationId) {
        if (!enabled || !validId(operationId)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        transaction.executeWithoutResult(status -> {
            Registration current = row(key(tenantId, storageId), true);
            if (current != null && "FENCED".equals(current.state())
                    && tenantId.equals(current.tenantId()) && storageId.equals(current.storageId())
                    && current.revision() == revision && operationId.equals(current.operationId())) {
                return;
            }
            verify(tenantId, storageId, ".", true);
            int changed = jdbc.update("UPDATE managed_workspace_execution_lease"
                    + " SET mount_state = 'FENCED', mount_operation_id = ?,"
                    + " mount_completed_operation_id = NULL"
                    + " WHERE storage_key = ? AND tenant_id = ? AND storage_id = ?"
                    + " AND mount_state = 'READY' AND mount_revision = ?"
                    + " AND holder_key IS NULL AND binding_id IS NULL"
                    + " AND runtime_generation IS NULL AND runtime_session_id IS NULL",
                    operationId, key(tenantId, storageId), tenantId, storageId, revision);
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
            Registration row = row(key(tenantId, storageId), true);
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
            int changed = jdbc.update("UPDATE managed_workspace_execution_lease"
                    + " SET mount_state = 'READY', mount_revision = mount_revision + 1,"
                    + " mount_operation_id = NULL, mount_completed_operation_id = ?"
                    + " WHERE storage_key = ? AND mount_state = 'FENCED'"
                    + " AND mount_revision = ? AND mount_operation_id = ?",
                    operationId, key(tenantId, storageId), revision, operationId);
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

    private Registration row(String key, boolean lock) {
        List<Registration> rows = jdbc.query("SELECT tenant_id, storage_id, holder_key,"
                + " binding_id, runtime_generation, runtime_session_id,"
                + " mount_revision, mount_state, mount_operation_id, mount_root,"
                + " mount_host_id, mount_device, mount_inode, mount_birth_time, mount_registration_id,"
                + " mount_completed_operation_id"
                + " FROM managed_workspace_execution_lease WHERE storage_key = ?"
                + (lock ? " FOR UPDATE" : ""), (result, index) -> new Registration(
                        result.getString("tenant_id"), result.getString("storage_id"),
                        result.getString("holder_key"), result.getString("binding_id"),
                        result.getObject("runtime_generation", Long.class),
                        result.getString("runtime_session_id"), result.getLong("mount_revision"),
                        result.getString("mount_state"), result.getString("mount_operation_id"),
                        result.getString("mount_root"), result.getString("mount_host_id"),
                        result.getString("mount_device"), result.getString("mount_inode"),
                        result.getString("mount_birth_time"),
                        result.getString("mount_registration_id"),
                        result.getString("mount_completed_operation_id")), key);
        return rows.size() == 1 ? rows.getFirst() : null;
    }

    private Path root(String tenantId, String storageId) {
        Path root = roots.get(new Storage(tenantId, storageId));
        if (root == null) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return root;
    }

    private Identity identity(Path root) {
        try {
            return identities.read(root);
        } catch (IOException | RuntimeException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    private static Identity linuxIdentity(Path root) throws IOException {
        if (!"Linux".equals(System.getProperty("os.name"))) {
            throw new IOException("Unsupported mount identity provider");
        }
        Map<String, Object> attributes = Files.readAttributes(root,
                "unix:isDirectory,dev,ino,creationTime,lastModifiedTime", LinkOption.NOFOLLOW_LINKS);
        if (!Boolean.TRUE.equals(attributes.get("isDirectory")) || !root.isAbsolute()
                || !root.equals(root.toRealPath())) {
            throw new IOException("Workspace root is not canonical");
        }
        String birthTime = verifiedBirthTime((FileTime) attributes.get("creationTime"),
                (FileTime) attributes.get("lastModifiedTime"));
        String machineId = Files.readString(Path.of("/etc/machine-id")).strip();
        if (machineId.isEmpty() || machineId.length() > 256) {
            throw new IOException("Host identity is unavailable");
        }
        String host;
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(machineId.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            host = HexFormat.of().formatHex(mac.doFinal(
                    "Qwen-Code/verified-workspace/v2".getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException error) {
            throw new IOException("Host identity is unavailable", error);
        }
        String device = Long.toUnsignedString(((Number) attributes.get("dev")).longValue());
        String inode = Long.toUnsignedString(((Number) attributes.get("ino")).longValue());
        return new Identity(root.toString(), host, device, inode, birthTime);
    }

    static String verifiedBirthTime(FileTime creation, FileTime modified) throws IOException {
        // OpenJDK 21 substitutes mtime or epoch when Linux does not provide birth time.
        if (creation.compareTo(FileTime.fromMillis(0)) <= 0 || creation.equals(modified)) {
            throw new IOException("Workspace birth time is unavailable or ambiguous");
        }
        return creation.toInstant().toString();
    }

    private static void requireMatching(Registration row, Identity identity,
            String tenantId, String storageId) {
        if (!tenantId.equals(row.tenantId()) || !storageId.equals(row.storageId())
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

    private static String key(String tenantId, String storageId) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest((tenantId + "\u0000" + storageId).getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
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
