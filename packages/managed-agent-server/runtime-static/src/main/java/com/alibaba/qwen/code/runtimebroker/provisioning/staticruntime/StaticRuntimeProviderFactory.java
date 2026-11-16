package com.alibaba.qwen.code.runtimebroker.provisioning.staticruntime;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import org.apache.commons.lang3.StringUtils;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;

public final class StaticRuntimeProviderFactory implements RuntimeProviderFactory {
    @Override
    public Set<String> kinds() {
        return Set.of("static");
    }

    @Override
    public void validate(ManagedAgentSettings settings) {
        var broker = settings.getRuntimeBroker();
        if (!"workspace".equals(broker.getIsolationClass())) {
            throw new IllegalStateException("Static Runtime requires workspace isolation");
        }
        if (broker.isTrustedLocalRebootRecovery()) {
            throw new IllegalStateException("Static Runtime requires trusted-local-reboot-recovery=false");
        }
        lease(broker);
    }

    @Override
    public RuntimeProvisioner create(ManagedAgentSettings settings, RuntimeTransport transport,
            RuntimeProviderDependencies dependencies) {
        validate(settings);
        return new StaticRuntimeProvisioner(lease(settings.getRuntimeBroker()));
    }

    @Override
    public boolean usesLocalWorkspace() {
        return true;
    }

    @Override
    public List<Check> preflight(ManagedAgentSettings settings) {
        String configured = settings.getRuntimeBroker().getStateDirectory();
        if (StringUtils.isBlank(configured)) {
            return List.of(new Check("broker-state", Status.FAIL, "not configured", "set the directory"));
        }
        Path directory = Path.of(configured);
        if (!Files.isDirectory(directory)) {
            return List.of(new Check("broker-state", Status.FAIL,
                    configured + " is not a directory", "create it"));
        }
        if (!Files.isWritable(directory)) {
            return List.of(new Check("broker-state", Status.FAIL, configured + " is not writable",
                    "grant write access to the service account"));
        }
        return List.of(new Check("broker-state", Status.PASS, configured, null));
    }

    private static RuntimeLease lease(ManagedAgentSettings.RuntimeBroker broker) {
        if (StringUtils.isBlank(broker.getStaticEndpoint())) {
            throw new IllegalStateException("Static Runtime endpoint is required");
        }
        if (StringUtils.isBlank(broker.getStaticToken())) {
            throw new IllegalStateException("Static Runtime token is required");
        }
        return new RuntimeLease(broker.getStaticRuntimeInstanceId(), URI.create(broker.getStaticEndpoint()),
                broker.getStaticToken(), broker.getStaticLeaseId(), broker.getStaticEpoch());
    }
}
