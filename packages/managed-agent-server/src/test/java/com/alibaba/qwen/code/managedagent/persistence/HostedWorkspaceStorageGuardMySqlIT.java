package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@EnabledOnOs(OS.LINUX)
class HostedWorkspaceStorageGuardMySqlIT {
    @TempDir
    Path temporary;

    @Test
    @Timeout(60)
    void linuxRegistrationSurvivesProcessRestartAndMysqlClientsSerializeMaintenance() throws Exception {
        String url = System.getProperty("mysql.url");
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        assertThat(url).startsWith("jdbc:mysql:");
        assertThat(user).isNotBlank();
        var dataSource = new DriverManagerDataSource(url, user, password);
        var jdbc = new ManagedSchemaJdbcTemplate(dataSource);
        assertThat(jdbc.queryForObject("SELECT @@version", String.class)).startsWith("8.4.").doesNotContainIgnoringCase("MariaDB");
        ManagedSchema.initialize(dataSource);
        Path root = Files.createDirectory(temporary.resolve("root")).toRealPath();
        Files.createDirectory(root.resolve("child"));
        // Keep initialized-root mtime distinct from birth time without relying on sleeps.
        Files.setLastModifiedTime(root, FileTime.fromMillis(1));
        String tenant = "w1-" + UUID.randomUUID();
        String storage = "storage-" + UUID.randomUUID();
        var properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(new WorkspaceMount(tenant, storage, root.toString())));
        var binding = new ContextBinding(tenant, "workspace", 1, storage, "child", "config", 1);
        var guard = new WorkspaceStorageGuard(jdbc, new DataSourceTransactionManager(dataSource), properties);
        String registration = UUID.randomUUID().toString();
        try {
            assertUnavailable(() -> guard.verify(binding));
            maintenance(url, user, password, "register", tenant, storage, root.toString(), registration,
                    "--offline-confirmed");
            var original = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner WHERE tenant_id = ? AND storage_id = ?", tenant, storage);
            guard.verify(binding);
            assertThat(original.get("mount_birth_time")).isEqualTo(Files.readAttributes(root,
                    java.nio.file.attribute.BasicFileAttributes.class).creationTime().toInstant().toString());
            assertThat(original.get("mount_host_id")).isNotEqualTo(Files.readString(Path.of("/etc/machine-id")).strip());
            maintenance(url, user, password, "register", tenant, storage, root.toString(), registration,
                    "--offline-confirmed");
            assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner WHERE tenant_id = ? AND storage_id = ?", tenant, storage)).isEqualTo(original);
            String operation = UUID.randomUUID().toString();
            try (var executor = Executors.newFixedThreadPool(2)) {
                var first = executor.submit(() -> guard.fence(tenant, storage, 1, operation));
                var otherSource = new DriverManagerDataSource(url, user, password);
                var other = new WorkspaceStorageGuard(new ManagedSchemaJdbcTemplate(otherSource),
                        new DataSourceTransactionManager(otherSource), properties);
                var second = executor.submit(() -> other.fence(tenant, storage, 1, operation));
                first.get(10, TimeUnit.SECONDS);
                second.get(10, TimeUnit.SECONDS);
                assertUnavailable(() -> other.verify(binding));
            }
            maintenance(url, user, password, "restore-original", tenant, storage, root.toString(), "1",
                    operation, "--offline-confirmed");
            guard.verify(binding);
            assertUnavailable(() -> guard.fence(tenant, storage, 1, operation));
            Files.move(root, temporary.resolve("previous"));
            Files.createDirectory(root);
            Files.createDirectory(root.resolve("child"));
            Files.copy(temporary.resolve("previous/.qwen-managed-storage.json"),
                    root.resolve(".qwen-managed-storage.json"));
            Files.setLastModifiedTime(root, FileTime.fromMillis(2));
            var restarted = new WorkspaceStorageGuard(jdbc, new DataSourceTransactionManager(dataSource), properties);
            assertUnavailable(() -> restarted.verify(binding));
            assertUnavailable(() -> restarted.restoreOriginal(tenant, storage, 1, operation));
            assertThat(restarted.inspect(tenant, storage)).contains("revision=2", "identity=mismatch");
        } finally {
            jdbc.update("DELETE FROM ma_storage_owner WHERE tenant_id = ? AND storage_id = ?",
                    tenant, storage);
        }
    }

    private void maintenance(String url, String user, String password, String... arguments) throws Exception {
        var command = new java.util.ArrayList<>(List.of(
                Path.of(System.getProperty("java.home"), "bin/java").toString(), "-cp",
                System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                WorkspaceStorageRegistrationMain.class.getName()));
        command.addAll(List.of(arguments));
        Path log = temporary.resolve("maintenance-" + UUID.randomUUID() + ".log");
        var builder = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(log.toFile());
        builder.environment().put("W1_JDBC_URL", url);
        builder.environment().put("W1_JDBC_USER", user);
        builder.environment().put("W1_JDBC_PASSWORD", password);
        Process process = builder.start();
        try {
            assertThat(process.waitFor(15, TimeUnit.SECONDS)).isTrue();
            assertThat(process.exitValue()).as("%s", Files.readString(log)).isZero();
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    private static void assertUnavailable(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
    }
}
