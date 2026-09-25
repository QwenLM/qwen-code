package com.alibaba.qwen.code.managedagent.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

class WorkspaceSelectionTest {
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void normalizesPublicAndWebShellDirectories() throws Exception {
        assertThat(parse("""
                {"workspace_id":"ws-a","cwd_relative":"./services//api/."}
                """, false)).isEqualTo(new WorkspaceSelection("ws-a",
                "services/api"));
        assertThat(parse("""
                {"workspaceId":"ws-b"}
                """, true)).isEqualTo(new WorkspaceSelection("ws-b", "."));
        assertThat(parse("""
                {"workspace_id":"ws-a","cwd_relative":"./A file/%2e%2e"}
                """, false).cwdRelative()).isEqualTo("A file/%2e%2e");
    }

    @Test
    void validatesAndNormalizesDirectConstruction() {
        assertThat(new WorkspaceSelection("ws-a", "./services//api/.")
                .cwdRelative()).isEqualTo("services/api");
        assertThat(new WorkspaceSelection("ws-a", "😀".repeat(1024))
                .cwdRelative()).hasSize(2048);
        assertThatThrownBy(() -> new WorkspaceSelection("ws-a", "../etc"))
                .isInstanceOf(ApiException.class);
        for (String path : new String[] {"😀".repeat(1025), "a\u0085b",
                "a" + Character.MIN_HIGH_SURROGATE}) {
            assertThatThrownBy(() -> new WorkspaceSelection("ws-a", path))
                    .isInstanceOf(ApiException.class)
                    .extracting(error -> ((ApiException) error).getCode())
                    .isEqualTo("invalid_cwd");
        }
        assertThatThrownBy(() -> new WorkspaceSelection("", "."))
                .isInstanceOf(ApiException.class);
        assertThat(new WorkspaceSelection("ws-😀", ".").workspaceId())
                .isEqualTo("ws-😀");
        for (String id : new String[] {"ws-\uD800", "ws-\uDC00",
                "ws-\uD800x", "ws-\uD800\uD800\uDC00"}) {
            assertThatThrownBy(() -> new WorkspaceSelection(id, "."))
                    .isInstanceOf(ApiException.class)
                    .extracting(error -> ((ApiException) error).getCode())
                    .isEqualTo("invalid_request");
            JsonNode object = mapper.createObjectNode().put("workspace_id",
                    id);
            assertThatThrownBy(() -> WorkspaceSelection.parse(object,
                    false)).isInstanceOf(ApiException.class);
        }
    }

    @Test
    void rejectsUnknownOrMalformedSelection() throws Exception {
        for (String json : new String[] {
                "{}", "[]", "\"ws-a\"",
                "{\"workspace_id\":null}",
                "{\"workspace_id\":\"\"}",
                "{\"workspaceId\":\"ws-a\"}",
                "{\"workspace_id\":\"ws-a\",\"root\":\"/tmp\"}"
        }) {
            assertThatThrownBy(() -> parse(json, false))
                    .isInstanceOf(ApiException.class)
                    .extracting(error -> ((ApiException) error).getCode())
                    .isEqualTo("invalid_request");
        }
    }

    @Test
    void rejectsUnsafeDirectories() throws Exception {
        for (String path : new String[] {
                "", "/etc", "../a", "a/../b", "./C:/secret",
                "C:secret", "a\\b", "a\0b"
        }) {
            String json = mapper.writeValueAsString(
                    mapper.createObjectNode().put("workspace_id", "ws-a")
                            .put("cwd_relative", path));
            assertThatThrownBy(() -> parse(json, false))
                    .isInstanceOf(ApiException.class)
                    .extracting(error -> ((ApiException) error).getCode())
                    .isEqualTo("invalid_cwd");
        }
        assertThatThrownBy(() -> parse("""
                {"workspace_id":"ws-a","cwd_relative":null}
                """, false)).isInstanceOf(ApiException.class)
                .extracting(error -> ((ApiException) error).getCode())
                .isEqualTo("invalid_cwd");
    }

    private WorkspaceSelection parse(String json, boolean webShell)
            throws Exception {
        JsonNode node = mapper.readTree(json);
        return WorkspaceSelection.parse(node, webShell);
    }
}
