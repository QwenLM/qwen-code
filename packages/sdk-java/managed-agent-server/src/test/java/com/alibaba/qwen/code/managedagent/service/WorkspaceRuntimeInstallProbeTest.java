package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceStorageGuard;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * The W2 settlement probe {@link WorkspaceRuntimeResolver#verifyInstallable}
 * against real directories: it must accept exactly what a tool-turn
 * acquisition accepts and refuse every substitution early, while claiming
 * nothing and contacting no worker.
 */
class WorkspaceRuntimeInstallProbeTest {
    private static final String TENANT = "probe-tenant";
    private static final String STORAGE = "probe-storage";

    @TempDir
    private Path temporary;

    @Test
    void acceptsNestedAndRefusesMissingFileAndAliasedDirectories()
            throws Exception {
        Path root = Files.createDirectory(temporary.resolve("mount"))
                .toRealPath();
        Files.createDirectories(root.resolve("services/api"));
        Files.createFile(root.resolve("plain-file"));
        Files.createSymbolicLink(root.resolve("alias"),
                root.resolve("services"));
        Files.createSymbolicLink(root.resolve("leaf-link"),
                root.resolve("services/api"));
        WorkspaceRuntimeResolver resolver = resolver(root);

        assertThatCode(() -> resolver.verifyInstallable(
                binding("services/api"), "services/api"))
                .doesNotThrowAnyException();
        // The Workspace root itself is a legal target.
        assertThatCode(() -> resolver.verifyInstallable(
                binding("services/api"), "."))
                .doesNotThrowAnyException();
        assertProbeRefused(resolver, "services/missing");
        assertProbeRefused(resolver, "plain-file");
        assertProbeRefused(resolver, "alias");
        assertProbeRefused(resolver, "alias/api");
        assertProbeRefused(resolver, "leaf-link");
        assertProbeRefused(resolver, "..");
    }

    @Test
    void refusesUnknownStorageAndAMountWhoseIdentityMoved() throws Exception {
        Path root = Files.createDirectory(temporary.resolve("mount"))
                .toRealPath();
        Files.createDirectories(root.resolve("services/api"));
        WorkspaceRuntimeResolver resolver = resolver(root);

        assertThatThrownBy(() -> resolver.verifyInstallable(
                new ContextBinding(TENANT, "ws-a", 1, "other-storage",
                        "services/api", "cfg", 1), "services/api"))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> org.assertj.core.api.Assertions.assertThat(
                                error.getCode())
                                .isEqualTo("workspace_unavailable"));

        // Swap the mount root for a sibling allocated while the original
        // still exists, so the new directory provably holds a fresh inode
        // on every filesystem, then delete the original.
        Path replacement = Files.createDirectory(
                temporary.resolve("replacement"));
        Files.createDirectories(replacement.resolve("services/api"));
        deleteRecursively(root);
        Files.move(replacement, root);
        assertProbeRefused(resolver, "services/api");
    }

    // When verified recovery is enabled, the probe re-runs the storage
    // guard's mount verification, exactly as `resolve()` does.
    @Test
    void aGuardedMountVerifiesTheProbeTarget() throws Exception {
        Path root = Files.createDirectory(temporary.resolve("mount"))
                .toRealPath();
        Files.createDirectories(root.resolve("services/api"));
        WorkspaceStorageGuard guard = mock(WorkspaceStorageGuard.class);
        when(guard.enabled()).thenReturn(true);
        var dataSource = new DriverManagerDataSource(
                "jdbc:h2:mem:probe-guarded;MODE=MySQL;DB_CLOSE_DELAY=-1",
                "sa", "");
        WorkspaceRuntimeResolver guarded = new WorkspaceRuntimeResolver(
                null, new WorkspaceExecutionStore(new JdbcTemplate(
                        dataSource),
                        new DataSourceTransactionManager(dataSource), guard),
                mountProperties(root));

        assertThatCode(() -> guarded.verifyInstallable(
                binding("services/api"), "services/api"))
                .doesNotThrowAnyException();
        org.mockito.Mockito.verify(guard).verify(
                org.mockito.ArgumentMatchers.any(ContextBinding.class));

        org.mockito.Mockito.doThrow(WorkspaceExecutionStore.unavailable())
                .when(guard).verify(
                        org.mockito.ArgumentMatchers.any(
                                ContextBinding.class));
        assertThatThrownBy(() -> guarded.verifyInstallable(
                binding("services/api"), "services/api"))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> org.assertj.core.api.Assertions.assertThat(
                                error.getCode())
                                .isEqualTo("workspace_unavailable"));
    }

    private void assertProbeRefused(WorkspaceRuntimeResolver resolver,
            String target) {
        assertThatThrownBy(() -> resolver.verifyInstallable(
                binding("services/api"), target))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> org.assertj.core.api.Assertions.assertThat(
                                error.getCode())
                                .isEqualTo("workspace_unavailable"));
    }

    private WorkspaceRuntimeResolver resolver(Path root) {
        var dataSource = new DriverManagerDataSource(
                "jdbc:h2:mem:probe;MODE=MySQL;DB_CLOSE_DELAY=-1", "sa", "");
        return new WorkspaceRuntimeResolver(null,
                new WorkspaceExecutionStore(new JdbcTemplate(dataSource),
                        new DataSourceTransactionManager(dataSource)),
                mountProperties(root));
    }

    private ManagedAgentProperties mountProperties(Path root) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setProvisioner("local-process");
        properties.getRuntimeBroker().setIsolationClass("session");
        properties.getRuntimeBroker().setWorkspaceMounts(java.util.List.of(
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(
                        TENANT, STORAGE, root.toString())));
        return properties;
    }

    private static ContextBinding binding(String cwdRelative) {
        return new ContextBinding(TENANT, "ws-a", 1, STORAGE, cwdRelative,
                "cfg", 1);
    }

    private static void deleteRecursively(Path root) throws Exception {
        try (var tree = Files.walk(root)) {
            for (Path path : tree.sorted(java.util.Comparator.reverseOrder())
                    .toList()) {
                Files.delete(path);
            }
        }
    }
}
