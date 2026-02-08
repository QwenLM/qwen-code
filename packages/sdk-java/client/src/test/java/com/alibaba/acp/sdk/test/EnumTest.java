package com.alibaba.acp.sdk.test;

import com.alibaba.acp.sdk.protocol.domain.plan.PlanEntryStatus;
import com.alibaba.fastjson2.JSON;

public class EnumTest {
    public static void main(String[] args) {
        // Test PlanEntryStatus enum
        PlanEntryStatus status = PlanEntryStatus.PENDING;
        String json = JSON.toJSONString(status);
        System.out.println("JSON output: " + json);

        PlanEntryStatus parsed = JSON.parseObject("\"pending\"", PlanEntryStatus.class);
        System.out.println("Parsed enum: " + parsed);

        if ("\"pending\"".equals(json) && PlanEntryStatus.PENDING == parsed) {
            System.out.println("SUCCESS: PlanEntryStatus enum works correctly!");
        } else {
            System.out.println("FAILURE: PlanEntryStatus enum not working properly");
        }
    }
}
