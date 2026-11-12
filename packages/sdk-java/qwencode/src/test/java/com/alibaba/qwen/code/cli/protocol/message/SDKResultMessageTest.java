package com.alibaba.qwen.code.cli.protocol.message;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import org.junit.jupiter.api.Test;

/**
 * The provider HTTP status reaches the Java POJO only through fastjson2's
 * field-name mapping, so the wire name and the nested {@code Error} field are
 * asserted here rather than inferred from the getter.
 */
class SDKResultMessageTest {

    @Test
    void readsTheProviderStatusFromAnErrorResultEnvelope() {
        String line = "{\"type\":\"result\",\"subtype\":\"error_during_execution\","
                + "\"is_error\":true,\"error\":{\"message\":\"429 Too Many Requests\","
                + "\"status\":429}}";
        JSONObject jsonObject = JSON.parseObject(line);
        SDKResultMessage message = jsonObject.to(SDKResultMessage.class);

        assertNotNull(message.getError());
        assertEquals(429, message.getError().getStatus());
        assertEquals("429 Too Many Requests", message.getError().getMessage());
    }

    @Test
    void leavesTheStatusUnsetWhenTheEnvelopeOmitsIt() {
        String line = "{\"type\":\"result\",\"subtype\":\"error_during_execution\","
                + "\"is_error\":true,\"error\":{\"message\":\"Socket closed\"}}";
        JSONObject jsonObject = JSON.parseObject(line);
        SDKResultMessage message = jsonObject.to(SDKResultMessage.class);

        assertNotNull(message.getError());
        assertNull(message.getError().getStatus());
    }
}
