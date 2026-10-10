package com.alibaba.qwen.code.managedagent.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The A2/A3 arms of the D6 gate, committed as the permanent proof that the
 * correspondence test fails close: this boot mounts the same route set the
 * positive gate boots plus one extra controller route that
 * {@link SurfaceRegistry} does not register, so the mounted-without-entry
 * drift message must name it alone; the synthetic sets pin the
 * registered-without-handler arm.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:surface-gate-negative;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.session-store.enabled=true",
        "qwen.managed-agent.tool-publication.entry-concurrency=4"
})
@Import({SurfaceRegistryGateNegativeTest.ProbeController.class,
        SurfaceRegistryGateTest.ExtraControllers.class})
class SurfaceRegistryGateNegativeTest {
    @Autowired
    private ApplicationContext context;

    @Test
    void anUnregisteredMountedRouteFailsTheGateNamingTheRoute() {
        Set<String> mounted = SurfaceRegistryGateTest.moduleRoutes(context);
        Map<String, String> drift = SurfaceRegistryGateTest.drift(mounted);
        assertThat(drift).hasSize(2);
        assertThat(drift.keySet())
                .anySatisfy(route -> assertThat(route)
                        .contains("GET /v1/agents/__surface_gate_probe__")
                        .contains("mounted by a controller")
                        .contains("missing from SurfaceRegistry"))
                .anySatisfy(route -> assertThat(route)
                        // A method-level @RequestMapping with no method
                        // attribute mounts every HTTP method and must not
                        // pass the scan silently.
                        .contains("* /v1/agents/__surface_gate_probe_any__")
                        .contains("mounted by a controller")
                        .contains("missing from SurfaceRegistry"));
    }

    @Test
    void aRegisteredRouteWithoutAHandlerFailsTheGateNamingTheRoute() {
        Set<String> mounted = new TreeSet<>();
        for (SurfaceRegistry entry : SurfaceRegistry.values()) {
            mounted.add(entry.routeKey());
        }
        String removed = SurfaceRegistry.PUBLIC_SESSION_GET.routeKey();
        mounted.remove(removed);
        Map<String, String> drift = SurfaceRegistryGateTest.drift(mounted);
        assertThat(drift).hasSize(1);
        assertThat(drift.keySet().iterator().next())
                .contains(removed)
                .contains("no controller mounts it");
    }

    @RestController
    static class ProbeController {
        @GetMapping("/v1/agents/__surface_gate_probe__")
        public String probe() {
            return "probe";
        }

        @RequestMapping("/v1/agents/__surface_gate_probe_any__")
        public String probeAny() {
            return "probe-any";
        }
    }
}
