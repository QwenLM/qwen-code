package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry.WorkspaceSummary;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCreationRoots.Details;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.UUID;

@Repository
public class WorkspaceCreationStore {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final WorkspaceStorageGuard guard;
    private final ManagedWorkspaceRegistry registry;
    private final WorkspaceCreationRoots roots;
    private final WorkspaceLocalDirectories localDirectories;
    private final boolean localDirectoryImport;
    private final ObjectMapper json;
    private final Clock clock;

    public WorkspaceCreationStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            WorkspaceStorageGuard guard, ManagedWorkspaceRegistry registry,
            ManagedAgentProperties properties, ObjectMapper json, Clock clock) {
        this.jdbc = jdbc;
        transaction = new TransactionTemplate(manager);
        this.guard = guard;
        this.registry = registry;
        roots = new WorkspaceCreationRoots(jdbc, properties);
        localDirectories = new WorkspaceLocalDirectories(properties);
        localDirectoryImport = properties.getRuntimeBroker().isLocalDirectoryImportEnabled();
        this.json = json;
        this.clock = clock;
    }

    public boolean enabled() {
        return roots.enabled() && guard.enabled();
    }

    public WorkspaceSummary create(String tenant, String actor, String displayName, String key) {
        return create(tenant, actor, displayName, key, null, null);
    }

    public boolean directorySelectionEnabled() {
        return guard.enabled();
    }

    public boolean localDirectoryImportEnabled() {
        return localDirectoryImport && guard.enabled();
    }

    public WorkspaceSummary create(String tenant, String actor, String displayName, String key,
            String sourceWorkspaceId, String cwdRelative) {
        return create(tenant, actor, displayName, key, sourceWorkspaceId, cwdRelative, null);
    }

    public WorkspaceSummary create(String tenant, String actor, String displayName, String key,
            String sourceWorkspaceId, String cwdRelative, String localPath) {
        if (localPath != null && (sourceWorkspaceId != null || cwdRelative != null)) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_request",
                    "Local path and source Workspace must not be combined.");
        }
        if (sourceWorkspaceId == null && cwdRelative != null
                || sourceWorkspaceId != null && cwdRelative == null) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_request",
                    "Source Workspace and directory must be supplied together.");
        }
        WorkspaceSelection selected = sourceWorkspaceId == null ? null
                : new WorkspaceSelection(sourceWorkspaceId, cwdRelative);
        if (localPath != null ? !localDirectoryImportEnabled()
                : selected == null ? !enabled() : !directorySelectionEnabled()) {
            throw new ManagedAgentException(HttpStatus.CONFLICT, "workspace_creation_unavailable",
                    "Workspace creation is not enabled.");
        }
        String name = displayName == null ? "" : displayName.strip();
        if (name.isEmpty() || name.length() > 128
                || name.codePoints().anyMatch(Character::isISOControl)) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_workspace_name",
                    "Workspace name must contain 1-128 characters without control characters.");
        }
        if (key == null || !key.matches("[\\x21-\\x7e]{1,128}")) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_idempotency_key",
                    "Idempotency-Key must contain 1-128 visible characters.");
        }
        WorkspaceStorageKindGuard.requireFreshTransaction();
        byte[] actorKey = ManagedWorkspaceRegistry.actorKey(tenant, actor);
        String scope = ManagedReceipts.actorScope(actorKey);
        String receiptKey = ManagedSchemaKeys.receiptKey(ReceiptNamespace.WORKSPACE_CREATE,
                tenant, ReceiptScope.ACTOR, scope, key);
        ManagedReceipts.Receipt receipt = find(tenant, scope, key, false);
        if (receipt == null) {
            try {
                receipt = transaction.execute(status -> {
                    long now = clock.millis();
                    ManagedReceipts.insert(jdbc, ReceiptNamespace.WORKSPACE_CREATE, tenant,
                            ReceiptScope.ACTOR, scope, key, ManagedSchemaKeys.key(name), "CREATE_WORKSPACE", actorKey,
                            null, null, "PENDING", null, null, now);
                    Details details;
                    if (localPath != null) {
                        Path project = localDirectories.project(localPath);
                        var existing = localSource(tenant, actor, project);
                        if (existing == null) {
                            Path root = localDirectories.root(project);
                            String relative = new WorkspaceSelection("workspace-" + receiptKey,
                                    root.relativize(project).toString()).cwdRelative();
                            details = new Details("workspace-" + receiptKey, "created-" + receiptKey, name,
                                    UUID.randomUUID().toString(), null, null, relative,
                                    guard.identity(root));
                        } else {
                            details = sourceDetails(tenant, actor, name, receiptKey, existing);
                        }
                    } else if (selected == null) {
                        details = new Details("workspace-" + receiptKey, "created-" + receiptKey,
                                name, UUID.randomUUID().toString());
                    } else {
                        details = sourceDetails(tenant, actor, name, receiptKey, selected);
                    }
                    jdbc.update("UPDATE ma_request_receipt SET result_json = ?, request_digest = ? WHERE receipt_key = ?",
                            encode(details), digest(name, selected, details.sourceGeneration(), localPath), receiptKey);
                    return find(tenant, scope, key, true);
                });
            } catch (DuplicateKeyException race) {
                receipt = find(tenant, scope, key, false);
                if (receipt == null) {
                    throw race;
                }
            }
        }
        Details details = WorkspaceCreationRoots.details(Objects.requireNonNull(receipt).resultJson(), receiptKey);
        String digest = digest(name, selected, details.sourceGeneration(), localPath);
        requireDigest(receipt, digest);
        if ("COMPLETED".equals(receipt.state())) {
            return replay(tenant, actor, details);
        }
        if (!"PENDING".equals(receipt.state())) {
            throw WorkspaceExecutionStore.unavailable();
        }
        if (details.localRoot() != null) {
            details = reuseImportedRoot(tenant, actor, scope, key, details, digest);
            if ("COMPLETED".equals(find(tenant, scope, key, false).state())) {
                return replay(tenant, actor, details);
            }
        }
        final Details admitted = details;
        try {
            if (admitted.sourceWorkspaceId() == null) {
                if (admitted.localRoot() == null) {
                    roots.prepare(tenant, receiptKey);
                }
                guard.registerCreated(tenant, details.storageId(), details.registrationId());
            } else {
                transaction.executeWithoutResult(status -> verifySource(tenant, actor, admitted));
            }
        } catch (RuntimeException error) {
            ManagedReceipts.Receipt current = find(tenant, scope, key, false);
            if (current != null && "COMPLETED".equals(current.state())) {
                requireDigest(current, digest);
                return replay(tenant, actor, WorkspaceCreationRoots.details(current.resultJson(), receiptKey));
            }
            throw error;
        }
        transaction.executeWithoutResult(status -> {
            ManagedReceipts.Receipt current = find(tenant, scope, key, true);
            requireDigest(Objects.requireNonNull(current), digest);
            if ("COMPLETED".equals(current.state())) {
                return;
            }
            if (!"PENDING".equals(current.state())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            long now = clock.millis();
            Details completed = WorkspaceCreationRoots.details(current.resultJson(), receiptKey);
            var source = completed.sourceWorkspaceId() == null ? null : verifySource(tenant, actor, completed);
            if (completed.localRoot() != null) {
                Path root = Path.of(completed.localRoot().root());
                if (!completed.localRoot().equals(guard.identity(root))) {
                    throw WorkspaceExecutionStore.unavailable();
                }
                localDirectories.project(root.resolve(completed.cwdRelative()).toString());
            }
            jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                            + " storage_id, display_name, config_ref, policy_ref, state, gmt_create, gmt_modified)"
                            + " VALUES (?, ?, 1, ?, ?, ?, ?, 'ACTIVE', ?, ?)",
                    tenant, completed.workspaceId(), completed.storageId(), completed.displayName(),
                    source == null ? WorkspaceExecutionProfile.CONFIG_REF : source.configRef(),
                    source == null ? WorkspaceExecutionProfile.POLICY_REF : source.policyRef(), now, now);
            jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                            + " VALUES (?, ?, ?, 'OWNER')", tenant, completed.workspaceId(), actorKey);
            jdbc.update("UPDATE ma_request_receipt SET state = 'COMPLETED', gmt_modified = ?"
                    + " WHERE receipt_key = ?", now, receiptKey);
        });
        return replay(tenant, actor, details);
    }

    public DirectoryPage localDirectories(String localPath) {
        if (!localDirectoryImportEnabled()) {
            throw new ManagedAgentException(HttpStatus.CONFLICT, "workspace_creation_unavailable",
                    "Local directory import is not enabled.");
        }
        return localDirectories.directories(localPath);
    }

    public DirectoryPage directories(String tenant, String actor, String workspace, String cwd) {
        if (!directorySelectionEnabled()) {
            throw new ManagedAgentException(HttpStatus.CONFLICT, "workspace_creation_unavailable",
                    "Directory selection is not enabled.");
        }
        WorkspaceSelection selected = new WorkspaceSelection(workspace, cwd);
        var source = transaction.execute(status -> ownedSource(tenant, actor, selected));
        ContextBinding binding = Objects.requireNonNull(source).binding();
        Path root = guard.verifiedRoot(binding);
        Path directory = root.resolve(selected.cwdRelative()).normalize();
        List<Directory> children = new ArrayList<>();
        boolean truncated = false;
        try (var entries = Files.newDirectoryStream(directory)) {
            int scanned = 0;
            for (Path child : entries) {
                if (++scanned > 1024) {
                    truncated = true;
                    break;
                }
                String name = child.getFileName().toString();
                if (!reserved(name) && Files.isDirectory(child, LinkOption.NOFOLLOW_LINKS)
                        && child.equals(child.toRealPath()) && Files.isReadable(child) && Files.isExecutable(child)
                        && name.codePoints().noneMatch(Character::isISOControl)) {
                    if (children.size() == 100) {
                        truncated = true;
                        break;
                    }
                    children.add(new Directory(name, root.relativize(child).toString()));
                }
            }
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailable(error);
        }
        guard.verify(binding);
        children.sort(Comparator.comparing(Directory::name));
        return new DirectoryPage(root.toString(), selected.cwdRelative(), children, truncated);
    }

    private Details sourceDetails(String tenant, String actor, String name, String receiptKey, WorkspaceSelection selected) {
        var source = ownedSource(tenant, actor, selected);
        return new Details("workspace-" + receiptKey, source.binding().getStorageId(), name,
                UUID.randomUUID().toString(), selected.workspaceId(), source.binding().getWorkspaceGeneration(),
                selected.cwdRelative());
    }

    private WorkspaceSelection localSource(String tenant, String actor, Path project) {
        List<String> candidates = jdbc.queryForList("SELECT w.workspace_id FROM ma_workspace w"
                        + " JOIN ma_workspace_access a ON a.tenant_id = w.tenant_id AND a.workspace_id = w.workspace_id"
                        + " JOIN ma_storage s ON s.tenant_id = w.tenant_id AND s.storage_id = w.storage_id"
                        + " WHERE w.tenant_id = ? AND a.actor_id = ? AND a.role = 'OWNER'"
                        + " AND w.state = 'ACTIVE' AND w.workspace_kind = 'ROOT' AND s.storage_kind = 'LOCAL'"
                        + " ORDER BY w.workspace_id", String.class, tenant, ManagedWorkspaceRegistry.actorKey(tenant, actor));
        for (String workspace : candidates) {
            String storage = jdbc.queryForObject("SELECT storage_id FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?",
                    String.class, tenant, workspace);
            Path root;
            try {
                root = guard.configuredRoot(tenant, storage);
            } catch (ManagedAgentException | RuntimeBrokerException unavailable) {
                continue;
            }
            if (root != null && project.startsWith(root)) {
                var selection = new WorkspaceSelection(workspace, root.equals(project) ? "." : root.relativize(project).toString());
                ownedSource(tenant, actor, selection);
                return selection;
            }
        }
        return null;
    }

    private Details reuseImportedRoot(String tenant, String actor, String scope, String key, Details details, String digest) {
        String receiptKey = details.workspaceId().substring("workspace-".length());
        Path root = Path.of(details.localRoot().root());
        localDirectories.requireStorageRoot(root);
        if (!details.localRoot().equals(guard.identity(root))) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return transaction.execute(status -> {
            var receipt = find(tenant, scope, key, true);
            requireDigest(Objects.requireNonNull(receipt), digest);
            Details current = WorkspaceCreationRoots.details(receipt.resultJson(), receiptKey);
            if (!"PENDING".equals(receipt.state()) || current.localRoot() == null) {
                return current;
            }
            var existing = localSource(tenant, actor, root.resolve(current.cwdRelative()));
            if (existing == null) {
                return current;
            }
            Details reused = sourceDetails(tenant, actor, current.displayName(), receiptKey, existing);
            jdbc.update("UPDATE ma_request_receipt SET result_json = ? WHERE receipt_key = ?", encode(reused), receiptKey);
            return reused;
        });
    }

    private ManagedWorkspaceRegistry.ResolvedBinding ownedSource(String tenant, String actor,
            WorkspaceSelection selected) {
        for (String segment : selected.cwdRelative().split("/")) {
            if (reserved(segment)) {
                throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_cwd", "Select a project directory.");
            }
        }
        var source = registry.resolveOwnedDirectory(tenant, actor, selected.workspaceId(), selected.cwdRelative());
        Path root = guard.verifiedRoot(source.binding());
        Path directory = root.resolve(selected.cwdRelative()).normalize();
        if (!Files.isReadable(directory) || !Files.isExecutable(directory)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return source;
    }

    private ManagedWorkspaceRegistry.ResolvedBinding verifySource(String tenant, String actor, Details details) {
        var source = ownedSource(tenant, actor,
                new WorkspaceSelection(details.sourceWorkspaceId(), details.cwdRelative()));
        if (source.binding().getWorkspaceGeneration() != details.sourceGeneration()
                || !source.binding().getStorageId().equals(details.storageId())) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return source;
    }

    private static boolean reserved(String name) {
        return ".git".equals(name) || ".qwen-child-workspaces".equals(name);
    }

    private static String digest(String name, WorkspaceSelection selected, Long generation, String localPath) {
        if (localPath != null) {
            return ManagedSchemaKeys.key("local-directory-import/1", name, localPath);
        }
        return selected == null ? ManagedSchemaKeys.key(name)
                : ManagedSchemaKeys.key(name, selected.workspaceId(), selected.cwdRelative(), String.valueOf(generation));
    }

    public record Directory(String name, String cwdRelative) {}

    public record DirectoryPage(String root, String cwdRelative, List<Directory> directories, boolean truncated) {}

    private WorkspaceSummary replay(String tenant, String actor, Details details) {
        WorkspaceSummary found = registry.findReadable(tenant, actor, details.workspaceId());
        if (found == null) {
            throw new ManagedAgentException(HttpStatus.NOT_FOUND, "workspace_not_found", "Workspace not found.");
        }
        return found;
    }

    private ManagedReceipts.Receipt find(String tenant, String scope, String key, boolean lock) {
        return ManagedReceipts.find(jdbc, ReceiptNamespace.WORKSPACE_CREATE, tenant,
                ReceiptScope.ACTOR, scope, key, lock);
    }

    private static void requireDigest(ManagedReceipts.Receipt receipt, String digest) {
        if (!digest.equals(receipt.requestDigest())) {
            throw new ManagedAgentException(HttpStatus.CONFLICT, "idempotency_conflict",
                    "Idempotency key was already used for another Workspace request.");
        }
    }

    private String encode(Details details) {
        try {
            return json.writeValueAsString(details);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
    }
}
