package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

// Pins the witness's base-10 read of the scheduler property: the JDK
// parses jdk.virtualThreadScheduler.parallelism base-10 while
// Integer.getInteger resolves through Integer.decode, so "0100" must
// read as 100 — an under-read stream fleet is the one error direction
// the pinning witness cannot detect. runtime-broker's CarrierCountTest
// pins the same read there; this module cannot see that test tree. The
// property is restored after each test because surefire reuses one fork
// for the module and the witness sizes its fleet from carrierCount() at
// call time.
final class HarnessEventStreamCarrierCountTest {
    private static final String KEY =
            "jdk.virtualThreadScheduler.parallelism";
    private String saved;

    @BeforeEach
    void save() {
        saved = System.getProperty(KEY);
    }

    @AfterEach
    void restore() {
        if (saved == null) {
            System.clearProperty(KEY);
        } else {
            System.setProperty(KEY, saved);
        }
    }

    @Test
    void readsTheSchedulerPropertyBaseTen() {
        System.setProperty(KEY, "0100");
        // Integer.getInteger would decode this as octal 64.
        assertEquals(100, HarnessEventStreamPinningTest.carrierCount());
    }

    @Test
    void trimsBeforeParsing() {
        System.setProperty(KEY, " 8 ");
        assertEquals(8, HarnessEventStreamPinningTest.carrierCount());
    }

    @Test
    void fallsBackToTheProcessorCount() {
        int fallback =
                Math.max(1, Runtime.getRuntime().availableProcessors());
        System.setProperty(KEY, "abc");
        assertEquals(fallback, HarnessEventStreamPinningTest.carrierCount());
        System.clearProperty(KEY);
        assertEquals(fallback, HarnessEventStreamPinningTest.carrierCount());
    }
}
