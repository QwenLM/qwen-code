package com.alibaba.qwen.code.runtimebroker.provisioning.local;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.OperatorRuntimeRecovery;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import org.apache.commons.lang3.StringUtils;

import java.io.IOException;
import java.nio.file.Files;
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
            com.alibaba.qwen.code.runtimebroker.host.RuntimeStateFiles.validateDirectory(stateDirectory);
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
        return List.of(directoryCheck("broker-state", broker.getStateDirectory()),
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
            Path candidate = java.nio.file.Files.exists(directory) ? directory.toRealPath()
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

    private static Check directoryCheck(String name, String path) {
        if (StringUtils.isBlank(path)) {
            return new Check(name, Status.FAIL, "not configured",
                    "set the directory");
        }
        Path directory = Path.of(path);
        if (!Files.isDirectory(directory)) {
            return new Check(name, Status.FAIL,
                    path + " is not a directory", "create it");
        }
        if (!Files.isWritable(directory)) {
            return new Check(name, Status.FAIL, path + " is not writable",
                    "grant write access to the service account");
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
