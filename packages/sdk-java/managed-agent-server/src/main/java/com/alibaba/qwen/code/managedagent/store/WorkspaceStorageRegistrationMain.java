package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

public final class WorkspaceStorageRegistrationMain {
    private WorkspaceStorageRegistrationMain() {
    }

    public static void main(String[] args) {
        boolean register = args.length == 6 && "register".equals(args[0]);
        boolean inspect = args.length == 4 && "inspect".equals(args[0]);
        boolean transition = args.length == 7
                && ("fence".equals(args[0]) || "restore-original".equals(args[0]));
        if ((!register && !transition && !inspect)
                || (!inspect && !"--offline-confirmed".equals(args[args.length - 1]))) {
            throw new IllegalArgumentException("Usage: register <tenant> <storage> <canonical-root>"
                    + " <operation-uuid> --offline-confirmed |"
                    + " (fence|restore-original) <tenant> <storage> <canonical-root>"
                    + " <mount-revision> <operation-uuid> --offline-confirmed |"
                    + " inspect <tenant> <storage> <canonical-root>");
        }
        String url = System.getenv("W1_JDBC_URL");
        String user = System.getenv("W1_JDBC_USER");
        String password = System.getenv("W1_JDBC_PASSWORD");
        if (url == null || url.isBlank() || user == null || user.isBlank() || password == null) {
            throw new IllegalStateException("W1_JDBC_URL, W1_JDBC_USER and W1_JDBC_PASSWORD are required");
        }
        DriverManagerDataSource dataSource = new DriverManagerDataSource(url, user, password);
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new WorkspaceMount(args[1], args[2], args[3])));
        WorkspaceStorageGuard guard = new WorkspaceStorageGuard(new JdbcTemplate(dataSource),
                new DataSourceTransactionManager(dataSource), properties);
        if (inspect) {
            System.out.println(guard.inspect(args[1], args[2]));
        } else if (register) {
            guard.register(args[1], args[2], args[4]);
        } else if ("fence".equals(args[0])) {
            guard.fence(args[1], args[2], Long.parseLong(args[4]), args[5]);
        } else {
            guard.restoreOriginal(args[1], args[2], Long.parseLong(args[4]), args[5]);
        }
        if (!inspect) {
            System.out.println("Workspace storage maintenance operation verified.");
        }
    }
}
