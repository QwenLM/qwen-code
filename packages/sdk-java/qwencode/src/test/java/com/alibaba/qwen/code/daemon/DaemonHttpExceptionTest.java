package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import org.junit.jupiter.api.Test;

class DaemonHttpExceptionTest {
    @Test
    void readsCodeAndReasonFromAJsonErrorBody() {
        DaemonHttpException error = new DaemonHttpException("load", 409,
                "{\"error\":\"hosted_turn_recovery_declined\","
                        + "\"code\":\"hosted_turn_recovery_declined\","
                        + "\"reason\":\"shell_in_flight\"}");
        assertEquals("hosted_turn_recovery_declined", error.getErrorCode());
        assertEquals("shell_in_flight", error.getBodyField("reason"));
        assertNull(error.getBodyField("missing"));
    }

    @Test
    void toleratesNonJsonAndEmptyBodies() {
        DaemonHttpException empty = new DaemonHttpException("load", 503, "");
        assertNull(empty.getErrorCode());
        assertNull(empty.getBodyField("reason"));
        DaemonHttpException text = new DaemonHttpException("load", 502,
                "Bad Gateway");
        assertNull(text.getErrorCode());
        DaemonHttpException wrongShape = new DaemonHttpException("load", 409,
                "{\"code\":409}");
        assertNull(wrongShape.getErrorCode());
    }
}
