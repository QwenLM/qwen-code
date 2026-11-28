package com.alibaba.qwen.code.runtimebroker.http;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import org.apache.catalina.startup.Tomcat;
import org.apache.tomcat.util.descriptor.web.FilterDef;
import org.apache.tomcat.util.descriptor.web.FilterMap;
import org.springframework.context.annotation.AnnotationConfigUtils;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.MapPropertySource;
import org.springframework.mock.web.MockServletContext;
import org.springframework.web.context.support.GenericWebApplicationContext;
import org.springframework.web.multipart.support.StandardServletMultipartResolver;
import org.springframework.web.servlet.DispatcherServlet;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.Map;
import java.util.concurrent.ThreadPoolExecutor;

public final class RuntimeBrokerHttpControllerTestFixture implements AutoCloseable {
    public static final String ROUTE_PREFIX = RuntimeBrokerHttpController.ROUTE_PREFIX;
    private final GenericWebApplicationContext applicationContext;
    private final RuntimeBrokerService service;
    private final Path baseDirectory;
    private Tomcat tomcat;
    private boolean closed;

    public RuntimeBrokerHttpControllerTestFixture(String token,
            RuntimeBrokerService service) throws Exception {
        this.service = service;
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setToken(token);
        applicationContext = new GenericWebApplicationContext(new MockServletContext());
        AnnotationConfigUtils.registerAnnotationConfigProcessors(
                applicationContext.getDefaultListableBeanFactory());
        applicationContext.getEnvironment().getPropertySources().addFirst(
                new MapPropertySource("brokerFixture", Map.of(
                        "qwen.managed-agent.runtime-broker.enabled", "true")));
        applicationContext.registerBean("embeddedRuntimeBroker",
                RuntimeBrokerService.class, () -> service,
                definition -> definition.setDestroyMethodName(""));
        applicationContext.registerAlias("embeddedRuntimeBroker",
                "runtimeBrokerService");
        applicationContext.registerBean(ManagedAgentProperties.class,
                () -> properties);
        applicationContext.registerBean(WebConfiguration.class);
        applicationContext.registerBean(RuntimeBrokerAuthenticationFilter.class);
        applicationContext.registerBean("multipartResolver",
                StandardServletMultipartResolver.class);
        applicationContext.registerBean(RuntimeBrokerHttpController.class);
        applicationContext.refresh();
        baseDirectory = Files.createTempDirectory("broker-spring-fixture-");
    }

    public void start() throws Exception {
        tomcat = new Tomcat();
        tomcat.setBaseDir(baseDirectory.toString());
        tomcat.setHostname("127.0.0.1");
        tomcat.setPort(0);
        var context = tomcat.addContext("", null);
        FilterDef authentication = new FilterDef();
        authentication.setFilterName("brokerAuthentication");
        authentication.setFilter(applicationContext.getBean(
                RuntimeBrokerAuthenticationFilter.class));
        authentication.setAsyncSupported("true");
        context.addFilterDef(authentication);
        FilterMap authenticationMapping = new FilterMap();
        authenticationMapping.setFilterName("brokerAuthentication");
        authenticationMapping.addURLPattern("/*");
        authenticationMapping.setDispatcher("REQUEST");
        context.addFilterMapBefore(authenticationMapping);
        var dispatcher = Tomcat.addServlet(context, "dispatcher",
                new DispatcherServlet(applicationContext));
        dispatcher.setAsyncSupported(true);
        context.addServletMappingDecoded("/", "dispatcher");
        tomcat.start();
    }

    public URI getBaseUri() {
        return URI.create("http://127.0.0.1:" + tomcat.getConnector().getLocalPort() + "/");
    }

    ThreadPoolExecutor executor() throws Exception {
        Object controller = applicationContext.getBean(RuntimeBrokerHttpController.class);
        var protocolField = RuntimeBrokerHttpController.class.getDeclaredField("protocol");
        protocolField.setAccessible(true);
        Object protocol = protocolField.get(controller);
        var field = RuntimeBrokerHttpProtocol.class.getDeclaredField("executor");
        field.setAccessible(true);
        return (ThreadPoolExecutor) field.get(protocol);
    }

    @Override
    public void close() throws Exception {
        if (closed) {
            return;
        }
        closed = true;
        Exception failure = null;
        if (tomcat != null) {
            try {
                tomcat.stop();
                tomcat.destroy();
            } catch (Exception error) {
                failure = error;
            }
        }
        applicationContext.close();
        service.close();
        try (var paths = Files.walk(baseDirectory)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (Exception error) {
                    throw new IllegalStateException(error);
                }
            });
        }
        if (failure != null) {
            throw failure;
        }
    }

    @Configuration(proxyBeanMethods = false)
    @EnableWebMvc
    static class WebConfiguration {
    }
}
