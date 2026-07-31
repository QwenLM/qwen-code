package com.alibaba.acp.sdk.protocol.client.session;

import com.alibaba.acp.sdk.protocol.domain.plan.PlanEntryStatus;
import com.alibaba.fastjson2.JSON;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class PlanEntryStatusTest {

    @Test
    public void testJson() {
        PlanEntryStatus status = PlanEntryStatus.PENDING;
        assertEquals("\"pending\"", JSON.toJSONString(status));
        assertEquals(PlanEntryStatus.PENDING, JSON.parseObject("\"pending\"", PlanEntryStatus.class));

        status = PlanEntryStatus.IN_PROGRESS;
        assertEquals("\"in_progress\"", JSON.toJSONString(status));
        assertEquals(PlanEntryStatus.IN_PROGRESS, JSON.parseObject("\"in_progress\"", PlanEntryStatus.class));

        status = PlanEntryStatus.COMPLETED;
        assertEquals("\"completed\"", JSON.toJSONString(status));
        assertEquals(PlanEntryStatus.COMPLETED, JSON.parseObject("\"completed\"", PlanEntryStatus.class));
    }

}
