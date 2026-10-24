package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.util.List;

/** Private offline entry point; the native host observation is the stop authority. */
public final class WorkspaceMaintenanceRecoveryMain {
    private WorkspaceMaintenanceRecoveryMain() {
    }

    public static void main(String[] args) throws Exception {
        boolean inspect = args.length == 8 && "inspect".equals(args[0]);
        boolean reconcile = args.length == 10 && "reconcile".equals(args[0]) && "--trusted-reboot-confirmed".equals(args[9]);
        if (!inspect && !reconcile) {
            throw new IllegalArgumentException("Usage: inspect <tenant> <workspace> <workspace-generation> <storage> <canonical-root>"
                    + " <maintenance-id> <maintenance-generation> | reconcile <same arguments> <original-step-id> --trusted-reboot-confirmed");
        }
        var source = new DriverManagerDataSource(required("W1_JDBC_URL"), required("W1_JDBC_USER"), required("W1_JDBC_PASSWORD"));
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(new WorkspaceMount(args[1], args[4], args[5])));
        var guard = reconcile ? new WorkspaceStorageGuard(jdbc, manager, properties) : null;
        var recovery = new WorkspaceMaintenanceRecovery(jdbc, manager, guard);
        var binding = new ContextBinding(args[1], args[2], Long.parseLong(args[3]), args[4], ".",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        var result = inspect ? recovery.inspect(binding, args[6], Long.parseLong(args[7]))
                : recovery.reconcileAfterReboot(binding, args[6], Long.parseLong(args[7]), args[8]);
        System.out.println(new ObjectMapper().writeValueAsString(result));
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || (!"W1_JDBC_PASSWORD".equals(name) && value.isBlank())) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }
}
