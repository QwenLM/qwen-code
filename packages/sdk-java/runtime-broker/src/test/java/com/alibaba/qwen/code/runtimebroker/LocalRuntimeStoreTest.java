package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import org.junit.jupiter.api.Test;

class LocalRuntimeStoreTest {
    @org.junit.jupiter.api.condition.DisabledOnOs(org.junit.jupiter.api.condition.OS.WINDOWS)
    @Test
    void preflightChecksExistingPrivateStateWithoutChangingIt(
            @org.junit.jupiter.api.io.TempDir Path directory) throws Exception {
        Path state = directory.toRealPath().resolve("state");
        assertThrows(java.io.IOException.class,
                () -> LocalProcessRuntimeProvisioner.validateStateDirectory(state));
        assertTrue(Files.notExists(state));
        var permissions = PosixFilePermissions.fromString("rwxr-xr-x");
        Files.createDirectory(state);
        Files.setPosixFilePermissions(state, permissions);
        assertThrows(java.io.IOException.class,
                () -> LocalProcessRuntimeProvisioner.validateStateDirectory(state));
        assertEquals(permissions, Files.getPosixFilePermissions(state));
        Files.setPosixFilePermissions(state, PosixFilePermissions.fromString("rwx------"));
        String user = System.getProperty("user.name");
        System.setProperty("user.name", "qwen-unresolvable-user-4242");
        try {
            LocalProcessRuntimeProvisioner.validateStateDirectory(state);
        } finally {
            System.setProperty("user.name", user);
        }
        try (var entries = Files.list(state)) {
            assertEquals(0, entries.count());
        }
    }

    @Test
    void nonLinuxReportsThePlatformAndBothOptOutProperties() {
        String os = System.getProperty("os.name");
        org.junit.jupiter.api.Assumptions.assumeFalse("Linux".equals(os));
        IllegalStateException error = assertThrows(IllegalStateException.class,
                LocalRuntimeStore.HostIdentity::linux);
        assertTrue(error.getMessage().contains(os), error::getMessage);
        assertTrue(error.getMessage().contains("durable-local-process"), error::getMessage);
        assertTrue(error.getMessage().contains("runtime-broker.trusted-local-reboot-recovery"),
                error::getMessage);
    }

    @Test
    void identityUnavailableCarriesSourcesAndBothOptOuts() {
        IllegalStateException error = LocalRuntimeStore.HostIdentity
                .identityUnavailable(new IllegalArgumentException("malformed probe"));
        assertTrue(error.getMessage().contains("/etc/machine-id"), error::getMessage);
        assertTrue(error.getMessage().contains("durable-local-process"), error::getMessage);
        assertTrue(error.getMessage().contains("runtime-broker.trusted-local-reboot-recovery"),
                error::getMessage);
    }

    @Test
    void linuxReadFailureUsesTheSameSharedMessage() {
        String os = System.getProperty("os.name");
        org.junit.jupiter.api.Assumptions.assumeFalse("Linux".equals(os));
        System.setProperty("os.name", "Linux");
        try {
            IllegalStateException error = assertThrows(IllegalStateException.class,
                    LocalRuntimeStore.HostIdentity::linux);
            assertTrue(error.getMessage().contains("/etc/machine-id"), error::getMessage);
            assertTrue(error.getMessage().contains("runtime-broker.trusted-local-reboot-recovery"),
                    error::getMessage);
        } finally {
            System.setProperty("os.name", os);
        }
    }

    // The store owns Posix permissions; Windows has none to validate against.
    @org.junit.jupiter.api.condition.DisabledOnOs(org.junit.jupiter.api.condition.OS.WINDOWS)
    @Test
    void brokerUserNeedNotResolveByNameInThePasswdDatabase(
            @org.junit.jupiter.api.io.TempDir Path directory) throws Exception {
        // LocalRuntimeStore rejects symlinked ancestors (e.g. /var on macOS).
        Path state = directory.toRealPath().resolve("state");
        String user = System.getProperty("user.name");
        System.setProperty("user.name", "qwen-unresolvable-user-4242");
        try {
            new LocalRuntimeStore(state, DurableLocalProcessRuntimeProvisionerTest.HOST);
        } finally {
            System.setProperty("user.name", user);
        }
        assertTrue(Files.isDirectory(state), "state directory created");
    }
}
