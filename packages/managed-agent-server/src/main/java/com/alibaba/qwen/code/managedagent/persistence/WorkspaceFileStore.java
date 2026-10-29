package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.provisioning.WorkspaceFileProcess;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

@Component
public class WorkspaceFileStore {
    private final ManagedWorkspaceRegistry registry;
    private final WorkspaceStorageGuard guard;
    private final SshWorkspaceService ssh;
    private final ManagedAgentProperties properties;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final ObjectMapper mapper;
    private final java.util.concurrent.Semaphore reads = new java.util.concurrent.Semaphore(4);

    public WorkspaceFileStore(ManagedWorkspaceRegistry registry, WorkspaceStorageGuard guard,
            SshWorkspaceService ssh, ManagedAgentProperties properties, @Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentTransactionManager") PlatformTransactionManager manager, @Qualifier("managedAgentObjectMapper") ObjectMapper mapper) {
        this.registry = registry;
        this.guard = guard;
        this.ssh = ssh;
        this.properties = properties;
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.mapper = mapper;
    }

    public record Entry(String path, String name, String kind) {
    }

    public record QueryResult(String scopeRevision, String directory, List<Entry> entries, boolean truncated,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Integer maxUploadBytes) {
    }

    public record FileResult(String scopeRevision, String path, String name, String mimeType,
            String text, int byteLength, String sha256) {
    }

    public record Locator(String sessionId, String workspaceId, String cwdRelative) {
        public Locator {
            if (sessionId != null) {
                if (!sessionId.matches("[A-Za-z0-9._:-]{1,128}") || workspaceId != null || cwdRelative != null) {
                    throw invalidLocator();
                }
            } else {
                if (workspaceId == null || cwdRelative == null) {
                    throw invalidLocator();
                }
                cwdRelative = new WorkspaceSelection(workspaceId, cwdRelative).cwdRelative();
            }
        }
    }

    public QueryResult query(String tenant, String actor, String workspace, String cwd,
            String directory, String query, String revision) {
        return query(tenant, actor, new Locator(null, workspace, cwd), directory, query, revision);
    }

    public QueryResult query(String tenant, String actor, Locator locator,
            String directory, String query, String revision) {
        Map<String, Object> request = Map.of("protocolVersion", 1, "operation", "query",
                "directory", directory, "query", query);
        var result = exchange(tenant, actor, locator, revision, request);
        try {
            Entry[] entries = mapper.convertValue(result.files().get("entries"), Entry[].class);
            if (entries == null || entries.length > 50 || java.util.Arrays.stream(entries).anyMatch(entry -> entry == null
                    || entry.path() == null || entry.name() == null || entry.kind() == null || !List.of("file", "directory").contains(entry.kind()))) {
                throw unavailable();
            }
            Integer maximum = mapper.convertValue(result.files().get("maxUploadBytes"), Integer.class);
            return new QueryResult(result.revision(), directory, List.of(entries),
                    Boolean.TRUE.equals(result.files().get("truncated")),
                    Integer.valueOf(WorkspaceFileProcess.MAX_UPLOAD_BYTES).equals(maximum) ? maximum : null);
        } catch (IllegalArgumentException error) {
            throw unavailable();
        }
    }

    public FileResult read(String tenant, String actor, String workspace, String cwd, String path, String revision) {
        return read(tenant, actor, new Locator(null, workspace, cwd), path, revision);
    }

    public FileResult read(String tenant, String actor, Locator locator, String path, String revision) {
        var result = exchange(tenant, actor, locator, revision,
                Map.of("protocolVersion", 1, "operation", "read", "path", path));
        var file = result.files();
        try {
            String text = (String) file.get("text");
            byte[] bytes = text.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            if (bytes.length == 0 || bytes.length > 24576 || text.indexOf('\0') >= 0
                    || !path.equals(file.get("path")) || !DigestUtils.sha256Hex(bytes).equals(file.get("sha256"))) {
                throw unavailable();
            }
            return new FileResult(result.revision(), path, (String) file.get("name"), "text/plain",
                    text, bytes.length, DigestUtils.sha256Hex(bytes));
        } catch (ClassCastException | NullPointerException error) {
            throw unavailable();
        }
    }

    record Scope(ContextBinding binding, String kind, String revision, Map<String, Object> sessionFileScope) {
    }

    private record Exchange(String revision, Map<String, Object> files) {
    }

    private Exchange exchange(String tenant, String actor, Locator locator,
            String expectedRevision, Map<String, Object> files) {
        Scope before = scope(tenant, actor, locator);
        if (expectedRevision != null && !expectedRevision.equals(before.revision())) {
            throw changed();
        }
        if (!reads.tryAcquire()) {
            throw new ManagedAgentException(HttpStatus.SERVICE_UNAVAILABLE, "workspace_files_busy", "Workspace file access is busy; try again.");
        }
        try {
            Map<String, Object> result;
            if ("SSH_LOCAL".equals(before.kind())) {
                result = ssh.files(before.binding(), files);
            } else if ("LOCAL".equals(before.kind())) {
                var root = guard.fileRoot(before.binding());
                Map<String, Object> request = new LinkedHashMap<>();
                request.put("protocolVersion", 1);
                request.put("operation", "probe");
                request.put("nodeId", "local-files");
                request.put("stateDirectory", properties.getRuntimeBroker().getStateDirectory());
                request.put("root", root.get("root"));
                request.put("allowedRoots", List.of(root.get("root")));
                request.put("cwdRelative", before.binding().getCwdRelative());
                request.put("localRootIdentity", Map.of("device", root.get("device"), "inode", root.get("inode")));
                if (before.sessionFileScope() != null) {
                    request.put("sessionFileScope", before.sessionFileScope());
                }
                request.put("files", files);
                result = WorkspaceFileProcess.read(properties.getRuntimeBroker().getNodeExecutable(),
                        properties.getRuntimeBroker().getWorkerEntry(), request);
                if (!root.equals(guard.fileRoot(before.binding()))) {
                    throw changed();
                }
            } else {
                throw new ManagedAgentException(HttpStatus.CONFLICT, "workspace_files_unsupported", "This Workspace storage does not support file references.");
            }
            Scope after = scope(tenant, actor, locator);
            if (!before.revision().equals(after.revision())) {
                throw changed();
            }
            if (!(result.get("files") instanceof Map<?, ?> contents) || !Integer.valueOf(1).equals(
                    mapper.convertValue(contents.get("protocolVersion"), Integer.class))) {
                throw WorkspaceFileProcess.unsupported();
            }
            return new Exchange(before.revision(), mapper.convertValue(contents,
                    mapper.getTypeFactory().constructMapType(LinkedHashMap.class, String.class, Object.class)));
        } finally {
            reads.release();
        }
    }

    Scope scope(String tenant, String actor, String workspace, String cwd) {
        return scope(tenant, actor, new Locator(null, workspace, cwd));
    }

    Scope scope(String tenant, String actor, Locator locator) {
        return Objects.requireNonNull(transaction.execute(status -> {
            ContextBinding binding = locator.sessionId() == null
                    ? registry.resolveForCreation(tenant, actor, new WorkspaceSelection(locator.workspaceId(), locator.cwdRelative())).binding()
                    : sessionBinding(tenant, actor, locator.sessionId());
            if (!properties.getHarness().isWorkspaceFilesEnabled()) {
                throw new ManagedAgentException(HttpStatus.CONFLICT, "workspace_files_disabled", "Workspace file access is disabled.");
            }
            Map<String, Object> sessionFileScope = null;
            long worktreeRevision = 0;
            if (locator.sessionId() != null) {
                SessionWorktreeStore.requireReady(jdbc, tenant, locator.sessionId());
                var worktree = SessionWorktreeStore.descriptor(jdbc, tenant, locator.sessionId());
                if (worktree != null) {
                    String prefix = ".qwen-managed-worktrees/" + worktree.worktreeId();
                    if (!binding.getCwdRelative().equals(prefix) && !binding.getCwdRelative().startsWith(prefix + "/")) {
                        throw unavailable();
                    }
                    worktreeRevision = worktree.revision();
                    var root = guard.fileRoot(binding);
                    try {
                        var identity = java.nio.file.Files.readAttributes(java.nio.file.Path.of((String) root.get("root"))
                                .resolve(".qwen-managed-worktrees").resolve(worktree.worktreeId()), "unix:dev,ino", java.nio.file.LinkOption.NOFOLLOW_LINKS);
                        SessionWorktreeStore.requireReady(jdbc, tenant, locator.sessionId());
                        sessionFileScope = Map.of("sessionId", locator.sessionId(), "contextDigest", binding.getContextDigest(),
                                "worktreeId", worktree.worktreeId(), "worktreeRevision", worktreeRevision, "cwdRelative", binding.getCwdRelative(),
                                "worktreeRootIdentity", Map.of("device", Long.toUnsignedString(((Number) identity.get("dev")).longValue()),
                                        "inode", Long.toUnsignedString(((Number) identity.get("ino")).longValue())));
                    } catch (java.io.IOException error) {
                        throw unavailable();
                    }
                }
            }
            var rows = jdbc.queryForList("SELECT storage_kind, registration_json, registration_revision, mount_revision, fence_operation_id FROM ma_storage WHERE alias_key = ? FOR UPDATE",
                    JdbcRuntimeBindingRepository.storageAliasKey(tenant, binding.getStorageId()));
            if (rows.size() != 1 || rows.getFirst().get("fence_operation_id") != null) {
                throw unavailable();
            }
            var owner = jdbc.queryForList("SELECT mount_revision, mount_registration_id, mount_state, mount_operation_id FROM ma_storage_owner"
                    + " WHERE storage_key = (SELECT physical_key FROM ma_storage WHERE alias_key = ?)",
                    JdbcRuntimeBindingRepository.storageAliasKey(tenant, binding.getStorageId()));
            try {
                var identity = locator.sessionId() == null ? List.of(actor, binding.getContextDigest(), rows, owner)
                        : List.of(actor, binding.getContextDigest(), rows, owner, locator.sessionId(), worktreeRevision);
                String revision = DigestUtils.sha256Hex(mapper.writeValueAsBytes(identity));
                return new Scope(binding, (String) rows.getFirst().get("storage_kind"), revision, sessionFileScope);
            } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
                throw new IllegalStateException(error);
            }
        }));
    }

    private ContextBinding sessionBinding(String tenant, String actor, String sessionId) {
        var bindings = jdbc.query("SELECT * FROM ma_session WHERE tenant_id = ? AND session_id = ?"
                        + " AND status <> 'DELETED' FOR UPDATE",
                (result, row) -> ManagedAgentStore.readBinding(result), tenant, sessionId);
        if (bindings.size() != 1 || bindings.getFirst() == null
                || !registry.accessOf(tenant, actor, bindings.getFirst().getWorkspaceId()).canCreate()) {
            throw sessionNotFound();
        }
        var binding = bindings.getFirst();
        if (jdbc.queryForList("SELECT 1 FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ? AND state = 'ACTIVE'"
                + " AND workspace_generation = ? AND storage_id = ?", Integer.class, tenant, binding.getWorkspaceId(),
                binding.getWorkspaceGeneration(), binding.getStorageId()).isEmpty()) {
            throw unavailable();
        }
        registry.requireSshNodeAccess(tenant, actor, binding.getStorageId());
        return binding;
    }

    private static ManagedAgentException invalidLocator() {
        return new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_request", "Select either a Session or a Workspace directory.");
    }

    private static ManagedAgentException sessionNotFound() {
        return new ManagedAgentException(HttpStatus.NOT_FOUND, "session_not_found", "Session not found.");
    }

    private static ManagedAgentException changed() {
        return new ManagedAgentException(HttpStatus.CONFLICT, "workspace_file_scope_changed", "Workspace changed; select the file again.");
    }

    private static ManagedAgentException unavailable() {
        return new ManagedAgentException(HttpStatus.CONFLICT, "workspace_file_unavailable", "Workspace file is unavailable.");
    }
}
