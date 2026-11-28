package com.alibaba.qwen.code.managedagent.config.runtime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.maintenance.WorkspaceMigrationMain;
import com.alibaba.qwen.code.managedagent.maintenance.WorkspaceRecoveryCommand;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.InvocationTargetException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DisabledOnOs(OS.WINDOWS)
class RuntimeProviderMaintenanceTest {
    @Test
    void localMaintenanceRequiresItsFactoryBeforeSqlOrFilesystemAccess(@TempDir Path directory) throws Exception {
        try (var loader = RuntimeProviderLoaders.withoutFactoryServices()) {
            RuntimeProviderLoaders.withContextLoader(loader, () -> {
                var recovery = loader.loadClass(WorkspaceRecoveryCommand.class.getName());
                assertThatThrownBy(() -> recovery.getMethod("main", String[].class)
                        .invoke(null, (Object) new String[]{"inspect", "unused", "1"}))
                        .isInstanceOf(InvocationTargetException.class)
                        .rootCause().hasMessageContaining("not installed: local-process");
                Path absent = directory.resolve("missing.json");
                var migration = loader.loadClass(WorkspaceMigrationMain.class.getName());
                assertThatThrownBy(() -> migration.getMethod("main", String[].class)
                        .invoke(null, (Object) new String[]{"retire", absent.toString(), "--offline-confirmed"}))
                        .isInstanceOf(InvocationTargetException.class)
                        .rootCause().hasMessageContaining("not installed: local-process");
                assertThat(absent).doesNotExist();
            });
        }
    }

    @Test
    void offlineFactoryNeedsOriginalStateButNoWorkerConfiguration(@TempDir Path directory) throws Exception {
        var options = new ManagedAgentProperties.RuntimeBroker();
        options.setTrustedLocalRebootRecovery(false);
        options.setStateDirectory(directory.toRealPath().toString());
        var factory = new RuntimeProviderRegistry().require(options.getProvisioner());
        try (var recovery = factory.createForMaintenance(options, new HttpRuntimeTransport())) {
            assertThat(recovery.kind()).isEqualTo("local-process");
            try (var entries = Files.list(directory)) {
                assertThat(entries).isEmpty();
            }
        }
        options.setStateDirectory(directory.resolve("missing").toString());
        assertThatThrownBy(() -> factory.createForMaintenance(options, new HttpRuntimeTransport()))
                .hasMessageContaining("Original Runtime state directory is unavailable");
        assertThat(directory.resolve("missing")).doesNotExist();
    }
}
