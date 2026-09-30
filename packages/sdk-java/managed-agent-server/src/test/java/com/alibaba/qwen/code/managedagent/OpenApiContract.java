package com.alibaba.qwen.code.managedagent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.AnnotationKeyword;
import com.networknt.schema.JsonMetaSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SchemaValidatorsConfig;
import com.networknt.schema.SpecVersion.VersionFlag;
import com.networknt.schema.ValidationMessage;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class OpenApiContract {
    static final String RESOURCE =
            "openapi/managed-agent-public-api.openapi.json";
    private static final Set<String> METHODS = Set.of("get", "put", "post",
            "patch", "delete");
    private static final String STATUS = "x-qwen-implementation-status";

    private final JsonNode spec;
    private final JsonSchemaFactory factory = JsonSchemaFactory.getInstance(
            VersionFlag.V202012, builder -> builder.metaSchema(JsonMetaSchema
                    .builder(JsonMetaSchema.getV202012())
                    .unknownKeywordFactory((keyword, context) ->
                            new AnnotationKeyword(keyword))
                    .build()));
    private final SchemaValidatorsConfig config = SchemaValidatorsConfig
            .builder().formatAssertionsEnabled(true).build();

    record Operation(String method, String path, String operationId,
            String status, JsonNode node) {
    }

    private OpenApiContract(JsonNode spec) {
        this.spec = spec;
    }

    static OpenApiContract load() {
        try (InputStream input = OpenApiContract.class.getClassLoader()
                .getResourceAsStream(RESOURCE)) {
            return new OpenApiContract(new ObjectMapper().readTree(input));
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }

    List<Operation> operations() {
        List<Operation> operations = new ArrayList<>();
        for (Map.Entry<String, JsonNode> path
                : spec.get("paths").properties()) {
            for (Map.Entry<String, JsonNode> method
                    : path.getValue().properties()) {
                if (METHODS.contains(method.getKey())) {
                    JsonNode node = method.getValue();
                    operations.add(new Operation(
                            method.getKey().toUpperCase(), path.getKey(),
                            node.get("operationId").asText(),
                            node.path(STATUS).asText("implemented"), node));
                }
            }
        }
        return operations;
    }

    Operation operation(String operationId) {
        return operations().stream()
                .filter(operation -> operation.operationId()
                        .equals(operationId))
                .findFirst().orElseThrow(() -> new IllegalArgumentException(
                        "Unknown operation " + operationId));
    }

    private static boolean planned(JsonNode node) {
        return "planned".equals(node.path(STATUS).asText());
    }

    Map<String, Boolean> plannedByProperty(String schemaName) {
        Map<String, Boolean> properties = new LinkedHashMap<>();
        collectProperties(spec.at("/components/schemas/" + schemaName),
                properties);
        return properties;
    }

    private void collectProperties(JsonNode schema,
            Map<String, Boolean> properties) {
        if (schema.has("$ref")) {
            collectProperties(spec.at(schema.get("$ref").asText()
                    .substring(1)), properties);
            return;
        }
        for (Map.Entry<String, JsonNode> field
                : schema.path("properties").properties()) {
            properties.merge(field.getKey(), planned(field.getValue()),
                    Boolean::logicalAnd);
        }
        for (String combinator : List.of("oneOf", "allOf")) {
            for (JsonNode member : schema.path(combinator)) {
                collectProperties(member, properties);
            }
        }
    }

    String requestPointer(Operation operation) {
        String pointer = operationPointer(operation)
                + "/requestBody/content/application~1json/schema";
        return spec.at(pointer).isMissingNode() ? null : pointer;
    }

    String responsePointer(Operation operation, int status) {
        String pointer = operationPointer(operation) + "/responses/"
                + status;
        JsonNode response = spec.at(pointer);
        if (response.has("$ref")) {
            return response.get("$ref").asText().substring(1);
        }
        return response.isMissingNode() ? null : pointer;
    }

    JsonNode node(String pointer) {
        return spec.at(pointer);
    }

    Set<ValidationMessage> validate(String pointer, JsonNode instance) {
        return factory.getSchema(SchemaLocation.of(
                "classpath:" + RESOURCE + "#" + pointer), config)
                .validate(instance);
    }

    private static String operationPointer(Operation operation) {
        return "/paths/" + operation.path().replace("~", "~0")
                .replace("/", "~1") + "/" + operation.method().toLowerCase();
    }
}
