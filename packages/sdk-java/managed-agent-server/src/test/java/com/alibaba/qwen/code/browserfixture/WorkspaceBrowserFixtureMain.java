package com.alibaba.qwen.code.browserfixture;

import com.alibaba.qwen.code.managedagent.ManagedAgentServerApplication;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import java.security.Principal;
import java.util.List;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.jdbc.core.JdbcTemplate;

public final class WorkspaceBrowserFixtureMain {
    private WorkspaceBrowserFixtureMain() {
    }

    public static void main(String[] args) {
        String port = System.getenv().getOrDefault("W0D_SPRING_PORT", "18379");
        var context = new SpringApplicationBuilder(
                ManagedAgentServerApplication.class, FixturePrincipal.class)
                .run("--server.address=127.0.0.1", "--server.port=" + port,
                        "--spring.datasource.url=jdbc:h2:mem:w0d-browser;"
                                + "MODE=MySQL;DB_CLOSE_DELAY=-1;"
                                + "DATABASE_TO_LOWER=TRUE",
                        "--spring.datasource.driver-class-name=org.h2.Driver",
                        "--spring.datasource.username=sa",
                        "--spring.datasource.password=",
                        "--qwen.managed-agent.harness.enabled=false");
        JdbcTemplate jdbc = context.getBean(JdbcTemplate.class);
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES ('w0d-browser', 'ws-default', 1,"
                        + " 'test-storage', 'Browser Workspace',"
                        + " 'test-config', 'test-policy', 'ACTIVE')");
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES ('w0d-browser', 'ws-disabled', 1,"
                        + " 'test-disabled', 'Restricted Workspace',"
                        + " 'test-config', 'test-policy', 'DRAINING'),"
                        + " ('w0d-browser', 'ws-hidden', 1,"
                        + " 'test-hidden', 'Hidden Workspace',"
                        + " 'test-config', 'test-policy', 'ACTIVE')");
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, can_read, can_create)"
                        + " VALUES ('w0d-browser', 'ws-default', ?, TRUE, TRUE)",
                "browser-actor".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, can_read, can_create)"
                        + " VALUES ('w0d-browser', 'ws-disabled', ?,"
                        + " TRUE, TRUE), ('w0d-browser', 'ws-hidden', ?,"
                        + " TRUE, TRUE)",
                "browser-actor".getBytes(java.nio.charset.StandardCharsets.UTF_8),
                "other-actor".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        jdbc.update("INSERT INTO managed_workspace_default"
                        + " (tenant_id, workspace_id)"
                        + " VALUES ('w0d-browser', 'ws-default')");
    }

    @Configuration(proxyBeanMethods = false)
    static class FixturePrincipal {
        @Bean
        FilterRegistrationBean<Filter> trustedTestPrincipal() {
            AuthenticatedTenantActor actor = new AuthenticatedTenantActor() {
                @Override
                public String getName() {
                    return actorId();
                }

                @Override
                public String tenantId() {
                    return "w0d-browser";
                }

                @Override
                public String actorId() {
                    return "browser-actor";
                }
            };
            Filter filter = (request, response, chain) -> {
                HttpServletRequest wrapped = new HttpServletRequestWrapper(
                        (HttpServletRequest) request) {
                    @Override
                    public Principal getUserPrincipal() {
                        return actor;
                    }
                };
                chain.doFilter(wrapped, response);
            };
            FilterRegistrationBean<Filter> registration =
                    new FilterRegistrationBean<>(filter);
            registration.setUrlPatterns(List.of("/api/agent/web-shell/v1/*"));
            registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
            return registration;
        }
    }
}
