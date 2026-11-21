package com.alibaba.qwen.code.runtimebroker.provisioning.local;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.host.RuntimeStateFiles;
import com.alibaba.qwen.code.runtimebroker.spi.OperatorRuntimeRecovery;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import org.apache.commons.lang3.StringUtils;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;

public final class LocalRuntimeProviderFactory implements RuntimeProviderFactory {
    @Override
    public Set<String> kinds() {
        return Set.of(LocalProcessRuntimeProvisioner.KIND);
    }

    @Override
    public void validate(ManagedAgentSettings settings) {
        var broker = settings.getRuntimeBroker();
        require(broker.getStateDirectory(), "Runtime Broker state directory");
        require(broker.getNodeExecutable(), "Node.js executable");
        require(broker.getWorkerEntry(), "Runtime worker entry");
        if (!broker.getEnvironment().isEmpty()) {
            throw new IllegalStateException("Merged local Runtime provisioner does not accept extra environment");
        }
        if (settings.getManagedExtensions().isEnabled()) {
            String directory = settings.getManagedExtensions().getCacheDirectory();
            if (directory == null || !Path.of(directory).isAbsolute()) {
                throw new IllegalArgumentException("Extension cache must be absolute");
            }
        }
    }

    @Override
    public RuntimeProvisioner create(ManagedAgentSettings settings, RuntimeTransport transport,
            RuntimeProviderDependencies dependencies) {
        validate(settings);
        var broker = settings.getRuntimeBroker();
        List<String> command = List.of(Path.of(broker.getNodeExecutable()).toAbsolutePath().toString(),
                Path.of(broker.getWorkerEntry()).toAbsolutePath().toString(), "managed-runtime-worker");
        Path stateDirectory = Path.of(broker.getStateDirectory()).toAbsolutePath().normalize();
        if (broker.isDurableLocalProcess()) {
            requireRecoveryDirectoryOutsideWorkspaces(broker, stateDirectory);
        } else if (!canCreateDirectory(stateDirectory)) {
            // Refuse at wiring time, without creating anything, so a state
            // path that can never hold the directory is diagnosed here with
            // its path instead of at every later provision.
            throw new IllegalStateException(
                    "Runtime Broker state directory is unavailable: " + stateDirectory);
        }
        LocalProcessRuntimeProvisioner provider = broker.isDurableLocalProcess()
                ? LocalProcessRuntimeProvisioner.durable(command, stateDirectory, http(transport),
                        broker.isTrustedLocalRebootRecovery())
                : new LocalProcessRuntimeProvisioner(command, stateDirectory, http(transport));
        try {
            if (settings.getManagedExtensions().isEnabled()) {
                provider.withManagedExtensionCacheDirectory(settings.getManagedExtensions().getCacheDirectory(),
                        settings.getManagedExtensions().getCgroupRoot());
            }
            return provider;
        } catch (RuntimeException | Error error) {
            provider.close();
            throw error;
        }
    }

    @Override
    public OperatorRuntimeRecovery createForMaintenance(ManagedAgentSettings.RuntimeBroker settings,
            RuntimeTransport transport) {
        if (!settings.isDurableLocalProcess() || !kinds().contains(settings.getProvisioner())) {
            throw new IllegalStateException("Offline recovery requires durable local-process provisioning");
        }
        Path stateDirectory = Path.of(settings.getStateDirectory()).toAbsolutePath().normalize();
        try {
            RuntimeStateFiles.validateDirectory(stateDirectory);
        } catch (IOException error) {
            throw new IllegalStateException("Original Runtime state directory is unavailable", error);
        }
        return LocalProcessRuntimeProvisioner.durable(List.of("maintenance-never-starts-worker"),
                stateDirectory, http(transport),
                settings.isTrustedLocalRebootRecovery());
    }

    @Override
    public boolean usesLocalWorkspace() {
        return true;
    }

    @Override
    public List<Check> preflight(ManagedAgentSettings settings) {
        var broker = settings.getRuntimeBroker();
        return List.of(directoryCheck("broker-state", broker.getStateDirectory(),
                        broker.isDurableLocalProcess(), broker),
                executableCheck("node", broker.getNodeExecutable()),
                readableCheck("worker-entry", broker.getWorkerEntry()));
    }

    private static HttpRuntimeTransport http(RuntimeTransport transport) {
        if (transport instanceof HttpRuntimeTransport http) {
            return http;
        }
        throw new IllegalArgumentException("Local Runtime requires the shared HTTP transport");
    }

    private static void require(String value, String name) {
        if (StringUtils.isBlank(value)) {
            throw new IllegalStateException(name + " is required");
        }
    }

    private static boolean canCreateDirectory(Path directory) {
        Path existing = directory.toAbsolutePath().normalize();
        // NOFOLLOW_LINKS: a dangling symlink is not an absent path —
        // createDirectories can never create through it. Creating a child
        // needs write and search on the nearest existing ancestor.
        while (existing != null && !Files.exists(existing, LinkOption.NOFOLLOW_LINKS)) {
            existing = existing.getParent();
        }
        return existing != null && Files.isDirectory(existing)
                && Files.isWritable(existing) && Files.isExecutable(existing);
    }

    private static void requireRecoveryDirectoryOutsideWorkspaces(ManagedAgentSettings.RuntimeBroker broker,
            Path directory) {
        try {
            Path candidate = Files.exists(directory) ? directory.toRealPath()
                    : directory.getParent().toRealPath().resolve(directory.getFileName());
            if (candidate.startsWith(Path.of(broker.getWorkspaceCwd()).toRealPath())) {
                throw new IllegalStateException(recoveryDirectoryOutsideRootsMessage());
            }
            if (!broker.getWorkspaceCreationRoot().isBlank()
                    && candidate.startsWith(Path.of(broker.getWorkspaceCreationRoot()).toRealPath())) {
                throw new IllegalStateException(recoveryDirectoryOutsideRootsMessage());
            }
            for (var mount : broker.getWorkspaceMounts()) {
                if (candidate.startsWith(Path.of(mount.root()).toRealPath())) {
                    throw new IllegalStateException(recoveryDirectoryOutsideRootsMessage());
                }
            }
        } catch (IOException error) {
            throw new IllegalStateException("Runtime recovery directory could not be verified", error);
        }
    }

    private static String recoveryDirectoryOutsideRootsMessage() {
        return "Runtime recovery directory must be outside Workspace roots; set"
                + " QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY outside every configured Workspace"
                + " root, or opt out with QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS=false"
                + " and QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY=false";
    }

    private static Check directoryCheck(String name, String path, boolean durable,
            ManagedAgentSettings.RuntimeBroker broker) {
        if (StringUtils.isBlank(path)) {
            return new Check(name, Status.FAIL, "not configured",
                    "set the directory");
        }
        Path directory = Path.of(path);
        if (durable) {
            // Delegate to the same checks create() runs instead of re-deriving
            // them: the store validates an existing directory itself, and both
            // shapes must lie outside the Workspace roots.
            Path absolute = directory.toAbsolutePath().normalize();
            if (Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) {
                try {
                    requireRecoveryDirectoryOutsideWorkspaces(broker, absolute);
                    // Validate the absolute path create() uses: the canonical
                    // check compares against toRealPath(), which is absolute.
                    RuntimeStateFiles.validateDirectory(absolute);
                } catch (IOException | RuntimeException error) {
                    return new Check(name, Status.FAIL,
                            path + " is not a valid durable state directory: " + error.getMessage(),
                            "use a canonical, owner-private rwx------ directory outside the"
                                    + " Workspace roots");
                }
                return new Check(name, Status.PASS, path, null);
            }
            // The store refuses a symlinked recovery path and creates the leaf
            // single-level, then fsyncs the parent for READ: the parent must
            // already exist, be readable, writable and searchable, and the
            // path must be symlink-free.
            for (Path current = absolute; current != null; current = current.getParent()) {
                if (Files.isSymbolicLink(current)) {
                    return new Check(name, Status.FAIL, path + " is under a symbolic link",
                            "point the state directory at a canonical path; the durable store"
                                    + " refuses a symlinked recovery path");
                }
            }
            Path parent = absolute.getParent();
            if (parent == null || !Files.isDirectory(parent)
                    || !Files.isReadable(parent) || !Files.isWritable(parent)
                    || !Files.isExecutable(parent)) {
                return new Check(name, Status.FAIL, path + " cannot be created",
                        "ensure the parent directory " + parent
                                + " exists and is readable, writable and searchable");
            }
            try {
                requireRecoveryDirectoryOutsideWorkspaces(broker, absolute);
            } catch (RuntimeException error) {
                return new Check(name, Status.FAIL, path + " " + error.getMessage(), null);
            }
            return new Check(name, Status.WARN,
                    path + " does not exist yet; created during Broker wiring", null);
        }
        if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) {
            // The ephemeral provisioner creates the state directory at first
            // spawn, so an absent but creatable path no longer refuses the
            // deployment.
            if (canCreateDirectory(directory)) {
                return new Check(name, Status.WARN,
                        path + " does not exist yet; created at first Runtime spawn", null);
            }
            return new Check(name, Status.FAIL,
                    path + " cannot be created", "create it or fix the parent directory permissions");
        }
        if (!Files.isDirectory(directory)) {
            return new Check(name, Status.FAIL,
                    path + " is not a directory", "create it");
        }
        if (!Files.isWritable(directory) || !Files.isExecutable(directory)) {
            return new Check(name, Status.FAIL, path + " is not writable and searchable",
                    "grant write and search access to the service account");
        }
        return new Check(name, Status.PASS, path, null);
    }

    private static Check executableCheck(String name, String path) {
        if (StringUtils.isBlank(path)) {
            return new Check(name, Status.FAIL, "not configured",
                    "set the executable path");
        }
        return Files.isExecutable(Path.of(path))
                ? new Check(name, Status.PASS, path, null)
                : new Check(name, Status.FAIL, path + " is not executable",
                        "install the executable or fix its path");
    }

    private static Check readableCheck(String name, String path) {
        if (StringUtils.isBlank(path)) {
            return new Check(name, Status.FAIL, "not configured",
                    "set the worker entry path");
        }
        return Files.isReadable(Path.of(path))
                ? new Check(name, Status.PASS, path, null)
                : new Check(name, Status.FAIL, path + " is not readable",
                        "install the Qwen Code CLI or fix its path");
    }
}
