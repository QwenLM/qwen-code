package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService.FileTarget;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.provisioning.WorkspaceFileProcess;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.Semaphore;

@Component
public class WorkspaceFileUploadStore {
    private static final Logger LOG = LoggerFactory.getLogger(WorkspaceFileUploadStore.class);
    private static final String KIND = "WORKSPACE_UPLOAD";
    private static final int LIMIT = WorkspaceFileProcess.MAX_UPLOAD_BYTES;
    private final WorkspaceFileStore files;
    private final ManagedWorkspaceRegistry registry;
    private final WorkspaceStorageGuard guard;
    private final SshWorkspaceService ssh;
    private final ManagedAgentProperties properties;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final ObjectMapper mapper;
    private final Executor executor;
    private final Semaphore slots = new Semaphore(4);
    private final Set<String> running = ConcurrentHashMap.newKeySet();

    public WorkspaceFileUploadStore(WorkspaceFileStore files, ManagedWorkspaceRegistry registry,
            WorkspaceStorageGuard guard, SshWorkspaceService ssh, ManagedAgentProperties properties,
            @Qualifier("managedJdbcTemplate") JdbcTemplate jdbc, @Qualifier("managedAgentTransactionManager") PlatformTransactionManager manager, @Qualifier("managedAgentObjectMapper") ObjectMapper mapper,
            @Qualifier("managedAgentExecutor") Executor executor) {
        this.files = files;
        this.registry = registry;
        this.guard = guard;
        this.ssh = ssh;
        this.properties = properties;
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.mapper = mapper;
        this.executor = executor;
    }

    public record UploadResult(String scopeRevision, String uploadId, String path, int sizeBytes, String sha256) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record UploadStatus(String scopeRevision, String uploadId, String state, String path,
            int sizeBytes, String sha256, String code) {
    }

    private record Frozen(String tenant, String actor, String workspace, String cwd, String revision, String session,
            String uploadId, String path, int sizeBytes, String sha256, String physical,
            String node, String entry, Map<String, Object> request, FileTarget remote) {
    }

    private record Operation(String key, String digest, Frozen target, UploadStatus result, boolean fresh) {
    }

    public UploadResult upload(String tenant, String actor, String workspace, String cwd, String path,
            String revision, String uploadId, InputStream input, long contentLength) {
        return upload(tenant, actor, new WorkspaceFileStore.Locator(null, workspace, cwd), path, revision, uploadId, input, contentLength);
    }

    public UploadResult upload(String tenant, String actor, WorkspaceFileStore.Locator locator, String path,
            String revision, String uploadId, InputStream input, long contentLength) {
        validate(path, revision, uploadId);
        if (locator.sessionId() == null && !".".equals(locator.cwdRelative())) {
            validate(locator.cwdRelative(), revision, uploadId);
        }
        if (!slots.tryAcquire()) {
            throw busy();
        }
        String key = key(tenant, uploadId);
        try {
            Operation saved = find(tenant, uploadId, false);
            if (saved == null) {
                WorkspaceFileStore.Scope scope = files.scope(tenant, actor, locator);
                if (!revision.equals(scope.revision())) {
                    throw changed();
                }
            } else {
                authorize(saved, actor);
            }
            byte[] bytes = read(input, contentLength);
            String digest = digest(locator.sessionId() == null
                    ? List.of(actor, locator.workspaceId(), locator.cwdRelative(), path, revision, uploadId, bytes.length, DigestUtils.sha256Hex(bytes))
                    : List.of(actor, List.of("session", locator.sessionId()), path, revision, uploadId, bytes.length, DigestUtils.sha256Hex(bytes)));
            Operation operation = admit(tenant, actor, locator, path, revision, uploadId,
                    bytes.length, DigestUtils.sha256Hex(bytes), digest);
            running.add(key);
            UploadStatus result = operation.result();
            if (result == null) {
                try {
                    result = exchange(operation, operation.fresh() ? bytes : null);
                } catch (RuntimeBrokerException error) {
                    if (operation.fresh() && "workspace_files_unsupported".equals(error.getCode())) {
                        result = finish(operation, status(operation.target(), "failed", "workspace_files_unsupported"));
                    } else {
                        defer(operation.key());
                        throw pending();
                    }
                } catch (RuntimeException error) {
                    defer(operation.key());
                    throw pending();
                }
            }
            authorize(operation, actor);
            if ("pending".equals(result.state())) {
                throw pending();
            }
            if ("failed".equals(result.state())) {
                throw new ManagedAgentException(HttpStatus.CONFLICT, result.code(), "Workspace upload failed.");
            }
            return new UploadResult(result.scopeRevision(), result.uploadId(), result.path(), result.sizeBytes(), result.sha256());
        } finally {
            running.remove(key);
            slots.release();
        }
    }

    public UploadStatus query(String tenant, String actor, String uploadId) {
        validateId(uploadId);
        Operation operation = find(tenant, uploadId, false);
        if (operation == null) {
            throw notFound();
        }
        authorize(operation, actor);
        if (operation.result() != null) {
            return operation.result();
        }
        if (!slots.tryAcquire()) {
            return status(operation.target(), "pending", null);
        }
        try {
            UploadStatus result;
            try {
                result = exchange(operation, null);
            } catch (RuntimeException unavailable) {
                defer(operation.key());
                result = status(operation.target(), "pending", null);
            }
            authorize(operation, actor);
            return result;
        } finally {
            slots.release();
        }
    }

    @Scheduled(scheduler = "managedAgentScheduler", initialDelay = 5000, fixedDelay = 5000)
    public void reconcile() {
        var due = jdbc.queryForList("SELECT tenant_id, operation_id FROM ma_operation WHERE operation_kind = ?"
                + " AND state = 'RUNNING' AND available_at <= " + ManagedSchemaTime.SQL_NOW
                + " ORDER BY available_at, operation_key LIMIT 4", KIND);
        for (var row : due) {
            String tenant = text(row.get("tenant_id"));
            String uploadId = text(row.get("operation_id"));
            String key = key(tenant, uploadId);
            if (!running.add(key)) {
                continue;
            }
            if (!slots.tryAcquire()) {
                running.remove(key);
                return;
            }
            try {
                executor.execute(() -> {
                    try {
                        Operation operation = find(tenant, uploadId, false);
                        if (operation != null && operation.result() == null) {
                            exchange(operation, null);
                        }
                    } catch (RuntimeException error) {
                        LOG.debug("Workspace upload reconciliation deferred: {}", error.getClass().getSimpleName());
                    } finally {
                        try {
                            defer(key);
                        } finally {
                            running.remove(key);
                            slots.release();
                        }
                    }
                });
            } catch (RuntimeException error) {
                running.remove(key);
                slots.release();
                throw error;
            }
        }
    }

    private Operation admit(String tenant, String actor, WorkspaceFileStore.Locator locator, String path,
            String revision, String uploadId, int size, String sha256, String digest) {
        return transaction.execute(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, tenant);
            Operation previous = find(tenant, uploadId, true);
            if (previous != null) {
                authorize(previous, actor);
                if (!previous.digest().equals(digest)) {
                    throw new ManagedAgentException(HttpStatus.CONFLICT, "workspace_upload_conflict", "Upload ID belongs to another request.");
                }
                return previous;
            }
            var scope = files.scope(tenant, actor, locator);
            if (!revision.equals(scope.revision())) {
                throw changed();
            }
            if (!Set.of("LOCAL", "SSH_LOCAL").contains(scope.kind())) {
                throw new ManagedAgentException(HttpStatus.CONFLICT, "workspace_files_unsupported", "This Workspace storage does not support uploads.");
            }
            WorkspaceMigrationAdmission.requireOpen(jdbc, tenant, scope.binding().getStorageId());
            String physical = jdbc.queryForObject("SELECT physical_key FROM ma_storage WHERE alias_key = ?", String.class,
                    JdbcRuntimeBindingRepository.storageAliasKey(tenant, scope.binding().getStorageId()));
            var owners = jdbc.queryForList("SELECT holder_key, maintenance_id, mount_state FROM ma_storage_owner WHERE storage_key = ? FOR UPDATE", physical);
            if (owners.size() != 1 || !"READY".equals(owners.getFirst().get("mount_state"))) {
                throw changed();
            }
            if (owners.getFirst().get("holder_key") != null || owners.getFirst().get("maintenance_id") != null
                    || WorkspaceExecutionStore.hasExecutionMembers(jdbc, physical)) {
                throw busy();
            }
            Map<String, Object> request = null;
            FileTarget remote = null;
            String workspace = scope.binding().getWorkspaceId();
            String cwd = scope.binding().getCwdRelative();
            if ("LOCAL".equals(scope.kind())) {
                var root = guard.fileRoot(scope.binding());
                request = new LinkedHashMap<>(Map.of("protocolVersion", 1, "operation", "probe", "nodeId", "local-files",
                        "stateDirectory", properties.getRuntimeBroker().getStateDirectory(), "root", root.get("root"),
                        "allowedRoots", List.of(root.get("root")), "cwdRelative", cwd,
                        "localRootIdentity", Map.of("device", root.get("device"), "inode", root.get("inode"))));
                if (scope.sessionFileScope() != null) {
                    request.put("sessionFileScope", scope.sessionFileScope());
                }
            } else {
                remote = ssh.freezeFiles(scope.binding());
            }
            Frozen target = new Frozen(tenant, actor, workspace, cwd, revision, locator.sessionId(), uploadId, path, size, sha256, physical,
                    properties.getRuntimeBroker().getNodeExecutable(), properties.getRuntimeBroker().getWorkerEntry(), request, remote);
            String key = key(tenant, uploadId);
            jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, operation_kind, operation_id, tenant_id, workspace_id, session_id,"
                    + " target_kind, target_key, target_id, storage_key, physical_key, actor_key, request_digest, request_json, state, phase,"
                    + " available_at, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, ?, ?, ?, 'STORAGE', ?, ?, ?, ?, ?, ?, ?, 'RUNNING', 'RUNNING', "
                    + ManagedSchemaTime.SQL_NOW + " + 60000, " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                    key, ManagedSchemaKeys.key(tenant), KIND, uploadId.getBytes(StandardCharsets.UTF_8), tenant.getBytes(StandardCharsets.UTF_8),
                    workspace.getBytes(StandardCharsets.UTF_8), locator.sessionId() == null ? null : locator.sessionId().getBytes(StandardCharsets.UTF_8),
                    ManagedSchemaKeys.key(scope.binding().getStorageId()),
                    scope.binding().getStorageId().getBytes(StandardCharsets.UTF_8),
                    JdbcRuntimeBindingRepository.storageAliasKey(tenant, scope.binding().getStorageId()), physical,
                    ManagedWorkspaceRegistry.actorKey(tenant, actor), digest, encode(target));
            if (jdbc.update("UPDATE ma_storage_owner SET holder_key = ? WHERE storage_key = ? AND holder_key IS NULL AND maintenance_id IS NULL", key, physical) != 1) {
                throw busy();
            }
            return new Operation(key, digest, target, null, true);
        });
    }

    private UploadStatus exchange(Operation operation, byte[] bytes) {
        Frozen target = operation.target();
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("protocolVersion", 1);
        message.put("operation", bytes == null ? "upload-status" : "upload");
        message.put("uploadId", target.uploadId());
        message.put("path", target.path());
        message.put("sizeBytes", target.sizeBytes());
        message.put("sha256", target.sha256());
        if (bytes != null) {
            message.put("data", Base64.getEncoder().encodeToString(bytes));
        }
        Map<String, Object> response;
        if (target.remote() != null) {
            response = ssh.upload(target.remote(), message);
        } else {
            Map<String, Object> request = new LinkedHashMap<>(target.request());
            request.put("files", message);
            response = WorkspaceFileProcess.upload(target.node(), target.entry(), request);
        }
        if (!(response.get("files") instanceof Map<?, ?> result)
                || !Long.valueOf(1).equals(BrokerValues.exactLong(result.get("protocolVersion")))
                || !target.uploadId().equals(result.get("uploadId")) || !target.path().equals(result.get("path"))
                || !Long.valueOf(target.sizeBytes()).equals(BrokerValues.exactLong(result.get("sizeBytes")))
                || !target.sha256().equals(result.get("sha256"))
                || !(result.get("state") instanceof String state) || !Set.of("completed", "failed", "pending").contains(state)) {
            throw pending();
        }
        String code = result.get("code") instanceof String value ? value : null;
        if ("failed".equals(state) && (code == null || !code.matches("ssh_runtime_file_[a-z_]{1,80}"))) {
            throw pending();
        }
        UploadStatus upload = status(target, state, code);
        if ("pending".equals(state)) {
            defer(operation.key());
            return upload;
        }
        return finish(operation, upload);
    }

    private UploadStatus finish(Operation operation, UploadStatus result) {
        return transaction.execute(status -> {
            Frozen target = operation.target();
            WorkspaceStorageKindGuard.lockDomain(jdbc, target.tenant());
            Operation current = find(target.tenant(), target.uploadId(), true);
            if (current == null || !current.digest().equals(operation.digest())) {
                throw pending();
            }
            if (current.result() != null) {
                return current.result();
            }
            if (jdbc.update("UPDATE ma_storage_owner SET holder_key = NULL WHERE storage_key = ? AND holder_key = ?"
                    + " AND maintenance_id IS NULL", target.physical(), operation.key()) != 1) {
                throw pending();
            }
            jdbc.update("UPDATE ma_operation SET state = ?, phase = ?, result_json = ?, completed_at = "
                    + ManagedSchemaTime.SQL_NOW + ", gmt_modified = " + ManagedSchemaTime.SQL_NOW + " WHERE operation_key = ? AND state = 'RUNNING'",
                    result.state(), result.state(), encode(result), operation.key());
            return result;
        });
    }

    private Operation find(String tenant, String uploadId, boolean lock) {
        var rows = jdbc.queryForList("SELECT request_digest, request_json, result_json FROM ma_operation"
                + " WHERE operation_key = ? AND operation_kind = ?" + (lock ? " FOR UPDATE" : ""), key(tenant, uploadId), KIND);
        if (rows.isEmpty()) {
            return null;
        }
        var row = rows.getFirst();
        try {
            Frozen target = mapper.readValue((String) row.get("request_json"), Frozen.class);
            if (!tenant.equals(target.tenant()) || !uploadId.equals(target.uploadId())) {
                throw pending();
            }
            UploadStatus result = row.get("result_json") == null ? null
                    : mapper.readValue((String) row.get("result_json"), UploadStatus.class);
            return new Operation(key(tenant, uploadId), (String) row.get("request_digest"), target, result, false);
        } catch (IOException error) {
            throw pending();
        }
    }

    private void authorize(Operation operation, String actor) {
        if (!operation.target().actor().equals(actor)
                || !registry.accessOf(operation.target().tenant(), actor, operation.target().workspace()).canCreate()
                || operation.target().session() != null
                        && jdbc.queryForList("SELECT 1 FROM ma_session WHERE tenant_id = ? AND session_id = ? AND status <> 'DELETED'",
                                Integer.class, operation.target().tenant(), operation.target().session()).isEmpty()) {
            throw notFound();
        }
    }

    private void defer(String key) {
        jdbc.update("UPDATE ma_operation SET available_at = " + ManagedSchemaTime.SQL_NOW
                + " + 5000 WHERE operation_key = ? AND operation_kind = ? AND state = 'RUNNING'", key, KIND);
    }

    private String encode(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
    }

    private String digest(Object value) {
        return DigestUtils.sha256Hex(encode(value));
    }

    private static UploadStatus status(Frozen target, String state, String code) {
        return new UploadStatus(target.revision(), target.uploadId(), state, target.path(), target.sizeBytes(), target.sha256(), code);
    }

    private static byte[] read(InputStream input, long declared) {
        if (declared > LIMIT) {
            throw tooLarge();
        }
        try {
            byte[] bytes = input.readNBytes(LIMIT + 1);
            if (bytes.length > LIMIT) {
                throw tooLarge();
            }
            if (declared >= 0 && declared != bytes.length) {
                throw invalid();
            }
            return bytes;
        } catch (IOException error) {
            throw invalid();
        }
    }

    private static void validate(String path, String revision, String uploadId) {
        validateId(uploadId);
        if (revision == null || !revision.matches("[a-f0-9]{64}") || path == null || path.length() > 1024
                || path.codePoints().anyMatch(value -> Character.isISOControl(value) || value >= 0xd800 && value <= 0xdfff)
                || path.contains("\\") || java.util.Arrays.stream(path.split("/", -1)).anyMatch(part -> part.isEmpty()
                        || part.equals(".") || part.equals("..") || part.equals(".git") || part.equals(".qwen-child-workspaces")
                        || part.startsWith(".qwen-managed-"))) {
            throw invalid();
        }
    }

    private static void validateId(String uploadId) {
        try {
            if (uploadId == null || !UUID.fromString(uploadId).toString().equals(uploadId)) {
                throw invalid();
            }
        } catch (IllegalArgumentException error) {
            throw invalid();
        }
    }

    private static String key(String tenant, String uploadId) {
        return ManagedSchemaKeys.key(KIND, tenant, uploadId);
    }

    private static String text(Object value) {
        return value instanceof byte[] bytes ? new String(bytes, StandardCharsets.UTF_8) : (String) value;
    }

    private static ManagedAgentException invalid() {
        return new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_request", "Workspace upload request is invalid.");
    }

    private static ManagedAgentException changed() {
        return new ManagedAgentException(HttpStatus.CONFLICT, "workspace_file_scope_changed", "Workspace changed; select the upload destination again.");
    }

    private static ManagedAgentException pending() {
        return new ManagedAgentException(HttpStatus.SERVICE_UNAVAILABLE, "workspace_upload_pending", "Workspace upload outcome is pending; query the original upload ID.");
    }

    private static ManagedAgentException busy() {
        return new ManagedAgentException(HttpStatus.CONFLICT, "workspace_busy", "Workspace file access is busy; try again.");
    }

    private static ManagedAgentException notFound() {
        return new ManagedAgentException(HttpStatus.NOT_FOUND, "workspace_upload_not_found", "Workspace upload not found.");
    }

    private static ManagedAgentException tooLarge() {
        return new ManagedAgentException(HttpStatus.PAYLOAD_TOO_LARGE, "workspace_upload_too_large", "Workspace upload exceeds 8 MiB.");
    }
}
