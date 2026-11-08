package com.alibaba.qwen.code.runtimebroker.managedschema;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Auditable inventory of replaced entities; this class never rewrites SQL. */
public final class ManagedSchemaMapping {
    private static final String RESOURCE = "/db/managed-schema/legacy-table-map.tsv";

    private ManagedSchemaMapping() {}

    public static Map<String, List<String>> inventory() {
        try (var stream = ManagedSchemaMapping.class.getResourceAsStream(RESOURCE)) {
            if (stream == null) {
                throw new IllegalStateException("Managed schema mapping resource is missing");
            }
            Map<String, List<String>> mapping = new LinkedHashMap<>();
            for (String line :
                    new String(stream.readAllBytes(), StandardCharsets.UTF_8).split("\\R")) {
                if (line.startsWith("#") || line.isBlank()) {
                    continue;
                }
                String[] pair = line.split("\\t", -1);
                if (pair.length != 2 || mapping.put(pair[0], List.of(pair[1].split(","))) != null) {
                    throw new IllegalStateException(
                            "Managed schema mapping contains an invalid or duplicate entry");
                }
            }
            return Map.copyOf(mapping);
        } catch (IOException exception) {
            throw new IllegalStateException("Managed schema mapping cannot be read", exception);
        }
    }
}
