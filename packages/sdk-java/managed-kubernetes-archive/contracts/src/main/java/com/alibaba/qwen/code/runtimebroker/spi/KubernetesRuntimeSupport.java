package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.repository.WorkspaceCsiReservations;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;

import java.net.URI;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

public interface KubernetesRuntimeSupport {
    public KubernetesMaintenanceClient createClient(URI origin, Path tokenFile, Path caFile);

    public RuntimeProvisioner createWorkspaceRuntime(WorkspaceCsiRuntimeSpec spec,
            KubernetesMaintenanceClient client, WorkspaceCsiReservations reservations,
            RuntimeBindingRepository bindings);

    public List<Map<String, Object>> protectionObjects(WorkspaceCsiRegistration registration,
            String policyName, String bindingName);
}
