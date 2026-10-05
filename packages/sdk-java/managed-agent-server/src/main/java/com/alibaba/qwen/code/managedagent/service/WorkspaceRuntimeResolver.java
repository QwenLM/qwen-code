package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceRelativePath;
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
     * change exactly what a later acquisition would prove for it — the
     * administrator mount mapping and continuity, the storage guard when
     * enabled against the *candidate* binding, and the directory rule
     * {@code acquire()} enforces including its readability checks — without
     * claiming storage or contacting a worker. Read-only and idempotent.
     * Verifying the candidate instead of the current binding keeps a
     * change *away from* a destroyed directory reachable, the escape this
     * feature exists for.
     */
    void verifyInstallable(ContextBinding binding, String targetCwdRelative) {
        Mount mount = mounts.get(new Storage(binding.getTenantId(), binding.getStorageId()));
        if (mount == null) {
            throw WorkspaceExecutionStore.unavailable();
        }
        verifyMountIntactForProbe(mount);
        requireDirectoryForProbe(mount.root().toString(), targetCwdRelative);
        try {
            authority.verifyMountForProbe(new ContextBinding(
                    binding.getTenantId(),
                    binding.getWorkspaceId(),
                    binding.getWorkspaceGeneration(),
                    binding.getStorageId(),
                    WorkspaceRelativePath.normalize(targetCwdRelative),
                    binding.getContextConfigRef(),
                    binding.getContextRevision()));
        } catch (com.alibaba.qwen.code.runtimebroker.managedworkspace
                .WorkspaceException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    // The acquire-path mount check: every I/O anomaly is the terminal
    // verdict it has always been — only the settlement probe below is
    // allowed to classify a momentary fault as retryable.
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

    private static void verifyMountIntactForProbe(Mount mount) {
        try {
            if (!mount.root().equals(mount.root().toRealPath())
                    || !Objects.equals(mount.fileKey(), Files.readAttributes(
                            mount.root(), BasicFileAttributes.class).fileKey())) {
                throw WorkspaceExecutionStore.unavailable();
            }
        // The mount root itself being gone is a permanent configuration
        // fact, not a momentary blip — only a genuine I/O hiccup retries.
        } catch (java.nio.file.NoSuchFileException error) {
            throw WorkspaceExecutionStore.unavailable();
        } catch (IOException error) {
            throw WorkspaceExecutionStore.unavailableTransient(error);
        }
    }

    // The acquire-path directory rule: the shape the tool-turn path has
    // always had — refusal predicates, every I/O anomaly terminal. The
    // remarketing of a momentary fault as retryable exists only for the
    // settlement probe, whose caller is prepared to re-arm a budgeted
    // retry; the acquire path fails the Turn immediately with the
    // accurate code instead (an ENOTDIR-shaped cwd must not surface as
    // hosted_harness_unavailable or park the binding RECOVERY_BLOCKED).
    static void requireDirectory(String root, String cwdRelative) {
        try {
            Path base = Path.of(root);
            Path directory = base.resolve(cwdRelative).normalize();
            if (!directory.startsWith(base)
                    || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)
                    || !directory.toRealPath().equals(directory)
                    || !Files.isReadable(directory)
                    || !Files.isExecutable(directory)) {
                throw WorkspaceExecutionStore.unavailable();
            }
        // The missing-directory shape (NoSuchFileException) and every
        // other I/O anomaly share the terminal verdict.
        } catch (IOException | IllegalArgumentException
                | SecurityException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    // The probe twin: throwing calls (not the false-on-error predicates),
    // so each failure shape reaches the catch arms, whose classifier works
    // by the verdict: a vanished target, a permission denial, and ENOTDIR
    // or ELOOP structural shapes are terminal, only opaque blips retry.
    // ENOTDIR/ELOOP surface as bare FileSystemException on some JDKs — no
    // subclass to catch — so the residual arm walks the ancestor chain
    // instead: a regular file or a dangling/looping symlink in the chain
    // is structural, whatever is left (ESTALE/EIO, ENAMETOOLONG) is
    // momentary and retries through the budget.
    static void requireDirectoryForProbe(String root, String cwdRelative) {
        Path base = Path.of(root);
        Path directory = base.resolve(cwdRelative).normalize();
        try {
            if (!directory.startsWith(base)
                    || !Files.readAttributes(directory,
                            BasicFileAttributes.class,
                            LinkOption.NOFOLLOW_LINKS).isDirectory()
                    || !directory.toRealPath().equals(directory)) {
                throw WorkspaceExecutionStore.unavailable();
            }
            directory.getFileSystem().provider().checkAccess(directory,
                    java.nio.file.AccessMode.READ,
                    java.nio.file.AccessMode.EXECUTE);
        } catch (java.nio.file.NoSuchFileException
                | java.nio.file.AccessDeniedException | SecurityException
                | IllegalArgumentException error) {
            throw WorkspaceExecutionStore.unavailable();
        } catch (IOException error) {
            throw hasStructuralAncestor(base, directory)
                    ? WorkspaceExecutionStore.unavailable()
                    : WorkspaceExecutionStore.unavailableTransient(error);
        }
    }

    private static boolean hasStructuralAncestor(Path base, Path directory) {
        for (Path cursor = directory; cursor != null && !cursor.equals(base);
                cursor = cursor.getParent()) {
            if (Files.isRegularFile(cursor, LinkOption.NOFOLLOW_LINKS)) {
                return true;
            }
            if (Files.isSymbolicLink(cursor)) {
                try {
                    cursor.toRealPath();
                } catch (IOException | RuntimeException error) {
                    return true;
                }
            }
        }
        return false;
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
