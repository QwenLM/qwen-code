package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

final class WorkspaceRuntimeResolver {
    private final AgentStateStore sessions;
    private final WorkspaceExecutionStore authority;
    private final Map<Storage, Mount> mounts = new LinkedHashMap<>();

    WorkspaceRuntimeResolver(AgentStateStore sessions, WorkspaceExecutionStore authority,
            ManagedAgentProperties properties) {
        this.sessions = sessions;
        this.authority = authority;
        var broker = properties.getRuntimeBroker();
        if (WorkspaceExecutionProfile.CAPABILITY_DIGEST.equals(
                properties.getHarness().getCapabilityDigest())) {
            throw new IllegalStateException("Workspace execution profile is reserved");
        }
        if (!broker.getWorkspaceMounts().isEmpty()
                && (!"local-process".equals(broker.getProvisioner())
                        || !"session".equals(broker.getIsolationClass()))) {
            throw new IllegalStateException("Workspace execution requires local Session isolation");
        }
        try {
            for (var configured : broker.getWorkspaceMounts()) {
                Path root = Path.of(configured.root());
                BasicFileAttributes attributes = Files.readAttributes(root, BasicFileAttributes.class);
                if (!root.toString().equals(root.toRealPath().toString())
                        || !attributes.isDirectory() || attributes.fileKey() == null) {
                    throw new IllegalStateException("Workspace mount must be a canonical directory");
                }
                for (Mount existing : mounts.values()) {
                    if (root.startsWith(existing.root()) || existing.root().startsWith(root)
                            || Files.isSameFile(root, existing.root())) {
                        throw new IllegalStateException("Workspace mounts must not overlap or alias");
                    }
                }
                Storage key = new Storage(configured.tenantId(), configured.storageId());
                if (mounts.putIfAbsent(key, new Mount(root, attributes.fileKey())) != null) {
                    throw new IllegalStateException("Workspace storage mount is duplicated");
                }
            }
        } catch (IOException error) {
            throw new IllegalStateException("Workspace mount is unavailable", error);
        }
    }

    Resolved resolve(String sessionId) {
        SessionRecord session = sessions.findSessionById(sessionId)
                .orElseThrow(WorkspaceExecutionStore::unavailable);
        authority.authorize(session);
        ContextBinding binding = session.workspace();
        Mount mount = mounts.get(new Storage(binding.getTenantId(), binding.getStorageId()));
        if (mount == null) {
            throw WorkspaceExecutionStore.unavailable();
        }
        verifyMountIntact(mount);
        return new Resolved(binding, new RuntimeScope(session.tenantId(), binding.getWorkspaceId(),
                Long.toString(binding.getWorkspaceGeneration()), mount.root().toString(),
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session"));
    }

    /**
     * The W2 settlement probe: proves for the target directory of a cwd
     * change what a later acquisition proves for the current one — the
     * administrator mount mapping and continuity, the storage guard when
     * enabled, and the directory rule {@code acquire()} enforces — without
     * claiming storage or contacting a worker. Read-only and idempotent.
     */
    void verifyInstallable(ContextBinding binding, String targetCwdRelative) {
        Mount mount = mounts.get(new Storage(binding.getTenantId(), binding.getStorageId()));
        if (mount == null) {
            throw WorkspaceExecutionStore.unavailable();
        }
        verifyMountIntact(mount);
        authority.verifyMount(binding);
        requireDirectory(mount.root().toString(), targetCwdRelative);
    }

    private static void verifyMountIntact(Mount mount) {
        try {
            if (!mount.root().equals(mount.root().toRealPath())
                    || !Objects.equals(mount.fileKey(), Files.readAttributes(
                            mount.root(), BasicFileAttributes.class).fileKey())) {
                throw WorkspaceExecutionStore.unavailable();
            }
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    static void requireDirectory(String root, String cwdRelative) {
        try {
            Path base = Path.of(root);
            Path directory = base.resolve(cwdRelative).normalize();
            if (!directory.startsWith(base) || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)
                    || !directory.toRealPath().equals(directory)) {
                throw WorkspaceExecutionStore.unavailable();
            }
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    ContextBinding savedBinding(String sessionId) {
        return sessions.findSessionById(sessionId).map(SessionRecord::workspace)
                .orElseThrow(WorkspaceExecutionStore::unavailable);
    }

    record Resolved(ContextBinding binding, RuntimeScope scope) {
    }

    private record Storage(String tenantId, String storageId) {
    }

    private record Mount(Path root, Object fileKey) {
    }
}
