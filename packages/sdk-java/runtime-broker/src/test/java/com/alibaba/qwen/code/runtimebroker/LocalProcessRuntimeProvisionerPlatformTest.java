package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

class LocalProcessRuntimeProvisionerPlatformTest {
    @TempDir
    Path temporary;

    @Test
    @EnabledOnOs(OS.WINDOWS)
    void refusesToStartOnWindows() {
        Path root = temporary.toAbsolutePath();
        RuntimeBrokerException error = assertThrows(
                RuntimeBrokerException.class,
                () -> new LocalProcessRuntimeProvisioner(
                        root.resolve("state"), root.resolve("node.exe"),
                        root.resolve("worker.js"), root.resolve("cli.js"),
                        Map.of()));

        assertEquals("runtime_broker_platform_unsupported", error.getCode());
        assertFalse(error.isRetryable());
    }
}
