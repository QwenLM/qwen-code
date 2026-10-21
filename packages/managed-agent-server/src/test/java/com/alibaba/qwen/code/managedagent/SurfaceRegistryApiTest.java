package com.alibaba.qwen.code.managedagent.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.util.Set;
import java.util.TreeSet;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The Managed control plane each route sits on (issue #15075): every public
 * and WebShell registry route is described by the published OpenAPI document,
 * and no documented route is missing from the registry. The internal writer
 * surface is deliberately outside the public contract, so it is
 * registry-only.
 *
 * <p>Reads the document itself rather than {@code OpenApiContract}, which is
 * package-private to {@code managedagent}; the route key is all this needs.
 */
class SurfaceRegistryApiTest {

    private static final String SPEC =
            "openapi/managed-agent-public-api.openapi.json";
    private static final String WEB_SHELL = "/api/agent/web-shell/v1/";
    private static final Set<String> METHODS =
            Set.of("get", "put", "post", "patch", "delete");

    @Test
    void everyPublicAndWebShellRouteIsInTheApiContract() throws IOException {
        Set<String> documented = documentedRoutes();
        assertThat(documented).isNotEmpty();
        Set<String> missing = new TreeSet<>();
        for (SurfaceRegistry entry : SurfaceRegistry.values()) {
            if (entry.surface() == SurfaceRegistry.Surface.INTERNAL) {
                continue;
            }
            if (!documented.contains(entry.routeKey())) {
                missing.add(entry.routeKey());
            }
        }
        assertThat(missing).isEmpty();
    }

    @Test
    void everyDocumentedRouteIsServedByTheRegistry() throws IOException {
        Set<String> registered = new TreeSet<>();
        for (SurfaceRegistry entry : SurfaceRegistry.values()) {
            registered.add(entry.routeKey());
        }
        Set<String> unserved = documentedRoutes();
        unserved.removeAll(registered);
        assertThat(unserved).isEmpty();
    }

    /**
     * Document routes spelled as the registry spells them. The WebShell
     * operations declare one method each; the registry spells them POST.
     */
    private static Set<String> documentedRoutes() throws IOException {
        JsonNode paths;
        try (InputStream input = SurfaceRegistryApiTest.class.getClassLoader()
                .getResourceAsStream(SPEC)) {
            assertThat(input).isNotNull();
            paths = new ObjectMapper().readTree(input).get("paths");
        }
        Set<String> routes = new TreeSet<>();
        for (var path : paths.properties()) {
            String template = path.getKey();
            if (!template.startsWith("/v1/")
                    && !template.startsWith(WEB_SHELL)) {
                continue;
            }
            for (var operation : path.getValue().properties()) {
                if (!METHODS.contains(operation.getKey())) {
                    continue;
                }
                String method = template.startsWith(WEB_SHELL)
                        ? "POST"
                        : operation.getKey().toUpperCase();
                routes.add(method + " " + template);
            }
        }
        return routes;
    }
}
