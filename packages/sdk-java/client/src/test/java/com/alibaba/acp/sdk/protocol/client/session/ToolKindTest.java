package com.alibaba.acp.sdk.protocol.client.session;

import com.alibaba.acp.sdk.protocol.domain.tool.ToolKind;
import com.alibaba.fastjson2.JSON;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class ToolKindTest {

    @Test
    public void testJson() {
        ToolKind kind = ToolKind.READ;
        assertEquals("\"read\"", JSON.toJSONString(kind));
        assertEquals(ToolKind.READ, JSON.parseObject("\"read\"", ToolKind.class));

        kind = ToolKind.EDIT;
        assertEquals("\"edit\"", JSON.toJSONString(kind));
        assertEquals(ToolKind.EDIT, JSON.parseObject("\"edit\"", ToolKind.class));

        kind = ToolKind.DELETE;
        assertEquals("\"delete\"", JSON.toJSONString(kind));
        assertEquals(ToolKind.DELETE, JSON.parseObject("\"delete\"", ToolKind.class));

        kind = ToolKind.MOVE;
        assertEquals("\"move\"", JSON.toJSONString(kind));
        assertEquals(ToolKind.MOVE, JSON.parseObject("\"move\"", ToolKind.class));

        kind = ToolKind.SEARCH;
        assertEquals("\"search\"", JSON.toJSONString(kind));
        assertEquals(ToolKind.SEARCH, JSON.parseObject("\"search\"", ToolKind.class));

        kind = ToolKind.EXECUTE;
        assertEquals("\"execute\"", JSON.toJSONString(kind));
        assertEquals(ToolKind.EXECUTE, JSON.parseObject("\"execute\"", ToolKind.class));

        kind = ToolKind.THINK;
        assertEquals("\"think\"", JSON.toJSONString(kind));
        assertEquals(ToolKind.THINK, JSON.parseObject("\"think\"", ToolKind.class));

        kind = ToolKind.FETCH;
        assertEquals("\"fetch\"", JSON.toJSONString(kind));
        assertEquals(ToolKind.FETCH, JSON.parseObject("\"fetch\"", ToolKind.class));

        kind = ToolKind.SWITCH_MODE;
        assertEquals("\"switch_mode\"", JSON.toJSONString(kind));
        assertEquals(ToolKind.SWITCH_MODE, JSON.parseObject("\"switch_mode\"", ToolKind.class));

        kind = ToolKind.OTHER;
        assertEquals("\"other\"", JSON.toJSONString(kind));
        assertEquals(ToolKind.OTHER, JSON.parseObject("\"other\"", ToolKind.class));
    }

}
