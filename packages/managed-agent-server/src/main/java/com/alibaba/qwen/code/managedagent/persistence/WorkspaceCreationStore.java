package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry.WorkspaceSummary;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCreationRoots.Details;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
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

    public WorkspaceSummary create(String tenant, String actor, String displayName, String key,
            String sourceWorkspaceId, String cwdRelative) {
        if (sourceWorkspaceId == null && cwdRelative != null
                || sourceWorkspaceId != null && cwdRelative == null) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_request",
                    "Source Workspace and directory must be supplied together.");
        }
        WorkspaceSelection selected = sourceWorkspaceId == null ? null
                : new WorkspaceSelection(sourceWorkspaceId, cwdRelative);
        if (selected == null ? !enabled() : !directorySelectionEnabled()) {
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
                    var source = selected == null ? null : ownedSource(tenant, actor, selected);
                    Details details = source == null
                            ? new Details("workspace-" + receiptKey, "created-" + receiptKey,
                                name, UUID.randomUUID().toString())
                            : new Details("workspace-" + receiptKey, source.binding().getStorageId(), name,
                                UUID.randomUUID().toString(), selected.workspaceId(),
                                source.binding().getWorkspaceGeneration(), selected.cwdRelative());
                    jdbc.update("UPDATE ma_request_receipt SET result_json = ?, request_digest = ? WHERE receipt_key = ?",
                            encode(details), digest(name, selected, details.sourceGeneration()), receiptKey);
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
        String digest = digest(name, selected, details.sourceGeneration());
        requireDigest(receipt, digest);
        if ("COMPLETED".equals(receipt.state())) {
            return replay(tenant, actor, details);
        }
        if (!"PENDING".equals(receipt.state())) {
            throw WorkspaceExecutionStore.unavailable();
        }
        try {
            if (selected == null) {
                roots.prepare(tenant, receiptKey);
                guard.registerCreated(tenant, details.storageId(), details.registrationId());
            } else {
                transaction.executeWithoutResult(status -> verifySource(tenant, actor, details));
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
            var source = selected == null ? null : verifySource(tenant, actor, details);
            jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                            + " storage_id, display_name, config_ref, policy_ref, state, gmt_create, gmt_modified)"
                            + " VALUES (?, ?, 1, ?, ?, ?, ?, 'ACTIVE', ?, ?)",
                    tenant, details.workspaceId(), details.storageId(), details.displayName(),
                    source == null ? WorkspaceExecutionProfile.CONFIG_REF : source.configRef(),
                    source == null ? WorkspaceExecutionProfile.POLICY_REF : source.policyRef(), now, now);
            jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                            + " VALUES (?, ?, ?, 'OWNER')", tenant, details.workspaceId(), actorKey);
            jdbc.update("UPDATE ma_request_receipt SET state = 'COMPLETED', gmt_modified = ?"
                    + " WHERE receipt_key = ?", now, receiptKey);
        });
        return replay(tenant, actor, details);
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

    private static String digest(String name, WorkspaceSelection selected, Long generation) {
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
