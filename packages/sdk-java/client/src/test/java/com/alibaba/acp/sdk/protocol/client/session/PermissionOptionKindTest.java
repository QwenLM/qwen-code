package com.alibaba.acp.sdk.protocol.client.session;

import com.alibaba.acp.sdk.protocol.domain.permission.PermissionOptionKind;
import com.alibaba.fastjson2.JSON;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class PermissionOptionKindTest {

    @Test
    public void testJson() {
        PermissionOptionKind kind = PermissionOptionKind.ALLOW_ONCE;
        assertEquals("\"allow_once\"", JSON.toJSONString(kind));
        assertEquals(PermissionOptionKind.ALLOW_ONCE, JSON.parseObject("\"allow_once\"", PermissionOptionKind.class));

        kind = PermissionOptionKind.ALLOW_ALWAYS;
        assertEquals("\"allow_always\"", JSON.toJSONString(kind));
        assertEquals(PermissionOptionKind.ALLOW_ALWAYS, JSON.parseObject("\"allow_always\"", PermissionOptionKind.class));

        kind = PermissionOptionKind.REJECT_ONCE;
        assertEquals("\"reject_once\"", JSON.toJSONString(kind));
        assertEquals(PermissionOptionKind.REJECT_ONCE, JSON.parseObject("\"reject_once\"", PermissionOptionKind.class));

        kind = PermissionOptionKind.REJECT_ALWAYS;
        assertEquals("\"reject_always\"", JSON.toJSONString(kind));
        assertEquals(PermissionOptionKind.REJECT_ALWAYS, JSON.parseObject("\"reject_always\"", PermissionOptionKind.class));
    }

}
