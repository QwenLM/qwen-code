package com.alibaba.acp.sdk.protocol.client.session;

import com.alibaba.acp.sdk.protocol.domain.tool.ToolCallStatus;
import com.alibaba.fastjson2.JSON;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class ToolCallStatusTest {

    @Test
    public void testJson() {
        ToolCallStatus status = ToolCallStatus.PENDING;
        assertEquals("\"pending\"", JSON.toJSONString(status));
        assertEquals(ToolCallStatus.PENDING, JSON.parseObject("\"pending\"", ToolCallStatus.class));

        status = ToolCallStatus.IN_PROGRESS;
        assertEquals("\"in_progress\"", JSON.toJSONString(status));
        assertEquals(ToolCallStatus.IN_PROGRESS, JSON.parseObject("\"in_progress\"", ToolCallStatus.class));

        status = ToolCallStatus.COMPLETED;
        assertEquals("\"completed\"", JSON.toJSONString(status));
        assertEquals(ToolCallStatus.COMPLETED, JSON.parseObject("\"completed\"", ToolCallStatus.class));

        status = ToolCallStatus.FAILED;
        assertEquals("\"failed\"", JSON.toJSONString(status));
        assertEquals(ToolCallStatus.FAILED, JSON.parseObject("\"failed\"", ToolCallStatus.class));
    }

}
