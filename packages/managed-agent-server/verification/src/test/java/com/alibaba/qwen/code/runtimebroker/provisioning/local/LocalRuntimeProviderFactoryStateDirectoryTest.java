package com.alibaba.qwen.code.runtimebroker.provisioning.local;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.host.RuntimeStateFiles;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.file.attribute.UserPrincipal;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The factory refuses an unusable ephemeral state path at wiring time with
 * the path named, without creating anything; an absent but creatable path
 * passes create() and preflight no longer refuses the deployment, because
 * the provisioner creates the directory at first spawn. Durable mode keeps
 * its own contract: the store creates the directory single-level during
 * wiring, so its parent must already exist.
 */
class LocalRuntimeProviderFactoryStateDirectoryTest {
    @TempDir
    Path directory;

    @Test
    void createLeavesAnAbsentCreatableStateDirectoryAbsent() {
        Path state = directory.resolve("absent-state");
        var factory = new LocalRuntimeProviderFactory();
        try (var provider = factory.create(settings(state), new HttpRuntimeTransport(),
                RuntimeProviderDependencies.NONE)) {
            assertThat(provider).isNotNull();
            assertThat(state).doesNotExist();
        }
    }

    @Test
    void nestedAbsentPathCrossesMultipleMissingSegments() {
        Path nested = directory.resolve("a").resolve("b").resolve("state");
        var factory = new LocalRuntimeProviderFactory();
        try (var provider = factory.create(settings(nested), new HttpRuntimeTransport(),
                RuntimeProviderDependencies.NONE)) {
            assertThat(provider).isNotNull();
            assertThat(nested).doesNotExist();
            assertThat(directory.resolve("a")).doesNotExist();
        }
        assertThat(factory.preflight(settings(nested)))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.WARN));
    }

    @Test
    void createRefusesAnOccupiedStatePathNamingTheDirectory() throws Exception {
        Path state = directory.resolve("occupied-state");
        Files.writeString(state, "not a directory");
        var factory = new LocalRuntimeProviderFactory();
        assertThatThrownBy(() -> factory.create(settings(state), new HttpRuntimeTransport(),
                RuntimeProviderDependencies.NONE))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Runtime Broker state directory is unavailable")
                .hasMessageContaining(state.toString());
        assertThat(Files.readString(state)).isEqualTo("not a directory");
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    void danglingSymlinkIsRefusedAtCreateAndPreflight() throws Exception {
        Path state = directory.resolve("dangling-state");
        Files.createSymbolicLink(state, directory.resolve("missing-target"));
        var factory = new LocalRuntimeProviderFactory();
        assertThatThrownBy(() -> factory.create(settings(state), new HttpRuntimeTransport(),
                RuntimeProviderDependencies.NONE))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining(state.toString());
        assertThat(factory.preflight(settings(state)))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL));
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    void symlinkToAnExistingDirectoryStaysCreatable() throws Exception {
        Path target = Files.createDirectory(directory.resolve("real-state"));
        Path state = directory.resolve("linked-state");
        Files.createSymbolicLink(state, target);
        var factory = new LocalRuntimeProviderFactory();
        try (var provider = factory.create(settings(state), new HttpRuntimeTransport(),
                RuntimeProviderDependencies.NONE)) {
            assertThat(provider).isNotNull();
        }
        assertThat(Files.isSymbolicLink(state)).isTrue();
        assertThat(factory.preflight(settings(state)))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.PASS));
    }

    @Test
    void uncreatableUnderFileParentFailsPreflightWithDetail() throws Exception {
        Path fileParent = directory.resolve("file-parent");
        Files.writeString(fileParent, "not a directory");
        Path state = fileParent.resolve("state");
        var factory = new LocalRuntimeProviderFactory();
        assertThatThrownBy(() -> factory.create(settings(state), new HttpRuntimeTransport(),
                RuntimeProviderDependencies.NONE))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining(state.toString());
        assertThat(factory.preflight(settings(state)))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> {
                    assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL);
                    assertThat(check.detail()).contains("cannot be created");
                });
    }

    @Test
    void nonWritableParentFailsPreflight() throws Exception {
        Path parent = Files.createDirectory(directory.resolve("ro-parent"));
        Path state = parent.resolve("state");
        assumeTrue(parent.toFile().setWritable(false, false), "chmod supported");
        assumeTrue(!Files.isWritable(parent), "permissions enforced (not root)");
        try {
            assertThat(new LocalRuntimeProviderFactory().preflight(settings(state)))
                    .filteredOn(check -> check.name().equals("broker-state"))
                    .singleElement()
                    .satisfies(check -> {
                        assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL);
                        assertThat(check.detail()).contains("cannot be created");
                    });
        } finally {
            assertThat(parent.toFile().setWritable(true, false)).isTrue();
        }
    }

    @Test
    void nonSearchableParentFailsPreflight() throws Exception {
        Path parent = Files.createDirectory(directory.resolve("wo-parent"));
        Path state = parent.resolve("state");
        assumeTrue(parent.toFile().setExecutable(false, false), "chmod supported");
        assumeTrue(parent.toFile().setWritable(true, false), "chmod supported");
        assumeTrue(!Files.isExecutable(parent), "permissions enforced (not root)");
        try {
            assertThat(new LocalRuntimeProviderFactory().preflight(settings(state)))
                    .filteredOn(check -> check.name().equals("broker-state"))
                    .singleElement()
                    .satisfies(check -> {
                        assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL);
                        assertThat(check.detail()).contains("cannot be created");
                    });
        } finally {
            assertThat(parent.toFile().setExecutable(true, false)).isTrue();
        }
    }

    @Test
    void preflightWarnsForAnAbsentCreatableDirectoryAndFailsForAnOccupiedPath() throws Exception {
        var factory = new LocalRuntimeProviderFactory();
        Path absent = directory.resolve("absent-state");
        assertThat(factory.preflight(settings(absent)))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> {
                    assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.WARN);
                    assertThat(check.detail()).contains("created at first Runtime spawn");
                });
        Path occupied = directory.resolve("occupied-state");
        Files.writeString(occupied, "not a directory");
        assertThat(factory.preflight(settings(occupied)))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL));
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    void durableAbsentUnderAbsentParentFailsPreflight() {
        Path state = directory.resolve("absent-parent").resolve("state");
        assertThat(new LocalRuntimeProviderFactory().preflight(durableSettings(state)))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> {
                    assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL);
                    assertThat(check.detail()).contains("cannot be created");
                });
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    void durableAbsentUnderExistingParentWarnsWithWiringTiming() {
        Path state = directory.resolve("durable-state");
        assertThat(new LocalRuntimeProviderFactory().preflight(durableSettings(state)))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> {
                    assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.WARN);
                    assertThat(check.detail()).contains("created during Broker wiring");
                });
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    void durableUnderSymlinkedAncestorFailsPreflightAndCreate() throws Exception {
        Path real = Files.createDirectory(directory.resolve("real-parent"));
        Path link = directory.resolve("link-parent");
        Files.createSymbolicLink(link, real);
        Path state = link.resolve("state");
        var factory = new LocalRuntimeProviderFactory();
        assertThat(factory.preflight(durableSettings(state)))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> {
                    assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL);
                    assertThat(check.detail()).contains("is under a symbolic link");
                });
        assertThatThrownBy(() -> factory.create(durableSettings(state), new HttpRuntimeTransport(),
                RuntimeProviderDependencies.NONE))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    void durableExistingLeafViaSymlinkFailsPreflight() throws Exception {
        Path real = Files.createDirectory(directory.resolve("real-leaf"));
        Path state = directory.resolve("linked-leaf");
        Files.createSymbolicLink(state, real);
        assertThat(new LocalRuntimeProviderFactory().preflight(durableSettings(state)))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> {
                    assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL);
                    assertThat(check.detail()).contains("is not a valid durable state directory");
                });
    }

    @Test
    void durableExistingNonPrivateDirectoryFailsPreflightAndCreate() throws Exception {
        Path state = Files.createDirectory(directory.resolve("existing-0755"));
        var factory = new LocalRuntimeProviderFactory();
        assertThat(factory.preflight(durableSettings(state)))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> {
                    assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL);
                    assertThat(check.detail()).contains("is not a valid durable state directory");
                });
        assertThatThrownBy(() -> factory.create(durableSettings(state), new HttpRuntimeTransport(),
                RuntimeProviderDependencies.NONE))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    void durableAbsentUnderNonReadableParentFailsPreflight() throws Exception {
        Path parent = Files.createDirectory(directory.resolve("wx-parent"));
        Path state = parent.resolve("state");
        assumeTrue(parent.toFile().setReadable(false, false), "chmod supported");
        assumeTrue(!Files.isReadable(parent), "permissions enforced (not root)");
        try {
            assertThat(new LocalRuntimeProviderFactory().preflight(durableSettings(state)))
                    .filteredOn(check -> check.name().equals("broker-state"))
                    .singleElement()
                    .satisfies(check -> {
                        assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL);
                        assertThat(check.detail()).contains("cannot be created");
                    });
        } finally {
            assertThat(parent.toFile().setReadable(true, false)).isTrue();
        }
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    void durableAbsentInsideWorkspaceCwdFailsPreflight() {
        Path state = directory.resolve("state");
        var settings = durableSettings(state);
        settings.getRuntimeBroker().setWorkspaceCwd(directory.toString());
        assertThat(new LocalRuntimeProviderFactory().preflight(settings))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> {
                    assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL);
                    assertThat(check.detail()).contains("outside Workspace roots");
                });
    }

    @Test
    void existingDirectoryWithoutSearchBitFailsPreflightAndCreate() throws Exception {
        Path state = Files.createDirectory(directory.resolve("no-search-state"));
        assumeTrue(state.toFile().setExecutable(false, false), "chmod supported");
        assumeTrue(!Files.isExecutable(state), "permissions enforced (not root)");
        try {
            var factory = new LocalRuntimeProviderFactory();
            assertThat(factory.preflight(settings(state)))
                    .filteredOn(check -> check.name().equals("broker-state"))
                    .singleElement()
                    .satisfies(check -> {
                        assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL);
                        assertThat(check.detail()).contains("is not writable and searchable");
                    });
            assertThatThrownBy(() -> factory.create(settings(state), new HttpRuntimeTransport(),
                    RuntimeProviderDependencies.NONE))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining(state.toString());
        } finally {
            assertThat(state.toFile().setExecutable(true, false)).isTrue();
        }
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    void durableExistingInsideWorkspaceCwdFailsPreflightAndCreate() throws Exception {
        Path workspace = Files.createDirectory(directory.resolve("workspace"));
        Path state = Files.createDirectory(workspace.resolve("state"));
        Files.setPosixFilePermissions(state,
                java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
        var settings = durableSettings(state);
        settings.getRuntimeBroker().setWorkspaceCwd(workspace.toString());
        var factory = new LocalRuntimeProviderFactory();
        assertThat(factory.preflight(settings))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> {
                    assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL);
                    assertThat(check.detail()).contains("outside Workspace roots");
                });
        assertThatThrownBy(() -> factory.create(settings, new HttpRuntimeTransport(),
                RuntimeProviderDependencies.NONE))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    void durableRelativeExistingPrivateDirectoryPassesPreflight() throws Exception {
        // A relative configured path resolves against the process working
        // directory, exactly as create() absolutizes it; the canonical check
        // must run on the absolute path, not the relative spelling.
        Path relative = Path.of("target", "durable-rel-state-" + UUID.randomUUID());
        Files.createDirectories(relative);
        Files.setPosixFilePermissions(relative, PosixFilePermissions.fromString("rwx------"));
        try {
            var settings = durableSettings(relative);
            settings.getRuntimeBroker().setWorkspaceCwd(directory.toString());
            assertThat(new LocalRuntimeProviderFactory().preflight(settings))
                    .filteredOn(check -> check.name().equals("broker-state"))
                    .singleElement()
                    .satisfies(check -> assertThat(check.status())
                            .isEqualTo(RuntimeProviderFactory.Status.PASS));
        } finally {
            Files.deleteIfExists(relative);
        }
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    void durableForeignOwnedPrivateDirectoryPassesPreflight() throws Exception {
        // The checker may run as a different account than the Broker (root
        // --check is recommended): a canonical 0700 directory owned by the
        // service account must not FAIL just because the checker is not that
        // owner. Requires privilege to chown to a foreign principal; skips
        // where that is not permitted.
        Path state = Files.createDirectory(directory.resolve("foreign-owned"));
        Files.setPosixFilePermissions(state, PosixFilePermissions.fromString("rwx------"));
        UserPrincipal foreign = state.getFileSystem().getUserPrincipalLookupService()
                .lookupPrincipalByName("nobody");
        assumeTrue(!foreign.equals(RuntimeStateFiles.processOwner()), "checker is not nobody");
        try {
            Files.setOwner(state, foreign);
        } catch (IOException | UnsupportedOperationException denied) {
            assumeTrue(false, "chown to a foreign principal requires privilege");
        }
        assumeTrue(!Files.getOwner(state).equals(RuntimeStateFiles.processOwner()),
                "directory owner differs from the checker");
        assertThat(new LocalRuntimeProviderFactory().preflight(durableSettings(state)))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> assertThat(check.status())
                        .isEqualTo(RuntimeProviderFactory.Status.PASS));
    }

    private static ManagedAgentProperties settings(Path state) {
        var settings = new ManagedAgentProperties();
        var broker = settings.getRuntimeBroker();
        broker.setProvisioner("local-process");
        broker.setStateDirectory(state.toString());
        broker.setNodeExecutable("/unused-node");
        broker.setWorkerEntry("/unused-worker");
        broker.setDurableLocalProcess(false);
        broker.setIsolationClass("workspace");
        broker.setTrustedLocalRebootRecovery(false);
        return settings;
    }

    private static ManagedAgentProperties durableSettings(Path state) {
        var settings = settings(state);
        settings.getRuntimeBroker().setDurableLocalProcess(true);
        return settings;
    }
}