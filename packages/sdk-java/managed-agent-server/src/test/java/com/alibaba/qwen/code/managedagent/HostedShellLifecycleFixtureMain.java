package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.Principal;
import java.util.ArrayList;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.core.Ordered;

public final class HostedShellLifecycleFixtureMain {
    private HostedShellLifecycleFixtureMain() { }

    public static void main(String[] args) throws Exception {
        var json = new ObjectMapper();
        var config = json.readTree(Files.readString(Path.of(args[0])));
        String tenant = config.path("tenant").asText();
        var arguments = new ArrayList<String>();
        config.path("properties").fields().forEachRemaining(entry ->
                arguments.add("--" + entry.getKey() + "=" + entry.getValue().asText()));
        var spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(ManagedAgentServerApplication.class)
                .initializers(context -> {
                    var authentication = new FilterRegistrationBean<Filter>((request, response, chain) ->
                            chain.doFilter(new HttpServletRequestWrapper((HttpServletRequest) request) {
                                @Override
                                public Principal getUserPrincipal() {
                                    String actor = getHeader("X-G0-Fixture-Actor");
                                    return actor == null ? null : new AuthenticatedTenantActor() {
                                        public String tenantId() { return tenant; }
                                        public String actorId() { return actor; }
                                        public String getName() { return actor; }
                                    };
                                }
                            }, response));
                    authentication.setOrder(Ordered.HIGHEST_PRECEDENCE);
                    authentication.setAsyncSupported(true);
                    authentication.addUrlPatterns("/v1/agents/*", "/api/agent/web-shell/v1/*");
                    context.getBeanFactory().registerSingleton("l4Authentication", authentication);
                    // Inline capture still constructs the production OSS adapter. Only
                    // its startup metadata reads are local; object I/O must fail loudly.
                    var acl = new com.aliyun.oss.model.AccessControlList();
                    acl.setCannedACL(com.aliyun.oss.model.CannedAccessControlList.Private);
                    var oss = org.mockito.Mockito.mock(com.aliyun.oss.OSS.class, invocation -> switch (invocation.getMethod().getName()) {
                        case "getBucketVersioning" -> new com.aliyun.oss.model.BucketVersioningConfiguration();
                        case "getBucketAcl" -> acl;
                        case "shutdown" -> null;
                        case "toString" -> "l4-inline-capture-fixture";
                        default -> throw new AssertionError("Unexpected object I/O: " + invocation.getMethod().getName());
                    });
                    context.addBeanFactoryPostProcessor(factory -> factory.registerSingleton("toolPublicationOss", oss));
                }).run(arguments.toArray(String[]::new));
        Path ready = Path.of(config.path("ready").asText());
        Path writing = ready.resolveSibling(ready.getFileName() + ".tmp");
        json.writeValue(writing.toFile(), java.util.Map.of("pid", ProcessHandle.current().pid(),
                "port", spring.getWebServer().getPort()));
        Files.move(writing, ready, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }
}
