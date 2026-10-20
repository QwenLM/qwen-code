package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import org.apache.commons.lang3.StringUtils;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

final class WorkspaceCreationRoots {
    private final JdbcTemplate jdbc;
    private final Path base;
    private final Object baseKey;
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    WorkspaceCreationRoots(JdbcTemplate jdbc, ManagedAgentProperties properties) {
        this.jdbc = jdbc;
        var broker = properties.getRuntimeBroker();
        String configured = broker.getWorkspaceCreationRoot();
        if (StringUtils.isBlank(configured)) {
            base = null;
            baseKey = null;
            return;
        }
        try {
            base = Path.of(configured);
            baseKey = directoryKey(base);
            for (var mount : broker.getWorkspaceMounts()) {
                rejectOverlap(base, Path.of(mount.root()).toRealPath());
            }
            if (StringUtils.isNotBlank(broker.getStateDirectory())) {
                Path state = Path.of(broker.getStateDirectory()).toAbsolutePath().normalize();
                rejectOverlap(base, Files.exists(state) ? state.toRealPath()
                        : state.getParent().toRealPath().resolve(state.getFileName()));
            }
            if (StringUtils.isNotBlank(broker.getWorkspaceCwd())) {
                rejectOverlap(base, Path.of(broker.getWorkspaceCwd()).toRealPath());
            }
        } catch (IOException error) {
            throw new IllegalStateException("Workspace creation root must be a canonical directory", error);
        }
    }

    boolean enabled() {
        return base != null;
    }

    Path resolve(String tenant, String storage, boolean pending) {
        if (!enabled() || storage == null || !storage.matches("created-[a-f0-9]{64}")) {
            return null;
        }
        String key = storage.substring("created-".length());
        List<Map<String, Object>> rows = jdbc.query(
                "SELECT receipt_key, tenant_id, scope_kind, scope_id, idempotency_key, state,"
                        + " result_json FROM ma_request_receipt WHERE receipt_key = ? AND namespace = ?"
                        + " AND tenant_key = ?",
                (row, index) -> ManagedSchemaRows.read(row), key,
                ReceiptNamespace.WORKSPACE_CREATE.name(), ManagedSchemaKeys.key(tenant));
        if (rows.size() != 1) {
            return null;
        }
        Map<String, Object> row = rows.getFirst();
        if (!pending && "PENDING".equals(row.get("state"))) {
            return null;
        }
        if (!tenant.equals(row.get("tenant_id")) || !"ACTOR".equals(row.get("scope_kind"))
                || !("COMPLETED".equals(row.get("state"))
                        || pending && "PENDING".equals(row.get("state")))
                || !(row.get("scope_id") instanceof String scope)
                || !(row.get("idempotency_key") instanceof String idempotency)
                || !key.equals(ManagedSchemaKeys.receiptKey(ReceiptNamespace.WORKSPACE_CREATE,
                        tenant, ReceiptScope.ACTOR, scope, idempotency))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        Details details = details((String) row.get("result_json"), key);
        if (!storage.equals(details.storageId())
                || !("workspace-" + key).equals(details.workspaceId())) {
            throw WorkspaceExecutionStore.unavailable();
        }
        try {
            if (!Objects.equals(baseKey, directoryKey(base))) {
                throw WorkspaceExecutionStore.unavailable();
            }
            Path tenantRoot = base.resolve(ManagedSchemaKeys.key(tenant));
            Path root = tenantRoot.resolve(key);
            directoryKey(tenantRoot);
            directoryKey(root);
            return root;
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailable(error);
        }
    }

    Path prepare(String tenant, String receiptKey) {
        if (!enabled() || !receiptKey.matches("[a-f0-9]{64}")) {
            throw WorkspaceExecutionStore.unavailable();
        }
        try {
            if (!Objects.equals(baseKey, directoryKey(base))) {
                throw WorkspaceExecutionStore.unavailable();
            }
            Path tenantRoot = base.resolve(ManagedSchemaKeys.key(tenant));
            createDirectory(tenantRoot);
            Path root = tenantRoot.resolve(receiptKey);
            createDirectory(root);
            if (!"Mac OS X".equals(System.getProperty("os.name"))) {
                // OpenJDK's native guard refuses birth time equal to mtime; this is our new owned root.
                Files.setLastModifiedTime(root, FileTime.fromMillis(1));
            }
            return root;
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailable(error);
        }
    }

    static Details details(String resultJson, String receiptKey) {
        try {
            Details value = JSON.readValue(resultJson, Details.class);
            UUID.fromString(value.registrationId());
            if (StringUtils.isBlank(value.displayName())
                    || value.displayName().length() > 128
                    || value.displayName().codePoints().anyMatch(Character::isISOControl)
                    || !("workspace-" + receiptKey).equals(value.workspaceId())
                    || value.sourceWorkspaceId() == null && (!("created-" + receiptKey).equals(value.storageId())
                        || value.sourceGeneration() != null || value.cwdRelative() != null)
                    || value.sourceWorkspaceId() != null && (StringUtils.isBlank(value.sourceWorkspaceId())
                        || value.sourceGeneration() == null || value.sourceGeneration() < 1
                        || StringUtils.isBlank(value.storageId()) || value.cwdRelative() == null
                        || !value.cwdRelative().equals(com.alibaba.qwen.code.runtimebroker.managedworkspace
                            .WorkspaceRelativePath.normalize(value.cwdRelative())))) {
                throw new IllegalArgumentException();
            }
            return value;
        } catch (IOException | RuntimeException error) {
            throw WorkspaceExecutionStore.unavailable(error);
        }
    }

    private static void createDirectory(Path path) throws IOException {
        try {
            Files.createDirectory(path, PosixFilePermissions.asFileAttribute(
                    PosixFilePermissions.fromString("rwx------")));
        } catch (java.nio.file.FileAlreadyExistsException existing) {
            directoryKey(path);
        }
        directoryKey(path);
    }

    private static Object directoryKey(Path root) throws IOException {
        var attributes = Files.readAttributes(root, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!root.isAbsolute() || !root.equals(root.toRealPath())
                || !attributes.isDirectory() || attributes.fileKey() == null) {
            throw new IOException("Non-canonical Workspace creation directory");
        }
        return attributes.fileKey();
    }

    private static void rejectOverlap(Path left, Path right) {
        if (left.startsWith(right) || right.startsWith(left)) {
            throw new IllegalStateException("Workspace creation root must not overlap other roots or private state");
        }
    }

    record Details(String workspaceId, String storageId, String displayName, String registrationId,
            String sourceWorkspaceId, Long sourceGeneration, String cwdRelative) {
        Details(String workspaceId, String storageId, String displayName, String registrationId) {
            this(workspaceId, storageId, displayName, registrationId, null, null, null);
        }
    }
}
