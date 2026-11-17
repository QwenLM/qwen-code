package com.alibaba.qwen.code.daemon;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class HostedPermissionRulesTest {
    @Test
    void acceptsPortableRulesAndSnapshotsCallerOwnedLists() {
        var allow = new ArrayList<>(List.of("Read", "run_shell_command", "Bash(npm test*)", "monitor(echo (hello))",
                "mcp__docs__*", "WebFetch(domain:*.example.com)"));
        var rules = HostedPermissionRules.copyOf(Map.of("allow", allow, "ask", List.of("Write"), "deny", List.of("Bash(rm *)")));
        allow.clear();
        assertEquals(6, rules.get("allow").size());
        assertThrows(UnsupportedOperationException.class, () -> rules.get("allow").clear());
        assertThrows(UnsupportedOperationException.class, rules::clear);
        assertNull(HostedPermissionRules.nonEmpty(HostedPermissionRules.copyOf(empty())));
    }

    @Test
    void rejectsPathPredicatesUnknownShapesDuplicatesAndWhitespace() {
        for (String invalid : List.of("", " Read", "Read ", "Read(/tmp/**)", "Skill(name:build)", "Bash()",
                "WebFetch(domain:https://example.com)", "mcp__docs*__tool", "Bash(echo hi)\n", "Read\u00a0")) {
            assertThrows(IllegalArgumentException.class,
                    () -> HostedPermissionRules.copyOf(Map.of("allow", List.of(invalid), "ask", List.of(), "deny", List.of())));
        }
        assertThrows(IllegalArgumentException.class, () -> HostedPermissionRules.copyOf(Map.of("allow", List.of("Read"))));
        assertThrows(IllegalArgumentException.class, () -> HostedPermissionRules.copyOf(Map.of("allow", List.of(true), "ask", List.of(), "deny", List.of())));
        assertThrows(IllegalArgumentException.class, () -> HostedPermissionRules.copyOf(Map.of("allow", List.of("Read", "Read"), "ask", List.of(), "deny", List.of())));
    }

    @Test
    void boundsUtf8SizeAndTheWholePolicy() {
        assertThrows(IllegalArgumentException.class, () -> HostedPermissionRules.copyOf(
                Map.of("allow", List.of("Bash(" + "中".repeat(170) + ")"), "ask", List.of(), "deny", List.of())));
        var many = IntStream.range(0, 33).mapToObj(value -> "tool_" + value).collect(Collectors.toList());
        assertThrows(IllegalArgumentException.class, () -> HostedPermissionRules.copyOf(Map.of("allow", many, "ask", List.of(), "deny", List.of())));
        var limit = many.subList(0, 32);
        assertThrows(IllegalArgumentException.class, () -> HostedPermissionRules.copyOf(Map.of("allow", limit, "ask", limit, "deny", List.of("Read"))));
        var longRules = IntStream.range(0, 32).mapToObj(value -> "Bash(" + "a".repeat(250) + value + ")").collect(Collectors.toList());
        assertThrows(IllegalArgumentException.class, () -> HostedPermissionRules.copyOf(Map.of("allow", longRules, "ask", List.of(), "deny", List.of())));
    }

    private Map<String, List<String>> empty() {
        return Map.of("allow", List.of(), "ask", List.of(), "deny", List.of());
    }
}
