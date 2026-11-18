package com.alibaba.qwen.code.runtimebroker.provisioning.kubernetes;

import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentWorkspaceCatalog;
import com.alibaba.qwen.code.managedagent.repository.WorkspaceCsiReservations;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.KubernetesMaintenanceClient;
import com.alibaba.qwen.code.runtimebroker.spi.KubernetesRuntimeSupport;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import com.alibaba.qwen.code.runtimebroker.spi.WorkspaceCsiRuntimeSpec;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class KubernetesRuntimeProviderFactory implements RuntimeProviderFactory, KubernetesRuntimeSupport {
    @Override
    public Set<String> kinds() {
        return Set.of(WorkspaceCsiReservations.PROVISIONER_KIND);
    }

    @Override
    public void validate(ManagedAgentSettings settings) {
        var config = settings.getRuntimeBroker();
        new ResidentWorkspaceCatalog(config.getResidentWorkspaces());
        if (config.getResidentWorkspaces().isEmpty() || !"workspace".equals(config.getIsolationClass())
                || config.isTrustedLocalRebootRecovery() || config.isVerifiedWorkspaceRecoveryEnabled()
                || config.isChildWorkspacesEnabled() || !config.getWorkspaceMounts().isEmpty()
                || !config.getSsh().getNodes().isEmpty()
                || !settings.getHarness().isWorkspaceFilesEnabled() || settings.getHarness().isWorkspaceShellEnabled()
                || config.getResidentKubernetesApiUrl().isBlank() || config.getResidentKubernetesTokenFile().isBlank()
                || config.getResidentKubernetesCaFile().isBlank()) {
            throw new IllegalStateException("Resident Workspace requires exclusive CSI/files configuration");
        }
        URI origin = BrokerValues.requireOrigin(URI.create(config.getResidentKubernetesApiUrl()), "Kubernetes API origin");
        if (!"https".equals(origin.getScheme())) {
            throw new IllegalStateException("Kubernetes API must be an HTTPS origin");
        }
        Path.of(config.getResidentKubernetesTokenFile());
        Path.of(config.getResidentKubernetesCaFile());
    }

    @Override
    public RuntimeProvisioner create(ManagedAgentSettings settings, RuntimeTransport transport,
            RuntimeProviderDependencies dependencies) {
        validate(settings);
        return new ResidentWorkspaceProvisioner(settings, dependencies.csiReservations(), dependencies.bindings());
    }

    @Override
    public List<Check> preflight(ManagedAgentSettings settings) {
        var config = settings.getRuntimeBroker();
        return List.of(readable("kubernetes-token", config.getResidentKubernetesTokenFile()),
                readable("kubernetes-ca", config.getResidentKubernetesCaFile()));
    }

    private static Check readable(String name, String file) {
        return Files.isReadable(Path.of(file)) ? new Check(name, Status.PASS, file, null)
                : new Check(name, Status.FAIL, "Kubernetes credential file is not readable", "check " + name + " path and permissions");
    }

    @Override
    public KubernetesMaintenanceClient createClient(URI origin, Path tokenFile, Path caFile) {
        return new KubernetesHttpRuntimeClient(origin, tokenFile, caFile);
    }

    @Override
    public RuntimeProvisioner createWorkspaceRuntime(WorkspaceCsiRuntimeSpec spec, KubernetesMaintenanceClient client,
            WorkspaceCsiReservations reservations, RuntimeBindingRepository bindings) {
        var guard = new WorkspaceCsiResourceGuard(client, spec.clusterDomain(), spec.registration(), spec.protection());
        return new WorkspaceCsiRuntimeProvisioner(reservations, bindings, spec.registration(), client, guard,
                spec.image(), spec.command(), spec.startupTimeout(), spec.artifacts(), spec.authorityOrigin());
    }

    @Override
    public List<Map<String, Object>> protectionObjects(WorkspaceCsiRegistration registration,
            String policyName, String bindingName) {
        return List.of(WorkspaceCsiResourceGuard.policy(registration, policyName),
                WorkspaceCsiResourceGuard.binding(policyName, bindingName));
    }
}
