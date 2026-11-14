package com.alibaba.qwen.code.cli.protocol.message;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.alibaba.fastjson2.JSONReader;
import org.junit.jupiter.api.Test;

/**
 * The provider HTTP status reaches the Java POJO only through fastjson2's
 * field-name mapping, so the wire name and the nested {@code Error} field are
 * asserted here rather than inferred from the getter.
 *
 * <p>Both cases decode with {@link JSONReader.Feature#FieldBased} because that
 * is how {@code Session} reads a {@code result} line. Under the default
 * setter-based binding the JSON key {@code error} resolves to
 * {@code setError(boolean)} — the {@code is_error} flag — so the nested object
 * is dropped and these assertions describe a path production never takes.
 */
class SDKResultMessageTest {

    @Test
    void readsTheProviderStatusFromAnErrorResultEnvelope() {
        String line = "{\"type\":\"result\",\"subtype\":\"error_during_execution\","
                + "\"is_error\":true,\"error\":{\"message\":\"429 Too Many Requests\","
                + "\"status\":429}}";
        JSONObject jsonObject = JSON.parseObject(line);
        SDKResultMessage message = jsonObject.to(SDKResultMessage.class, JSONReader.Feature.FieldBased);

        assertNotNull(message.getError());
        assertEquals(429, message.getError().getStatus());
        assertEquals("429 Too Many Requests", message.getError().getMessage());
    }

    @Test
    void leavesTheStatusUnsetWhenTheEnvelopeOmitsIt() {
        String line = "{\"type\":\"result\",\"subtype\":\"error_during_execution\","
                + "\"is_error\":true,\"error\":{\"message\":\"Socket closed\"}}";
        JSONObject jsonObject = JSON.parseObject(line);
        SDKResultMessage message = jsonObject.to(SDKResultMessage.class, JSONReader.Feature.FieldBased);

        assertNotNull(message.getError());
        assertNull(message.getError().getStatus());
    }
}
