package com.alibaba.qwen.code.runtimebroker.provisioning.local;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LocalRuntimeProviderFactoryTest {
    @TempDir
    Path temporary;

    @Test
    void validatesConfigurationWithoutReadingLocalFilesOrHostIdentity() {
        var settings = settings();
        var factory = new LocalRuntimeProviderFactory();
        assertThat(settings.getRuntimeBroker().isDurableLocalProcess()).isTrue();
        assertThat(settings.getRuntimeBroker().isTrustedLocalRebootRecovery()).isTrue();
        factory.validate(settings);
        assertThat(temporary.resolve("not-created")).doesNotExist();
    }

    @Test
    void createReusesConfigurationValidationBeforeOpeningLocalState() {
        var settings = settings();
        settings.getRuntimeBroker().setWorkerEntry("");
        assertThatThrownBy(() -> new LocalRuntimeProviderFactory().create(settings, null, RuntimeProviderDependencies.NONE))
                .isInstanceOf(IllegalStateException.class).hasMessage("Runtime worker entry is required");
        assertThat(temporary.resolve("not-created")).doesNotExist();
    }

    @Test
    void rejectsRelativeExtensionCacheBeforeOpeningLocalState() {
        var settings = settings();
        settings.getManagedExtensions().setEnabled(true);
        settings.getManagedExtensions().setCacheDirectory("relative-cache");
        assertThatThrownBy(() -> new LocalRuntimeProviderFactory().validate(settings))
                .isInstanceOf(IllegalArgumentException.class).hasMessage("Extension cache must be absolute");
        assertThat(temporary.resolve("not-created")).doesNotExist();
    }

    @Test
    void preflightTreatsABlankWorkspaceCwdAsUnconfigured() {
        var settings = settings();
        settings.getRuntimeBroker().setWorkspaceCwd("");
        // `Path.of("")` is this process's working directory, so an absent state
        // directory under it used to read as "inside a Workspace root" and made
        // the verdict depend on where `--check` ran.
        settings.getRuntimeBroker()
                .setStateDirectory(Path.of("").toAbsolutePath()
                        .resolve("qwen-preflight-absent-state").toString());
        assertThat(new LocalRuntimeProviderFactory().preflight(settings))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> {
                    // Absent but creatable: the verdict is the WARN naming the
                    // store, never "inside a Workspace root".
                    assertThat(check.status())
                            .isEqualTo(RuntimeProviderFactory.Status.WARN);
                    assertThat(String.valueOf(check.remediation()))
                            .doesNotContain("outside every configured Workspace");
                    assertThat(String.valueOf(check.detail()))
                            .doesNotContain("Workspace root");
                });
    }

    private ManagedAgentProperties settings() {
        var settings = new ManagedAgentProperties();
        var broker = settings.getRuntimeBroker();
        Path absent = temporary.resolve("not-created");
        broker.setStateDirectory(absent.resolve("state").toString());
        broker.setNodeExecutable(absent.resolve("node").toString());
        broker.setWorkerEntry(absent.resolve("cli.js").toString());
        return settings;
    }
}
