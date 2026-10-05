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
        Files.createSymbolicLink(root.resolve("loop-a"),
                root.resolve("loop-a"));
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
        // ENOTDIR / ELOOP are the structural verdict too — on some JDKs
        // they surface as a bare FileSystemException, so the classifier
        // walks the ancestor chain rather than keying on the class.
        assertProbeRefused(resolver, "plain-file/lib");
        assertProbeRefused(resolver, "loop-a/lib");
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
    // guard's mount verification of the **candidate** binding only — the
    // target directory differs from the current one here, so no current-
    // binding call can hide behind it.
    @Test
    void aGuardedMountVerifiesTheProbeTarget() throws Exception {
        Path root = Files.createDirectory(temporary.resolve("mount"))
                .toRealPath();
        Files.createDirectories(root.resolve("services/api"));
        Files.createDirectories(root.resolve("services/b"));
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

        ContextBinding bound = binding("services/api");
        assertThatCode(() -> guarded.verifyInstallable(bound, "services/b"))
                .doesNotThrowAnyException();
        org.mockito.Mockito.verify(guard).verifyProbe(
                org.mockito.ArgumentMatchers.argThat(candidate ->
                        "services/b".equals(candidate.getCwdRelative())));
        // The negative half: no second guard call, in particular none
        // against the current binding (would permanently refuse the escape).
        org.mockito.Mockito.verifyNoMoreInteractions(guard);

        org.mockito.Mockito.doThrow(WorkspaceExecutionStore.unavailable())
                .when(guard).verifyProbe(
                        org.mockito.ArgumentMatchers.any(
                                ContextBinding.class));
        assertThatThrownBy(() -> guarded.verifyInstallable(bound,
                "services/b"))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> org.assertj.core.api.Assertions.assertThat(
                                error.getCode())
                                .isEqualTo("workspace_unavailable"));
    }

    private void assertProbeRefused(WorkspaceRuntimeResolver resolver,
            String target) {
        // Every reachable probe refusal here is the structural, terminal
        // verdict — the retryable arm is a momentary I/O failure only, and
        // no call site in this suite raises it.
        assertThatThrownBy(() -> resolver.verifyInstallable(
                binding("services/api"), target))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> {
                            org.assertj.core.api.Assertions.assertThat(
                                    error.getCode())
                                    .isEqualTo("workspace_unavailable");
                            org.assertj.core.api.Assertions.assertThat(
                                    error.isRetryable()).isFalse();
                        });
    }

    // A mount root or target directory that is GONE is the structural
    // verdict the terminal refusal names (NoSuchFileException), not an
    // I/O blip to retry forever — the earlier classification drew the
    // line at the origin class and let a vanished mount wedge the
    // Session against session_context_busy with unbounded retries.
    @Test
    void aVanishedTargetOrMountRootRefusesTerminally() throws Exception {
        Path root = Files.createDirectory(temporary.resolve("mount"))
                .toRealPath();
        Files.createDirectories(root.resolve("gone"));
        Files.delete(root.resolve("gone"));
        WorkspaceRuntimeResolver resolver = resolver(root);
        assertProbeRefused(resolver, "gone");

        deleteRecursively(root);
        assertProbeRefused(resolver, "services/api");
    }

    // The mirror direction: a MOMENTARY I/O failure classifies retryable,
    // never the terminal verdict — the shared rule probes with throwing
    // calls, and only the catch arms classify. A single segment past the
    // filesystem's name limit throws FileSystemException (ENAMETOOLONG)
    // from the readAttributes probe: a generic IOException — neither
    // NoSuchFileException nor AccessDeniedException — deterministic on
    // POSIX. Collapsing the catch(IOException) arm into unavailable()
    // turns this red.
    @Test
    void aMomentaryIoFailureClassifiesRetryable() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(java.nio.file
                .FileSystems.getDefault().supportedFileAttributeViews()
                .contains("posix"));
        Path root = Files.createDirectory(temporary.resolve("mount"))
                .toRealPath();
        WorkspaceRuntimeResolver resolver = resolver(root);
        assertThatThrownBy(() -> resolver.verifyInstallable(
                binding("services/api"), "a".repeat(256)))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> {
                            org.assertj.core.api.Assertions.assertThat(
                                    error.getCode())
                                    .isEqualTo("workspace_unavailable");
                            org.assertj.core.api.Assertions.assertThat(
                                    error.isRetryable()).isTrue();
                        });
    }

    // The guard verifies the candidate binding, not the current one: a
    // Session whose present directory is already gone must still be
    // movable — that is the escape this feature exists for.
    @Test
    void theGuardVerifiesTheCandidateBindingNotTheDestroyedCurrentOne()
            throws Exception {
        Path root = Files.createDirectory(temporary.resolve("mount"))
                .toRealPath();
        Files.createDirectories(root.resolve("gone"));
        Files.createDirectories(root.resolve("next"));
        Files.delete(root.resolve("gone"));
        WorkspaceStorageGuard guard = mock(WorkspaceStorageGuard.class);
        when(guard.enabled()).thenReturn(true);
        var dataSource = new DriverManagerDataSource(
                "jdbc:h2:mem:probe-candidate;MODE=MySQL;DB_CLOSE_DELAY=-1",
                "sa", "");
        WorkspaceRuntimeResolver guarded = new WorkspaceRuntimeResolver(
                null, new WorkspaceExecutionStore(new JdbcTemplate(
                        dataSource),
                        new DataSourceTransactionManager(dataSource), guard),
                mountProperties(root));

        assertThatCode(() -> guarded.verifyInstallable(binding("gone"),
                "next")).doesNotThrowAnyException();
        org.mockito.Mockito.verify(guard).verifyProbe(
                org.mockito.ArgumentMatchers.argThat(candidate ->
                        "next".equals(candidate.getCwdRelative())));
        // And never against the destroyed current binding.
        org.mockito.Mockito.verifyNoMoreInteractions(guard);
    }

    // The worker's install runs fs.access(R_OK|X_OK); the shared rule must
    // refuse everything it would — before any claim can be stranded, each
    // conjunct refusing alone: search-only is refused (read check), read-
    // only is refused (search check), nothing is refused (both), r-x is
    // accepted. uid-0 hosts bypass POSIX checks, so the gate measures the
    // seal's own effect instead of trusting attribute-view support.
    @Test
    void theProbeRefusesAnUnreadableOrUnsearchableTarget() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(java.nio.file
                .FileSystems.getDefault().supportedFileAttributeViews()
                .contains("posix"));
        Path root = Files.createDirectory(temporary.resolve("mount"))
                .toRealPath();
        Path probe = Files.createDirectory(root.resolve("probe"));
        Files.setPosixFilePermissions(probe,
                java.nio.file.attribute.PosixFilePermissions
                        .fromString("---------"));
        org.junit.jupiter.api.Assumptions.assumeTrue(
                !Files.isReadable(probe) || !Files.isExecutable(probe),
                "POSIX permission checks are not enforced for this uid");

        Path nothing = Files.createDirectory(root.resolve("nothing"));
        Files.setPosixFilePermissions(nothing,
                java.nio.file.attribute.PosixFilePermissions
                        .fromString("---------"));
        Path searchOnly = Files.createDirectory(root.resolve("search-only"));
        Files.setPosixFilePermissions(searchOnly,
                java.nio.file.attribute.PosixFilePermissions
                        .fromString("--x------"));
        Path readOnly = Files.createDirectory(root.resolve("read-only"));
        Files.setPosixFilePermissions(readOnly,
                java.nio.file.attribute.PosixFilePermissions
                        .fromString("r--------"));
        Path allowed = Files.createDirectory(root.resolve("allowed"));
        Files.setPosixFilePermissions(allowed,
                java.nio.file.attribute.PosixFilePermissions
                        .fromString("r-x------"));
        try {
            WorkspaceRuntimeResolver resolver = resolver(root);
            assertProbeRefused(resolver, "nothing");
            assertProbeRefused(resolver, "search-only");
            assertProbeRefused(resolver, "read-only");
            assertThatCode(() -> resolver.verifyInstallable(
                    binding("allowed"), "allowed"))
                    .doesNotThrowAnyException();
        } finally {
            var restore = java.nio.file.attribute.PosixFilePermissions
                    .fromString("rwx------");
            Files.setPosixFilePermissions(probe, restore);
            Files.setPosixFilePermissions(nothing, restore);
            Files.setPosixFilePermissions(searchOnly, restore);
            Files.setPosixFilePermissions(readOnly, restore);
            Files.setPosixFilePermissions(allowed, restore);
        }
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
