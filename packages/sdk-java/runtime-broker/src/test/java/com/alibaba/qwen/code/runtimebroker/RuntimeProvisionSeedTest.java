package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

class RuntimeProvisionSeedTest {
    @Test
    void decodesAnEpochOnlyWhenItIsAnExactInteger() {
        for (String epoch : List.of("4", "4.0")) {
            assertEquals(4, RuntimeProvisionSeed.decode(seed(epoch)).getEpoch(),
                    epoch);
        }
        // Each literal would read as epoch 4.
        for (String epoch : List.of("4.0000000000000001",
                "40000000000000001E-16", "4.0000000000000001D", "65540S")) {
            IllegalStateException failure = assertThrows(
                    IllegalStateException.class,
                    () -> RuntimeProvisionSeed.decode(seed(epoch)), epoch);
            assertEquals("Runtime provision seed is invalid",
                    failure.getMessage(), epoch);
        }
    }

    private static byte[] seed(String epoch) {
        return ("{\"provisionRequestId\":\"provision-1\","
                + "\"provisionalRuntimeId\":\"runtime-1\","
                + "\"gatewayIncarnation\":\"boot-1\",\"leaseId\":\"lease-1\","
                + "\"epoch\":" + epoch + ",\"token\":\"token-1\"}")
                .getBytes(StandardCharsets.UTF_8);
    }
}
