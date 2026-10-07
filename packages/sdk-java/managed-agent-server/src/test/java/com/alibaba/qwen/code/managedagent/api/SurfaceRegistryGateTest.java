package com.alibaba.qwen.code.managedagent.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import java.util.EnumMap;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

/**
 * The D6 correspondence gate: every handler the module mounts — the public
 * and WebShell controllers plus the conditional internal ones — must match
 * {@link SurfaceRegistry} exactly, so a new route cannot land without an
 * entry (and a removed route cannot leave a stale one). The session-store
 * controller is enabled by property, the way deployments mount it; the
 * tool-publication controller is registered directly here because enabling
 * {@code qwen.managed-agent.tool-publication.enabled} requires a
 * provisioned OSS client and the Runtime Broker store beans, which no test
 * boot supplies — registering the controller mounts the same handler
 * mapping without those deployments. The negative halves of the gate live
 * in {@link SurfaceRegistryGateNegativeTest}.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:surface-gate;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.session-store.enabled=true",
        "qwen.managed-agent.tool-publication.entry-concurrency=4"
})
@Import(SurfaceRegistryGateTest.ExtraControllers.class)
class SurfaceRegistryGateTest {
    static final String MODULE_PREFIX =
            "com.alibaba.qwen.code.managedagent.";

    @Autowired
    private ApplicationContext context;

    @Test
    void mountedHandlersMatchTheRegistryExactly() {
        Set<String> mounted = moduleRoutes(context);
        assertThat(mounted).isNotEmpty();
        assertThat(drift(mounted)).isEmpty();
        assertThat(mounted).hasSameSizeAs(SurfaceRegistry.values());
    }

    @Test
    void capabilityTwinsShareOneRuleClass() {
        Map<SurfaceRegistry.Capability, SurfaceRegistry.RuleClass> classes =
                new EnumMap<>(SurfaceRegistry.Capability.class);
        Map<String, String> drift = new TreeMap<>();
        for (SurfaceRegistry entry : SurfaceRegistry.values()) {
            for (SurfaceRegistry.Capability capability
                    : entry.capabilities()) {
                SurfaceRegistry.RuleClass previous =
                        classes.putIfAbsent(capability, entry.ruleClass());
                if (previous != null && previous != entry.ruleClass()) {
                    drift.put("capability " + capability + " is "
                            + previous + " but route " + entry.routeKey()
                            + " declares " + entry.ruleClass(), "");
                }
            }
        }
        assertThat(drift).isEmpty();
    }

    /**
     * Every (method, template) pair a module-owned controller mounts, from
     * every {@link RequestMappingHandlerMapping} in the application.
     */
    static Set<String> moduleRoutes(ApplicationContext context) {
        Set<String> routes = new TreeSet<>();
        for (String name : context.getBeanNamesForType(
                RequestMappingHandlerMapping.class)) {
            RequestMappingHandlerMapping mapping = context.getBean(name,
                    RequestMappingHandlerMapping.class);
            mapping.getHandlerMethods().forEach((info, handler) -> {
                if (!handler.getBeanType().getName()
                        .startsWith(MODULE_PREFIX)) {
                    return;
                }
                for (String pattern : info.getPatternValues()) {
                    Set<RequestMethod> methods =
                            info.getMethodsCondition().getMethods();
                    if (methods.isEmpty()) {
                        // An untyped @RequestMapping mounts every HTTP
                        // method; without the sentinel the handler lands in
                        // neither set and the bijection passes silently.
                        routes.add("* " + pattern);
                        continue;
                    }
                    for (RequestMethod method : methods) {
                        routes.add(method.name() + " " + pattern);
                    }
                }
            });
        }
        return routes;
    }

    /**
     * The exact-bijection arm both the positive and the negative tests
     * assert on; every key names the offending route so the failure points
     * at the route, not the count.
     */
    static Map<String, String> drift(Set<String> mounted) {
        Map<String, String> drift = new TreeMap<>();
        Set<String> registered = new TreeSet<>();
        for (SurfaceRegistry entry : SurfaceRegistry.values()) {
            if (!registered.add(entry.routeKey())) {
                drift.put("route " + entry.routeKey() + " is registered"
                        + " twice in SurfaceRegistry", "");
            }
            if (!mounted.contains(entry.routeKey())) {
                drift.put("route " + entry.routeKey() + " is registered"
                        + " but no controller mounts it (entry "
                        + entry.name() + ")", "");
            }
        }
        for (String route : mounted) {
            if (!registered.contains(route)) {
                drift.put("route " + route + " is mounted by a controller"
                        + " but missing from SurfaceRegistry", "");
            }
        }
        return drift;
    }

    @TestConfiguration
    static class ExtraControllers {
        @Bean
        ToolPublicationController surfaceGateToolPublication(
                ManagedAgentProperties properties) {
            return new ToolPublicationController(
                    mock(ToolPublicationStore.class),
                    mock(ToolPublicationDataStore.class),
                    mock(ToolPublicationAdmissionStore.class), properties);
        }
    }
}
