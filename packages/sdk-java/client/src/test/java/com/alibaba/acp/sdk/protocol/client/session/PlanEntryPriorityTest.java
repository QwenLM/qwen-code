package com.alibaba.acp.sdk.protocol.client.session;

import com.alibaba.acp.sdk.protocol.domain.plan.PlanEntryPriority;
import com.alibaba.fastjson2.JSON;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class PlanEntryPriorityTest {

    @Test
    public void testJson() {
        PlanEntryPriority priority = PlanEntryPriority.HIGH;
        assertEquals("\"high\"", JSON.toJSONString(priority));
        assertEquals(PlanEntryPriority.HIGH, JSON.parseObject("\"high\"", PlanEntryPriority.class));

        priority = PlanEntryPriority.MEDIUM;
        assertEquals("\"medium\"", JSON.toJSONString(priority));
        assertEquals(PlanEntryPriority.MEDIUM, JSON.parseObject("\"medium\"", PlanEntryPriority.class));

        priority = PlanEntryPriority.LOW;
        assertEquals("\"low\"", JSON.toJSONString(priority));
        assertEquals(PlanEntryPriority.LOW, JSON.parseObject("\"low\"", PlanEntryPriority.class));
    }

}
