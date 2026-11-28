package com.alibaba.qwen.code.cli.protocol.message;

import com.alibaba.fastjson2.JSONObject;
import com.alibaba.fastjson2.JSONReader.Feature;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The Java half of the error-status contract: a result line that names a
 * provider status has to reach the caller, and the decode below is the one
 * {@code Session} uses.
 */
class SDKResultMessageTest {

    /** Exactly the shape the CLI writes: a boolean flag plus the nested object. */
    private static JSONObject errorEnvelope(Object error) {
        JSONObject envelope = new JSONObject();
        envelope.put("type", "result");
        envelope.put("subtype", "success");
        envelope.put("is_error", true);
        envelope.put("error", error);
        return envelope;
    }

    private static SDKResultMessage decode(JSONObject envelope) {
        return envelope.to(SDKResultMessage.class, Feature.FieldBased);
    }

    @Test
    void keepsTheProviderStatusOnTheNestedError() {
        JSONObject error = new JSONObject();
        error.put("message", "429 Too Many Requests");
        error.put("status", 429);

        SDKResultMessage message = decode(errorEnvelope(error));

        assertTrue(message.isError());
        assertNotNull(message.getError());
        assertEquals(429, message.getError().getStatus());
        assertEquals("429 Too Many Requests", message.getError().getMessage());
    }

    @Test
    void leavesTheStatusAbsentWhenTheEnvelopeNamesNone() {
        JSONObject error = new JSONObject();
        error.put("message", "provider refused");

        SDKResultMessage message = decode(errorEnvelope(error));

        assertNotNull(message.getError());
        assertNull(message.getError().getStatus());
    }
}
