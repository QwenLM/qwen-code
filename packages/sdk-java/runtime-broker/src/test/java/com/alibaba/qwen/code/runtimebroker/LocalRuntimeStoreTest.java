package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class LocalRuntimeStoreTest {
    @Test
    void malformedHostIdentityFailsClosedNamingSourcesAndBothOptOuts() {
        IllegalStateException error = assertThrows(IllegalStateException.class,
                () -> LocalRuntimeStore.HostIdentity.of("",
                        "ffffffff-ffff-ffff-ffff-ffffffffffff", "pid:[1]", "time:[1]"));
        assertTrue(error.getMessage().contains("host/boot identity is unavailable"), error::getMessage);
        assertTrue(error.getMessage().contains("/etc/machine-id"), error::getMessage);
        assertTrue(error.getMessage().contains("QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS"),
                error::getMessage);
        assertTrue(error.getMessage().contains("QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY"),
                error::getMessage);
    }

    @Test
    void unresolvableBrokerUserNamesItselfAndTheOptOut(
            @org.junit.jupiter.api.io.TempDir Path directory) {
        String user = System.getProperty("user.name");
        System.setProperty("user.name", "qwen-unresolvable-user-4242");
        try {
            IllegalStateException error = assertThrows(IllegalStateException.class,
                    () -> new LocalRuntimeStore(directory.resolve("state"),
                            DurableLocalProcessRuntimeProvisionerTest.HOST));
            assertTrue(error.getMessage().contains("qwen-unresolvable-user-4242"), error::getMessage);
            assertTrue(error.getMessage().contains("QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS"),
                    error::getMessage);
        } finally {
            System.setProperty("user.name", user);
        }
    }
}
