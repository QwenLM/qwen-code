package com.alibaba.qwen.code.runtimebroker.provisioning.local;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

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
    void preflightAcceptsAnAbsentStateDirectoryOnlyForTheEphemeralRuntime() {
        var factory = new LocalRuntimeProviderFactory();
        var ephemeral = settings();
        ephemeral.getRuntimeBroker().setDurableLocalProcess(false);
        assertThat(factory.preflight(ephemeral))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> assertThat(check.status())
                        .isEqualTo(RuntimeProviderFactory.Status.PASS));
        assertThat(factory.preflight(settings()))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> assertThat(check.status())
                        .isEqualTo(RuntimeProviderFactory.Status.FAIL));
        assertThat(temporary.resolve("not-created")).doesNotExist();
    }

    @Test
    void preflightRejectsAnEphemeralStateDirectoryBlockedByAFile() throws Exception {
        Path blocker = Files.createFile(temporary.resolve("blocker"));
        var ephemeral = settings();
        ephemeral.getRuntimeBroker().setDurableLocalProcess(false);
        ephemeral.getRuntimeBroker().setStateDirectory(blocker.resolve("state").toString());
        assertThat(new LocalRuntimeProviderFactory().preflight(ephemeral))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> {
                    assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL);
                    assertThat(check.detail()).contains(blocker.toString());
                });
    }

    @Test
    void preflightRejectsAnEphemeralStateDirectoryBehindADanglingLink() throws Exception {
        assumeTrue(FileSystems.getDefault().supportedFileAttributeViews().contains("posix"));
        Path link = temporary.resolve("state");
        Files.createSymbolicLink(link, temporary.resolve("missing"));
        var ephemeral = settings();
        ephemeral.getRuntimeBroker().setDurableLocalProcess(false);
        ephemeral.getRuntimeBroker().setStateDirectory(link.toString());
        assertThat(new LocalRuntimeProviderFactory().preflight(ephemeral))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> {
                    assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL);
                    assertThat(check.detail()).contains(link.toString());
                });
    }

    @Test
    void preflightRejectsAnEphemeralStateDirectoryWhoseAncestorIsNotWritable() throws Exception {
        assumeTrue(FileSystems.getDefault().supportedFileAttributeViews().contains("posix"));
        Path ancestor = Files.createDirectory(temporary.resolve("read-only"));
        var permissions = Files.getPosixFilePermissions(ancestor);
        Files.setPosixFilePermissions(ancestor, PosixFilePermissions.fromString("r-xr-xr-x"));
        try {
            var ephemeral = settings();
            ephemeral.getRuntimeBroker().setDurableLocalProcess(false);
            ephemeral.getRuntimeBroker().setStateDirectory(ancestor.resolve("state").toString());
            assertThat(new LocalRuntimeProviderFactory().preflight(ephemeral))
                    .filteredOn(check -> check.name().equals("broker-state"))
                    .singleElement()
                    .satisfies(check -> assertThat(check.status())
                            .isEqualTo(RuntimeProviderFactory.Status.FAIL));
        } finally {
            Files.setPosixFilePermissions(ancestor, permissions);
        }
    }

    @Test
    void preflightRejectsAnEphemeralStateDirectoryWhoseAncestorIsNotSearchable() throws Exception {
        assumeTrue(FileSystems.getDefault().supportedFileAttributeViews().contains("posix"));
        Path ancestor = Files.createDirectory(temporary.resolve("unsearchable"));
        var permissions = Files.getPosixFilePermissions(ancestor);
        Files.setPosixFilePermissions(ancestor, PosixFilePermissions.fromString("rw-------"));
        try {
            var ephemeral = settings();
            ephemeral.getRuntimeBroker().setDurableLocalProcess(false);
            ephemeral.getRuntimeBroker().setStateDirectory(ancestor.resolve("state").toString());
            assertThat(new LocalRuntimeProviderFactory().preflight(ephemeral))
                    .filteredOn(check -> check.name().equals("broker-state"))
                    .singleElement()
                    .satisfies(check -> assertThat(check.status())
                            .isEqualTo(RuntimeProviderFactory.Status.FAIL));
        } finally {
            Files.setPosixFilePermissions(ancestor, permissions);
        }
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
