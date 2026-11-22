package com.alibaba.qwen.code.managedagent.config.runtime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.maintenance.WorkspaceMigrationMain;
import com.alibaba.qwen.code.managedagent.maintenance.WorkspaceRecoveryCommand;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.Enumeration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DisabledOnOs(OS.WINDOWS)
class RuntimeProviderMaintenanceTest {
    @Test
    void localMaintenanceRequiresItsFactoryBeforeSqlOrFilesystemAccess(@TempDir Path directory) {
        Thread thread = Thread.currentThread();
        ClassLoader previous = thread.getContextClassLoader();
        thread.setContextClassLoader(new ClassLoader(previous) {
            @Override
            public Enumeration<URL> getResources(String name) throws IOException {
                return name.equals("META-INF/services/" + RuntimeProviderFactory.class.getName())
                        ? Collections.emptyEnumeration() : super.getResources(name);
            }
        });
        try {
            assertThatThrownBy(() -> WorkspaceRecoveryCommand.main(new String[]{"inspect", "unused", "1"}))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining("not installed: local-process");
            Path absent = directory.resolve("missing.json");
            assertThatThrownBy(() -> WorkspaceMigrationMain.main(new String[]{"retire", absent.toString(), "--offline-confirmed"}))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining("not installed: local-process");
            assertThat(absent).doesNotExist();
        } finally {
            thread.setContextClassLoader(previous);
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
