package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService;
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

public final class WorkspaceRuntimeResolver {
    private final AgentStateStore sessions;
    private final WorkspaceExecutionStore authority;
    private final SshWorkspaceService ssh;
    private final com.alibaba.qwen.code.runtimebroker.provisioning.ExternalStorageRegistry externalRegistrations;
    private final com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentWorkspaceCatalog residents;
    private final Map<Storage, Mount> mounts = new LinkedHashMap<>();
    private final String boundSessionIsolationClass;
    private final ManagedAgentSettings.ManagedExtensions managedExtensions;

    public WorkspaceRuntimeResolver(AgentStateStore sessions, WorkspaceExecutionStore authority,
            ManagedAgentSettings properties) {
        this(sessions, authority, properties, null);
    }

    public WorkspaceRuntimeResolver(AgentStateStore sessions, WorkspaceExecutionStore authority,
            ManagedAgentSettings properties, SshWorkspaceService ssh) {
        this(sessions, authority, properties, ssh, null);
    }

    public WorkspaceRuntimeResolver(AgentStateStore sessions, WorkspaceExecutionStore authority,
            ManagedAgentSettings properties, SshWorkspaceService ssh,
            com.alibaba.qwen.code.runtimebroker.provisioning.ExternalStorageRegistry externalRegistrations) {
        this.ssh = ssh;
        this.externalRegistrations = externalRegistrations;
        this.managedExtensions = properties.getManagedExtensions();
        if (managedExtensions.isEnabled() && !properties.getExtensions().isEnabled()) {
            throw new IllegalStateException("Managed extension execution requires extensions to be enabled");
        }
        this.sessions = sessions;
        this.authority = authority;
        var broker = properties.getRuntimeBroker();
        this.boundSessionIsolationClass = broker.getBoundSessionIsolationClass();
        this.residents = new com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentWorkspaceCatalog(broker.getResidentWorkspaces());
        if (WorkspaceExecutionProfile.CAPABILITY_DIGEST.equals(
                properties.getHarness().getCapabilityDigest())
                || com.alibaba.qwen.code.runtimebroker.ResidentWorkspaceProfile.CAPABILITY_DIGEST.equals(
                        properties.getHarness().getCapabilityDigest())) {
            throw new IllegalStateException("Workspace execution profile is reserved");
        }
        if (!broker.getWorkspaceMounts().isEmpty()
                && (!com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.LOCAL_PROCESS.equals(broker.getProvisioner())
                        || !"session".equals(boundSessionIsolationClass)
                                && !"workspace".equals(boundSessionIsolationClass))) {
            throw new IllegalStateException("Workspace execution requires a local-process Broker"
                    + " with session or workspace bound-Session isolation");
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

    public Resolved resolve(String sessionId) {
        return resolve(sessionId, null);
    }

    public Resolved resolve(String sessionId, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority lifecycle) {
        return resolve(sessionId, lifecycle, false);
    }

    public Resolved resolveHook(String sessionId, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority lifecycle) {
        return resolve(sessionId, lifecycle, true);
    }

    private Resolved resolve(String sessionId, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority lifecycle, boolean hook) {
        SessionRecord session = sessions.findSessionById(sessionId)
                .orElseThrow(WorkspaceExecutionStore::unavailable);
        if (authority.isExternal(session.workspace())) {
            if (hook || managedExtensions.isEnabled() || externalRegistrations == null
                    || !"session".equals(boundSessionIsolationClass)) {
                throw WorkspaceExecutionStore.unavailable();
            }
            authority.authorizeExternal(session, lifecycle);
            ContextBinding saved = session.workspace();
            var registered = externalRegistrations.find(session.tenantId(), saved.getStorageId())
                    .orElseThrow(WorkspaceExecutionStore::unavailable);
            if (!saved.getWorkspaceId().equals(registered.tenantWorkspaceId())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            return new Resolved(saved, new RuntimeScope(session.tenantId(), saved.getWorkspaceId(),
                    Long.toString(saved.getWorkspaceGeneration()), registered.mountRoot(),
                    WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session").withLifecycleAuthority(lifecycle));
        }
        if (lifecycle == null && hook && "CLOSING".equals(session.status())) {
            authority.authorizeLegacyClose(session);
        } else if (lifecycle == null) {
            authority.authorize(session);
        } else {
            authority.authorizeLifecycle(session, lifecycle);
        }
        ContextBinding binding = session.workspace();
        if (ssh != null && ssh.runtimeStorage(binding) != null) {
            if (hook && !managedExtensions.isEnabled()) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            ssh.verifyBinding(binding);
            return new Resolved(binding, new RuntimeScope(session.tenantId(), binding.getWorkspaceId(),
                    Long.toString(binding.getWorkspaceGeneration()), ssh.runtimeStorage(binding).mountRoot(),
                    extensionDigest(String.valueOf(ssh.runtimeStorage(binding).registration().get("platform"))), "session").withLifecycleAuthority(lifecycle));
        }
        var resident = residents.find(binding);
        if (resident != null) {
            return new Resolved(binding, com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentWorkspaceCatalog.scope(resident)
                    .withLifecycleAuthority(lifecycle));
        }
        Mount mount = mount(binding);
        if (mount == null) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        verifyMountIntact(mount);
        return new Resolved(binding, new RuntimeScope(session.tenantId(), binding.getWorkspaceId(),
                Long.toString(binding.getWorkspaceGeneration()), mount.root().toString(),
                extensionDigest(System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("mac") ? "darwin" : System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT)), boundSessionIsolationClass).withLifecycleAuthority(lifecycle));
    }

    private String extensionDigest(String platform) {
        if (!managedExtensions.isEnabled()) {
            return WorkspaceExecutionProfile.CAPABILITY_DIGEST;
        }
        if ("linux".equals(platform)) {
            return com.alibaba.qwen.code.runtimebroker.ManagedExtensionExecutionProfile.LINUX_CAPABILITY_DIGEST;
        }
        if ("darwin".equals(platform) && "developer-process-group".equals(managedExtensions.getMode())) {
            return com.alibaba.qwen.code.runtimebroker.ManagedExtensionExecutionProfile.DEVELOPER_CAPABILITY_DIGEST;
        }
        throw new IllegalStateException("Native extension execution requires an explicit supported platform mode");
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
    public void verifyInstallable(ContextBinding binding, String targetCwdRelative) {
        if (ssh != null && ssh.runtimeStorage(binding) != null) {
            ssh.verify(new ContextBinding(binding.getTenantId(), binding.getWorkspaceId(),
                    binding.getWorkspaceGeneration(), binding.getStorageId(), WorkspaceRelativePath.normalize(targetCwdRelative),
                    binding.getContextConfigRef(), binding.getContextRevision()));
            return;
        }
        Mount mount = mount(binding);
        if (mount == null) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
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
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
    }

    /**
     * The child Workspace provider's storage root (#13753 I1): the
     * administrator mount of the binding's storage, held to the same
     * continuity check as an acquisition.
     */
    public java.nio.file.Path storageRoot(ContextBinding binding) {
        Mount mount = mount(binding);
        if (mount == null) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        verifyMountIntact(mount);
        return mount.root();
    }

    /**
     * The verified-recovery check for a shared (Workspace-isolated) request:
     * the mount for the storage must still resolve to the request's root and
     * stay intact. A shared binding has no owning Session to resolve by.
     */
    public void requireMountCurrent(RuntimeScope scope, String storageId) {
        Mount mount = mounts.get(new Storage(scope.getTenantId(), storageId));
        if (mount == null) {
            Path root = authority.createdStorageRoot(scope.getTenantId(), storageId);
            if (root == null) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            try {
                mount = new Mount(root, Files.readAttributes(root, BasicFileAttributes.class).fileKey());
            } catch (IOException error) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable(error);
            }
        }
        if (!mount.root().toString().equals(scope.getCanonicalCwd())) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        verifyMountIntact(mount);
    }

    private Mount mount(ContextBinding binding) {
        if (authority.isExternal(binding)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        Mount configured = mounts.get(new Storage(binding.getTenantId(), binding.getStorageId()));
        if (configured != null) {
            return configured;
        }
        Path root = authority.createdStorageRoot(binding.getTenantId(), binding.getStorageId());
        if (root == null) {
            return null;
        }
        try {
            return new Mount(root, Files.readAttributes(root, BasicFileAttributes.class).fileKey());
        } catch (IOException error) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable(error);
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
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
        } catch (IOException error) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
    }

    private static void verifyMountIntactForProbe(Mount mount) {
        try {
            if (!mount.root().equals(mount.root().toRealPath())
                    || !Objects.equals(mount.fileKey(), Files.readAttributes(
                            mount.root(), BasicFileAttributes.class).fileKey())) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
        // The mount root itself being gone is a permanent configuration
        // fact, not a momentary blip — only a genuine I/O hiccup retries.
        } catch (java.nio.file.NoSuchFileException error) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        } catch (IOException error) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailableTransient(error);
        }
    }

    // The acquire-path directory rule: the shape the tool-turn path has
    // always had — refusal predicates, every I/O anomaly terminal. The
    // remarketing of a momentary fault as retryable exists only for the
    // settlement probe, whose caller is prepared to re-arm a budgeted
    // retry; the acquire path fails the Turn immediately with the
    // accurate code instead (an ENOTDIR-shaped cwd must not surface as
    // hosted_harness_unavailable or park the binding RECOVERY_BLOCKED).
    public static void requireDirectory(String root, String cwdRelative) {
        try {
            Path base = Path.of(root);
            Path directory = base.resolve(cwdRelative).normalize();
            if (!directory.startsWith(base)
                    || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)
                    || !directory.toRealPath().equals(directory)
                    || !Files.isReadable(directory)
                    || !Files.isExecutable(directory)) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
        // The missing-directory shape (NoSuchFileException) and every
        // other I/O anomaly share the terminal verdict.
        } catch (IOException | IllegalArgumentException
                | SecurityException error) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
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
    public static void requireDirectoryForProbe(String root, String cwdRelative) {
        Path base = Path.of(root);
        Path directory = base.resolve(cwdRelative).normalize();
        try {
            if (!directory.startsWith(base)
                    || !Files.readAttributes(directory,
                            BasicFileAttributes.class,
                            LinkOption.NOFOLLOW_LINKS).isDirectory()
                    || !directory.toRealPath().equals(directory)) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            directory.getFileSystem().provider().checkAccess(directory,
                    java.nio.file.AccessMode.READ,
                    java.nio.file.AccessMode.EXECUTE);
        } catch (java.nio.file.NoSuchFileException
                | java.nio.file.AccessDeniedException | SecurityException
                | IllegalArgumentException error) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        } catch (IOException error) {
            throw hasStructuralAncestor(base, directory)
                    ? com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable()
                    : com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailableTransient(error);
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

    public ContextBinding savedBinding(String sessionId) {
        return sessions.findSessionById(sessionId).map(SessionRecord::workspace)
                .orElseThrow(com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore::unavailable);
    }

    public record Resolved(ContextBinding binding, RuntimeScope scope) {
    }

    private record Storage(String tenantId, String storageId) {
    }

    private record Mount(Path root, Object fileKey) {
    }
}
