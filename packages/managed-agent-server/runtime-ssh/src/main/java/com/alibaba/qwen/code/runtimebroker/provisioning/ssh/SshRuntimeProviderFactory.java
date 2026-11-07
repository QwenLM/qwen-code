package com.alibaba.qwen.code.runtimebroker.provisioning.ssh;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import com.alibaba.qwen.code.runtimebroker.spi.SshConnections;
import com.alibaba.qwen.code.runtimebroker.spi.SshRuntimeSupport;
import org.apache.commons.lang3.StringUtils;

import java.net.URI;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class SshRuntimeProviderFactory implements RuntimeProviderFactory, SshRuntimeSupport {
    @Override
    public Set<String> kinds() {
        return Set.of(RuntimeProviderKinds.SSH_PROCESS);
    }

    @Override
    public void validate(ManagedAgentSettings settings) {
        var broker = settings.getRuntimeBroker();
        boolean primary = RuntimeProviderKinds.SSH_PROCESS.equals(broker.getProvisioner());
        if (!primary && !RuntimeProviderKinds.LOCAL_PROCESS.equals(broker.getProvisioner())) {
            throw new IllegalStateException("SSH nodes require local-process or ssh-process provisioning");
        }
        if (!settings.getHarness().isWorkspaceFilesEnabled() || broker.getSsh().getNodes().isEmpty()) {
            throw new IllegalStateException("SSH Runtime requires Workspace files and configured nodes");
        }
        if (!"session".equals(broker.getIsolationClass()) || broker.isSessionCreateWarm()) {
            throw new IllegalStateException("SSH Runtime requires Session isolation without Session-create warm");
        }
        Set<String> nodeIds = new HashSet<>();
        for (var node : broker.getSsh().getNodes()) {
            if (!nodeIds.add(node.nodeId())) {
                throw new IllegalStateException("SSH node IDs must be unique");
            }
            node.runtimeNode();
            if (StringUtils.isBlank(node.qwenVersion())) {
                throw new IllegalStateException("SSH node requires a pinned qwenVersion");
            }
        }
        if (!broker.getResidentWorkspaces().isEmpty()) {
            throw new IllegalStateException("Resident Workspace and SSH nodes require separate Broker configurations");
        }
        if (primary && (!"session".equals(broker.getBoundSessionIsolationClass())
                || !broker.getWorkspaceMounts().isEmpty() || StringUtils.isNotBlank(broker.getWorkspaceCreationRoot())
                || broker.isLocalDirectoryImportEnabled() || broker.isTrustedLocalRebootRecovery()
                || broker.isVerifiedWorkspaceRecoveryEnabled() || broker.isOperatorRecoveryEnabled()
                || broker.isChildWorkspacesEnabled() || broker.isChildSnapshotsEnabled()
                || broker.isSessionWorktreesEnabled())) {
            throw new IllegalStateException("SSH-only Runtime requires Session isolation and no Local Workspace features");
        }
        if (settings.getManagedExtensions().isEnabled()) {
            String directory = settings.getManagedExtensions().getCacheDirectory();
            if (StringUtils.isBlank(directory) || !Path.of(directory).isAbsolute()) {
                throw new IllegalStateException("Extension cache must be absolute");
            }
        }
    }

    @Override
    public RuntimeProvisioner create(ManagedAgentSettings settings, RuntimeTransport transport,
            RuntimeProviderDependencies dependencies) {
        validate(settings);
        if (!(transport instanceof HttpRuntimeTransport http)) {
            throw new IllegalArgumentException("SSH Runtime requires the shared HTTP transport");
        }
        var access = dependencies.ssh();
        var provider = new SshRuntimeProvisioner(access::node, access::runtimeStorage, access.connections(), http);
        try {
            if (settings.getManagedExtensions().isEnabled()) {
                provider.withManagedExtensionCacheDirectory(settings.getManagedExtensions().getCacheDirectory(),
                        settings.getManagedExtensions().getCgroupRoot());
            }
            return provider;
        } catch (RuntimeException | Error failure) {
            provider.close();
            throw failure;
        }
    }

    @Override
    public SshConnections createConnections(URI publicationEndpoint) {
        return new SshConnectionManager(publicationEndpoint);
    }

    @Override
    public List<Check> preflight(ManagedAgentSettings settings) {
        validate(settings);
        return List.of(new Check("ssh-runtime", Status.PASS,
                "configured SSH nodes: " + settings.getRuntimeBroker().getSsh().getNodes().size(), null));
    }
}
