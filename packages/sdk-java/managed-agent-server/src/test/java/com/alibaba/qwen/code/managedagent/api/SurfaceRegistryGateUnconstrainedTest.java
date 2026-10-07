package com.alibaba.qwen.code.managedagent.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Import;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The method-agnostic arm of the D6 gate: a handler mapped without a
 * {@code method} attribute matches every verb, and {@link SurfaceRegistry}
 * has no any-method entry to register it under, so the gate must surface
 * the route as drift instead of dropping it from the mounted set.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:surface-gate-unconstrained;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.session-store.enabled=true",
        "qwen.managed-agent.tool-publication.entry-concurrency=4"
})
@Import({SurfaceRegistryGateUnconstrainedTest.UnconstrainedController.class,
        SurfaceRegistryGateTest.ExtraControllers.class})
class SurfaceRegistryGateUnconstrainedTest {
    @Autowired
    private ApplicationContext context;

    @Test
    void aMethodAgnosticMappingFailsTheGateNamingTheRoute() {
        Set<String> mounted = SurfaceRegistryGateTest.moduleRoutes(context);
        Map<String, String> drift = SurfaceRegistryGateTest.drift(mounted);
        assertThat(drift).hasSize(1);
        assertThat(drift.keySet().iterator().next())
                .contains("* /v1/agents/__surface_gate_unconstrained__")
                .contains("mounted by a controller")
                .contains("missing from SurfaceRegistry");
    }

    @RestController
    static class UnconstrainedController {
        // No method attribute on purpose: the negative arm of the gate.
        @RequestMapping("/v1/agents/__surface_gate_unconstrained__")
        public String probe() {
            return "probe";
        }
    }
}
