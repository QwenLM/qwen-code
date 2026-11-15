package com.alibaba.qwen.code.daemon;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** The portable, Session-scoped permission-rules/1 contract. */
public final class HostedPermissionRules {
    private static final Set<String> KEYS = Set.of("allow", "ask", "deny");
    private static final Set<String> SHELL = Set.of("Bash", "Shell", "ShellTool", "run_shell_command", "monitor", "Monitor", "MonitorTool");
    private static final Set<String> WEB = Set.of("WebFetch", "WebFetchTool", "web_fetch");
    private static final Pattern TOOL = Pattern.compile("[A-Za-z_][A-Za-z0-9_.:-]*");
    private static final Pattern MCP = Pattern.compile("mcp__[A-Za-z0-9_.:-]+(?:__[A-Za-z0-9_.:-]+)?\\*?");
    private static final Pattern DOMAIN = Pattern.compile("domain:(?:\\*\\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?");

    private HostedPermissionRules() {
    }

    /** Validate and snapshot rules without changing their spelling or order. */
    public static Map<String, List<String>> copyOf(Map<?, ?> rules) {
        if (rules == null) {
            return null;
        }
        if (!rules.keySet().equals(KEYS)) {
            throw invalid();
        }
        Map<String, List<String>> result = new LinkedHashMap<>();
        int total = 0;
        for (String kind : List.of("allow", "ask", "deny")) {
            Object raw = rules.get(kind);
            if (!(raw instanceof List) || ((List<?>) raw).size() > 32) {
                throw invalid();
            }
            List<String> values = new ArrayList<>();
            Set<String> unique = new HashSet<>();
            for (Object value : (List<?>) raw) {
                if (!(value instanceof String) || !validRule((String) value) || !unique.add((String) value)) {
                    throw invalid();
                }
                values.add((String) value);
            }
            total += values.size();
            result.put(kind, Collections.unmodifiableList(values));
        }
        if (total > 64 || JsonSupport.encode(result).getBytes(StandardCharsets.UTF_8).length > 8192) {
            throw invalid();
        }
        return Collections.unmodifiableMap(result);
    }

    /** Empty rules are omitted from admission payloads and read responses. */
    public static Map<String, List<String>> nonEmpty(Map<String, List<String>> rules) {
        return rules == null || rules.values().stream().allMatch(List::isEmpty) ? null : rules;
    }

    private static boolean validRule(String rule) {
        if (rule.isEmpty() || !trimmed(rule) || rule.codePoints().anyMatch(Character::isISOControl)
                || rule.getBytes(StandardCharsets.UTF_8).length > 512) {
            return false;
        }
        int open = rule.indexOf('(');
        if (open < 0) {
            return rule.startsWith("mcp__") ? MCP.matcher(rule).matches() : TOOL.matcher(rule).matches();
        }
        if (!rule.endsWith(")")) {
            return false;
        }
        String tool = rule.substring(0, open);
        String specifier = rule.substring(open + 1, rule.length() - 1);
        if (specifier.isEmpty() || !trimmed(specifier)) {
            return false;
        }
        return SHELL.contains(tool) || WEB.contains(tool) && DOMAIN.matcher(specifier).matches();
    }

    private static boolean trimmed(String value) {
        int first = value.codePointAt(0);
        int last = value.codePointBefore(value.length());
        return !space(first) && !space(last);
    }

    private static boolean space(int value) {
        return Character.isWhitespace(value) || Character.isSpaceChar(value) || value == 0xfeff;
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Invalid portable permission rules");
    }
}
