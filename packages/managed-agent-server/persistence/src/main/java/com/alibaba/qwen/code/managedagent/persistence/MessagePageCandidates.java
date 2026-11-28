package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRef;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The message page's metadata-only lookahead, split from the projection. */
final class MessagePageCandidates {
    private MessagePageCandidates() {}

    static List<AgentMessageProjection.MessageSize> find(JdbcTemplate jdbc, String tenantId,
            String sessionId, AgentMessageProjection.MessagePosition position,
            boolean numericBoundary, long afterSequence, int limit) {
        String comparison = position.backward() ? "<" : ">";
        String order = position.backward() ? " DESC" : " ASC";
        List<Object> pageArguments = new ArrayList<>(List.of(tenantId, sessionId, position.through()));
        if (numericBoundary) {
            pageArguments.add(afterSequence);
        }
        pageArguments.addAll(List.of(position.sequence(), position.sequence(),
                position.item(), limit + 1));
        List<Candidate> raw = jdbc.query(
                "SELECT m.item_id, m.first_sequence, m.body_resource_ref,"
                        + " OCTET_LENGTH(m.attributes_json) + OCTET_LENGTH(m.parts_json) AS inline_length,"
                        // H2's MySQL-mode REPEATABLE READ snapshots each table at its
                        // first access in the transaction; the body reads below must
                        // see the same cut as these message rows, so open ma_resource
                        // inside this statement. The predicate is always false.
                        + " (SELECT COUNT(*) FROM ma_resource WHERE tenant_id = m.tenant_id"
                        + " AND session_id = m.session_id AND 1 = 0) AS resource_snapshot"
                        + " FROM ma_message m"
                        + " WHERE m.tenant_id = ? AND m.session_id = ? AND m.first_sequence <= ?"
                        + (numericBoundary ? " AND m.first_sequence > ?" : "")
                        + " AND (m.first_sequence " + comparison + " ? OR (m.first_sequence = ? AND m.item_id "
                        + comparison + " ?)) ORDER BY m.first_sequence" + order + ", m.item_id" + order + " LIMIT ?",
                (row, index) -> new Candidate(row.getString("item_id"), row.getLong("first_sequence"),
                        row.getString("body_resource_ref"), row.getLong("inline_length")),
                pageArguments.toArray());
        // The body resource ref decodes to the raw resource id; its inline bytes
        // add to the item's own metadata length, exactly as the former join did.
        Map<String, Long> bodyBytes = messageBodyBytes(jdbc, tenantId, sessionId,
                raw.stream().map(Candidate::resourceRef).toList());
        return raw.stream()
                .map(candidate -> new AgentMessageProjection.MessageSize(candidate.id(), candidate.sequence(),
                        candidate.inlineLength() + (candidate.resourceRef() == null ? 0L
                                : bodyBytes.getOrDefault(candidate.resourceRef(), 0L))))
                .toList();
    }

    private record Candidate(String id, long sequence, String resourceRef, long inlineLength) {}

    /** Inline body bytes of the referenced resources, keyed by body resource ref. */
    private static Map<String, Long> messageBodyBytes(JdbcTemplate jdbc, String tenantId,
            String sessionId, List<String> refs) {
        List<String> present = refs.stream().filter(ref -> ref != null).distinct().toList();
        if (present.isEmpty()) {
            return Map.of();
        }
        Map<String, String> resourceIds = new LinkedHashMap<>();
        List<Object> arguments = new ArrayList<>(List.of(tenantId, sessionId));
        for (String ref : present) {
            String resourceId = ManagedIdentityRef.decode(
                    ref.getBytes(StandardCharsets.US_ASCII)).get(2);
            resourceIds.put(ref, resourceId);
            arguments.add(resourceId);
        }
        Map<String, Long> byResource = new HashMap<>();
        jdbc.query("SELECT resource_id, COALESCE(OCTET_LENGTH(inline_bytes), 0) AS body_length FROM ma_resource"
                        + " WHERE tenant_id = ? AND session_id = ? AND resource_id IN ("
                        + AgentStoreRows.placeholders(present.size()) + ")",
                (RowCallbackHandler) row -> byResource.put(row.getString("resource_id"), row.getLong("body_length")),
                arguments.toArray());
        Map<String, Long> result = new HashMap<>();
        resourceIds.forEach((ref, resourceId) -> result.put(ref, byResource.getOrDefault(resourceId, 0L)));
        return result;
    }
}
