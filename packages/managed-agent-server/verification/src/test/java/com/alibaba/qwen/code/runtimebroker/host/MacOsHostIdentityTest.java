package com.alibaba.qwen.code.runtimebroker.host;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MacOsHostIdentityTest {
    private static final String UUID = "ABCDEF01-2345-6789-ABCD-EF0123456789";

    @Test
    void volumeUuidRequiresOneUuidAndTheResolvedDevice() throws Exception {
        String device = "<key>DeviceNode</key><string>/dev/disk3s1</string>";
        String volume = "<key>VolumeUUID</key><string>" + UUID + "</string>";
        assertEquals(UUID.replace("-", "").toLowerCase(java.util.Locale.ROOT),
                MacOsHostIdentity.parseVolumeUuid(device + volume, "/dev/disk3s1"));
        for (String output : new String[] {device, volume, device + volume + volume,
                device + device + volume, device + volume.replace(UUID, "not-a-uuid"),
                device + volume.replace(UUID, "00000000-0000-0000-0000-000000000000")}) {
            assertThrows(IOException.class, () -> MacOsHostIdentity.parseVolumeUuid(output, "/dev/disk3s1"));
        }
        assertThrows(IOException.class, () -> MacOsHostIdentity.parseVolumeUuid(device + volume, "/dev/disk4s1"));
    }

    @EnabledOnOs(OS.MAC)
    @Test
    void nativeVolumeIdentityAndNumericIdentityUseTheSameInode(@org.junit.jupiter.api.io.TempDir Path directory)
            throws Exception {
        Path root = directory.toRealPath();
        var reader = new com.alibaba.qwen.code.runtimebroker.provisioning.NativeStorageIdentityReader();
        var stable = reader.read(root);
        var numeric = reader.readLegacy(root);
        assertEquals(MacOsHostIdentity.volumeUuid(root), stable.device());
        assertTrue(stable.device().matches("[0-9a-f]{32}"));
        assertEquals(Long.toUnsignedString(((Number) Files.getAttribute(root, "unix:dev")).longValue()), numeric.device());
        assertEquals(stable.inode(), numeric.inode());
        assertEquals(stable.birthTime(), numeric.birthTime());
        assertEquals(stable.hostId(), numeric.hostId());
        assertTrue(MacOsHostIdentity.fileIdentity(root).startsWith("macos-volume/1:" + stable.device() + ":"));
        Path link = root.resolve("link");
        Files.createSymbolicLink(link, root);
        assertThrows(IOException.class, () -> MacOsHostIdentity.fileIdentity(link));
    }

    @EnabledOnOs(OS.MAC)
    @Timeout(60)
    @Test
    void identityProbeToleratesChildEntryWritesDuringTheProbe(@org.junit.jupiter.api.io.TempDir Path directory)
            throws Exception {
        Path root = directory.toRealPath();
        var reader = new com.alibaba.qwen.code.runtimebroker.provisioning.NativeStorageIdentityReader();
        Thread writer = new Thread(() -> {
            try {
                while (!Thread.currentThread().isInterrupted()) {
                    Path child = root.resolve("probe-churn");
                    Files.deleteIfExists(child);
                    Files.createFile(child);
                }
            } catch (IOException directoryRemovedAfterTheTest) {
                Thread.currentThread().interrupt();
            }
        });
        writer.setDaemon(true);
        writer.start();
        try {
            FileTime mtimeBefore = Files.getLastModifiedTime(root);
            var first = reader.read(root);
            for (int i = 0; i < 2; i++) {
                var next = reader.read(root);
                assertEquals(first.device(), next.device());
                assertEquals(first.inode(), next.inode());
                assertEquals(first.birthTime(), next.birthTime());
            }
            assertTrue(Files.getLastModifiedTime(root).compareTo(mtimeBefore) > 0,
                    "child-entry writes must churn the root mtime during the probes");
        } finally {
            writer.interrupt();
            writer.join(5000);
        }
    }

    @Test
    void preservesHardwareUuidBytesUsedByTheStorageMarker() throws Exception {
        assertEquals(UUID, MacOsHostIdentity.parseMachineId("  \"IOPlatformUUID\" = \"" + UUID + "\"\n"));
    }

    @Test
    void storageBirthTimeKeepsNanosecondsAndRejectsChangedOrMissingIdentity() throws Exception {
        assertEquals("2026-10-17T04:11:37.245844403Z",
                MacOsHostIdentity.parseBirthTime("1|2|1792210297.245844403", "1", "2"));
        for (String output : new String[] {"1|2|0.000000000", "1|3|1792210297.245844403",
                "2|2|1792210297.245844403", "1|2|1792210297.2", "1|2|not-a-time",
                "1|2|999999999999999999999999.000000001", "1|2|1792210297.245844403|extra"}) {
            assertThrows(IOException.class, () -> MacOsHostIdentity.parseBirthTime(output, "1", "2"));
        }
    }

    @Test
    void refusesMissingMalformedZeroOrAmbiguousHardwareIdentity() {
        for (String output : new String[] {"", "\"IOPlatformUUID\" = \"unknown\"",
                "\"IOPlatformUUID\" = \"00000000-0000-0000-0000-000000000000\"",
                "\"IOPlatformUUID\" = \"" + UUID + "\"\n\"IOPlatformUUID\" = \"" + UUID + "\""}) {
            assertThrows(IOException.class, () -> MacOsHostIdentity.parseMachineId(output));
        }
    }

    @EnabledOnOs({OS.MAC, OS.LINUX})
    @Test
    void refusesFailedProbes() {
        assertThrows(IOException.class, () -> MacOsHostIdentity.read("/usr/bin/false"));
        assertThrows(IOException.class, () -> MacOsHostIdentity.read("/qwen-missing-native-probe"));
    }

    @EnabledOnOs({OS.MAC, OS.LINUX})
    @Timeout(10)
    @Test
    void timesOutAndStopsAnUnresponsiveProbe() {
        MacOsIdentityProbeTimeoutException timeout = assertThrows(
                MacOsIdentityProbeTimeoutException.class,
                () -> MacOsHostIdentity.read("/bin/sleep", "20"));
        assertEquals("macOS native identity probe timed out", timeout.getMessage());
    }

    @EnabledOnOs(OS.MAC)
    @Test
    void readsStableNativeHardwareAndBootIdentity() throws Exception {
        String machine = MacOsHostIdentity.machineId();
        assertTrue(machine.matches("[0-9a-fA-F-]{36}"));
        assertEquals(machine, MacOsHostIdentity.machineId());
        String boot = MacOsHostIdentity.bootId();
        assertTrue(boot.matches("[0-9a-f-]{36}"));
        assertEquals(boot, MacOsHostIdentity.bootId());
    }
}
