package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

// Pins CarrierCount's base-10 read of the scheduler property: the JDK
// parses jdk.virtualThreadScheduler.parallelism base-10 while
// Integer.getInteger resolves through Integer.decode, so "0100" must
// read as 100 — an under-read fleet is the one error direction no
// pinning witness can detect. A malformed value must throw
// NumberFormatException: the JDK's own scheduler init reads the property
// with a bare parseInt and dies there, so a lenient read would only
// mis-size fleets in a JVM that cannot run a witness. The property is
// restored after each test because surefire reuses one fork for the
// module and the witnesses size their fleets from CarrierCount.resolve()
// at call time.
final class CarrierCountTest {
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
        assertEquals(100, CarrierCount.resolve());
    }

    @Test
    void throwsOnMalformedValuesLikeTheJdkDoes() {
        System.setProperty(KEY, " 8 ");
        assertThrows(NumberFormatException.class,
                () -> CarrierCount.resolve());
        System.setProperty(KEY, "abc");
        assertThrows(NumberFormatException.class,
                () -> CarrierCount.resolve());
    }

    @Test
    void fallsBackToTheProcessorCount() {
        System.clearProperty(KEY);
        assertEquals(Runtime.getRuntime().availableProcessors(),
                CarrierCount.resolve());
    }
}
