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
import java.nio.file.FileSystems;
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
        return List.of(stateDirectoryCheck(broker),
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

    private static void requireRecoveryDirectoryOutsideWorkspaces(ManagedAgentSettings.RuntimeBroker broker,
            Path directory) {
        try {
            if (recoveryDirectoryUnderWorkspaceRoot(broker, directory)) {
                throw new IllegalStateException(recoveryDirectoryOutsideRootsMessage());
            }
        } catch (IOException error) {
            throw new IllegalStateException("Runtime recovery directory could not be verified", error);
        }
    }

    private static boolean recoveryDirectoryUnderWorkspaceRoot(ManagedAgentSettings.RuntimeBroker broker,
            Path directory) throws IOException {
        Path candidate = Files.exists(directory) ? directory.toRealPath()
                : directory.getParent().toRealPath().resolve(directory.getFileName());
        // A blank `workspace-cwd` means "no Workspace cwd configured", as it
        // does in ManagedAgentPreflight; `Path.of("")` would otherwise resolve
        // to this process's own directory and make the verdict caller-cwd
        // dependent.
        if (!StringUtils.isBlank(broker.getWorkspaceCwd())
                && candidate.startsWith(Path.of(broker.getWorkspaceCwd()).toRealPath())) {
            return true;
        }
        if (!broker.getWorkspaceCreationRoot().isBlank()
                && candidate.startsWith(Path.of(broker.getWorkspaceCreationRoot()).toRealPath())) {
            return true;
        }
        for (var mount : broker.getWorkspaceMounts()) {
            if (candidate.startsWith(Path.of(mount.root()).toRealPath())) {
                return true;
            }
        }
        return false;
    }

    private static String recoveryDirectoryOutsideRootsMessage() {
        return "Runtime recovery directory must be outside Workspace roots; set"
                + " QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY outside every configured Workspace"
                + " root, or opt out with QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS=false"
                + " and QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY=false";
    }

    private static Check stateDirectoryCheck(ManagedAgentSettings.RuntimeBroker broker) {
        String path = broker.getStateDirectory();
        if (StringUtils.isBlank(path)) {
            return new Check("broker-state", Status.FAIL, "not configured",
                    "set the directory");
        }
        Path directory = Path.of(path).toAbsolutePath().normalize();
        if (broker.isDurableLocalProcess()) {
            // `create()` refuses a durable state directory under any Workspace
            // root, so --check must not PASS or WARN a configuration whose
            // first start cannot succeed. An unresolvable path is reported by
            // the component checks below.
            try {
                if (recoveryDirectoryUnderWorkspaceRoot(broker, directory)) {
                    return new Check("broker-state", Status.FAIL,
                            path + " is inside a Workspace root",
                            recoveryDirectoryOutsideRootsMessage());
                }
            } catch (IOException ignored) {
                // resolution failure: the absent/existing checks name the cause
            }
        }
        if (Files.isDirectory(directory)) {
            if (!Files.isWritable(directory)) {
                return new Check("broker-state", Status.FAIL, path + " is not writable",
                        "grant write access to the service account");
            }
            return searchable(directory)
                    ? new Check("broker-state", Status.PASS, path, null)
                    : new Check("broker-state", Status.FAIL, path + " is not searchable",
                            "grant execute access to the service account");
        }
        if (Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) {
            return new Check("broker-state", Status.FAIL,
                    path + " exists but is not a directory",
                    "remove the file or link at " + path);
        }
        if (!broker.isDurableLocalProcess()) {
            // The ephemeral spawn creates the directory, so an idle broker is
            // healthy with it absent; only a component that prevents creation
            // is a hard failure.
            Path ancestor = directory.getParent();
            while (ancestor != null && !Files.exists(ancestor, LinkOption.NOFOLLOW_LINKS)) {
                ancestor = ancestor.getParent();
            }
            if (ancestor == null || !Files.isDirectory(ancestor)) {
                return new Check("broker-state", Status.FAIL,
                        (ancestor == null ? path : ancestor.toString()) + " is not a directory",
                        "replace it with a directory");
            }
            if (!Files.isWritable(ancestor)) {
                return new Check("broker-state", Status.FAIL,
                        ancestor + " is not writable",
                        "grant write access to the service account");
            }
            return searchable(ancestor)
                    ? new Check("broker-state", Status.WARN,
                            path + " (absent; created on the first Runtime spawn)",
                            "run --check as the Broker's service account to verify creation access")
                    : new Check("broker-state", Status.FAIL,
                            ancestor + " is not searchable",
                            "grant execute access to the service account");
        }
        // Durable mode creates the directory owner-private (0700) on its first
        // start, one level deep, and refuses a symlinked path.
        Path parent = directory.getParent();
        Path component = parent;
        while (component != null) {
            if (Files.isSymbolicLink(component)) {
                return new Check("broker-state", Status.FAIL,
                        component + " is a symlink",
                        "point the state directory at a real path");
            }
            component = component.getParent();
        }
        if (parent == null || !Files.isDirectory(parent)) {
            return new Check("broker-state", Status.FAIL,
                    (parent == null ? path : parent.toString()) + " is not a directory",
                    "replace it with a directory");
        }
        if (!Files.isReadable(parent)) {
            // `LocalRuntimeStore.syncDirectory` opens the parent for reading
            // right after it creates the state directory.
            return new Check("broker-state", Status.FAIL,
                    parent + " is not readable",
                    "grant read access to the service account");
        }
        if (!Files.isWritable(parent)) {
            return new Check("broker-state", Status.FAIL,
                    parent + " is not writable",
                    "grant write access to the service account");
        }
        return searchable(parent)
                ? new Check("broker-state", Status.WARN,
                        path + " (absent; created owner-private on the first start)",
                        "run --check as the Broker's service account to verify creation access")
                : new Check("broker-state", Status.FAIL,
                        parent + " is not searchable",
                        "grant execute access to the service account");
    }

    private static boolean searchable(Path directory) {
        return !FileSystems.getDefault().supportedFileAttributeViews().contains("posix")
                || Files.isExecutable(directory);
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
