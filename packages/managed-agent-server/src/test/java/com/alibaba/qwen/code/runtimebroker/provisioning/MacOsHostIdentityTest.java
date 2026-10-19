package com.alibaba.qwen.code.runtimebroker.provisioning;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;

import java.io.IOException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MacOsHostIdentityTest {
    private static final String UUID = "ABCDEF01-2345-6789-ABCD-EF0123456789";

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
        assertThrows(IOException.class, () -> MacOsHostIdentity.read("/bin/sleep", "20"));
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
