package com.alibaba.acp.sdk.protocol.client.session;

import com.alibaba.acp.sdk.protocol.domain.session.StopReason;
import com.alibaba.fastjson2.JSON;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class StopReasonTest {

    @Test
    public void testJson() {
        StopReason reason = StopReason.END_TURN;
        assertEquals("\"end_turn\"", JSON.toJSONString(reason));
        assertEquals(StopReason.END_TURN, JSON.parseObject("\"end_turn\"", StopReason.class));

        reason = StopReason.MAX_TOKENS;
        assertEquals("\"max_tokens\"", JSON.toJSONString(reason));
        assertEquals(StopReason.MAX_TOKENS, JSON.parseObject("\"max_tokens\"", StopReason.class));

        reason = StopReason.MAX_TURN_REQUESTS;
        assertEquals("\"max_turn_requests\"", JSON.toJSONString(reason));
        assertEquals(StopReason.MAX_TURN_REQUESTS, JSON.parseObject("\"max_turn_requests\"", StopReason.class));

        reason = StopReason.REFUSAL;
        assertEquals("\"refusal\"", JSON.toJSONString(reason));
        assertEquals(StopReason.REFUSAL, JSON.parseObject("\"refusal\"", StopReason.class));

        reason = StopReason.CANCELLED;
        assertEquals("\"cancelled\"", JSON.toJSONString(reason));
        assertEquals(StopReason.CANCELLED, JSON.parseObject("\"cancelled\"", StopReason.class));
    }

}
