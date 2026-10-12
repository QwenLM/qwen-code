package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The Stage H5 channel contract must exist in the OpenAPI resource above all
 * else: the route gate proves only that mapped routes are not planned, so
 * nothing latched whether the channel definitions were present at all — the
 * merge that discarded them stayed green. This gate refuses that regression
 * directly, and since H5b/H5c pins the three resources as partial: served,
 * with their H5-owned shapes, by the channel controller.
 */
class ChannelContractTest {

    private static final JsonNode CONTRACT = loadSpec();

    private static JsonNode loadSpec() {
        try (InputStream input = OpenApiContract.class.getClassLoader()
                .getResourceAsStream(
                        "openapi/managed-agent-public-api.openapi.json")) {
            return new ObjectMapper().readTree(input);
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }

    private static final List<String> PATHS = List.of(
            "/v1/agent-channels",
            "/v1/agent-channels/{channelId}/deliveries",
            "/v1/agent-channels/{channelId}/deliveries/{deliveryId}");

    private static final List<String> SCHEMAS = List.of(
            "ChannelConnectionState",
            "ChannelRouteState",
            "ChannelDeliveryState",
            "PublicChannelRoute",
            "PublicChannel",
            "PublicChannelList",
            "PublicChannelDelivery",
            "PublicChannelDeliveryList");

    @Test
    void channelRoutesExistAndArePartial() {
        for (String path : PATHS) {
            JsonNode route = CONTRACT.get("paths").get(path);
            assertThat(route != null && route.isObject())
                    .as("The Stage H5 route %s exists", path)
                    .isTrue();
            JsonNode status = route.at("/get/x-qwen-implementation-status");
            assertThat(status.isTextual()
                    && "partial".equals(status.textValue()))
                    .as("%s is served as partial", path)
                    .isTrue();
        }
    }

    @Test
    void channelSchemasExistAndArePartial() {
        for (String name : SCHEMAS) {
            JsonNode schema = CONTRACT.at("/components/schemas/" + name);
            assertThat(schema.isObject())
                    .as("Schema %s exists", name)
                    .isTrue();
            JsonNode status = schema.at("/x-qwen-implementation-status");
            assertThat(status.isTextual()
                    && "partial".equals(status.textValue()))
                    .as("%s is served as partial", name)
                    .isTrue();
        }
    }

    @Test
    void listRoutesCarryTheirResponseShapes() {
        assertThat(CONTRACT.get("paths").get("/v1/agent-channels")
                        .get("get").get("responses").get("200")
                        .get("content").isContainerNode())
                .as("the channel list returns a schema, not a name only")
                .isTrue();
        assertThat(CONTRACT.get("paths")
                        .get("/v1/agent-channels/{channelId}/deliveries")
                        .get("get").get("responses").get("200")
                        .get("content").isContainerNode())
                .as("the deliveries list returns a schema, not a name only")
                .isTrue();
    }
}
