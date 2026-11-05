package com.alibaba.qwen.code.managedagent.preflight;

import com.alibaba.qwen.code.managedagent.config.BrokerSecurity;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.lang3.StringUtils;
import org.springframework.boot.ApplicationContextFactory;
import org.springframework.boot.DefaultBootstrapContext;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.context.event.ApplicationEnvironmentPreparedEvent;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.ConfigurationProperty;
import org.springframework.boot.context.properties.source.ConfigurationPropertyName;
import org.springframework.boot.context.properties.source.ConfigurationPropertySource;
import org.springframework.boot.context.properties.source.ConfigurationPropertySources;
import org.springframework.boot.convert.ApplicationConversionService;
import org.springframework.boot.env.EnvironmentPostProcessorApplicationListener;
import org.springframework.boot.logging.LoggingSystem;
import org.springframework.boot.web.server.Ssl;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.PropertySource;
import org.springframework.core.env.SimpleCommandLinePropertySource;

import java.net.Inet6Address;
import java.net.InetAddress;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Prints the settings the upgrade command must agree with the server on, as
 * the server resolves them.
 *
 * <p>It prepares the environment the way {@link SpringApplication} does
 * before it creates a context: the arguments, the process environment, every
 * environment post-processor on the class path (configuration files, imports,
 * profiles, {@code SPRING_APPLICATION_JSON}) and relaxed binding. It starts no
 * context, logs nothing and opens no connection. Run it with the server unit's
 * account, working directory, environment and arguments.
 */
public final class ResolvedConfiguration {
    /** Precedes the JSON line, so other output cannot be mistaken for it. */
    static final String PREFIX = "qwen-managed-agent-configuration ";
    private static final ConfigurationPropertyName STATE_DIRECTORY =
            ConfigurationPropertyName.of(
                    "qwen.managed-agent.runtime-broker.state-directory");
    // A value such as '${QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY:}'.
    private static final Pattern PLACEHOLDER =
            Pattern.compile("^\\$\\{([^:}]+)(?::[^}]*)?}$");
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int DEFAULT_SERVER_PORT = 8080;

    private ResolvedConfiguration() {
    }

    public static void main(String[] args) {
        // What SpringApplication does first: hold every log line until the
        // logging system is initialized, which it never is here.
        LoggingSystem.get(ResolvedConfiguration.class.getClassLoader())
                .beforeInitialize();
        System.exit(run(args));
    }

    static int run(String[] args) {
        Map<String, String> resolved;
        try {
            resolved = resolve(args, ApplicationContextFactory.DEFAULT
                    .createEnvironment(WebApplicationType.SERVLET));
        } catch (RuntimeException error) {
            System.err.println("cannot resolve the server configuration: "
                    + ManagedAgentPreflight.rootMessage(error));
            return 1;
        }
        try {
            System.out.println(PREFIX + JSON.writeValueAsString(resolved));
        } catch (JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
        return 0;
    }

    static Map<String, String> resolve(String[] args,
            ConfigurableEnvironment environment) {
        SpringApplication application = new SpringApplication();
        application.setWebApplicationType(WebApplicationType.SERVLET);
        environment.setConversionService(new ApplicationConversionService());
        if (args.length > 0) {
            environment.getPropertySources().addFirst(
                    new SimpleCommandLinePropertySource(args));
        }
        ConfigurationPropertySources.attach(environment);
        new EnvironmentPostProcessorApplicationListener().onApplicationEvent(
                new ApplicationEnvironmentPreparedEvent(
                        new DefaultBootstrapContext(), application, args,
                        environment));
        ConfigurationPropertySources.attach(environment);

        ManagedAgentProperties properties = Binder.get(environment)
                .bind("qwen.managed-agent",
                        Bindable.of(ManagedAgentProperties.class))
                .orElseGet(ManagedAgentProperties::new);
        Map<String, String> resolved = new LinkedHashMap<>();
        String directory = properties.getRuntimeBroker().getStateDirectory();
        if (StringUtils.isBlank(directory)) {
            resolved.put("runtimeStateDirectory", "");
        } else {
            // As EmbeddedRuntimeBroker reads it, in the server's directory.
            resolved.put("runtimeStateDirectory", Path.of(directory)
                    .toAbsolutePath().normalize().toString());
            resolved.put("runtimeStateOrigin", origin(environment));
        }
        String mode = BrokerSecurity.configuredMode(properties.getAuth());
        // auto serves open requests, or refuses to start.
        resolved.put("authMode", "auto".equals(mode) ? "open" : mode);
        resolved.put("trustedActorHeader",
                StringUtils.trimToEmpty(properties.getTrustedActorHeader()));
        // As the server parses it, untrimmed, so a refusal shows any padding,
        // with the preflight's verdict on it: the upgrade command refuses a
        // Harness URL the preflight would fail before it restarts the Harness,
        // without a rule of its own, and judges none the server never reads.
        // Pooled, the preflight does not read it, but each member's connector
        // does.
        resolved.put("harnessBaseUrl",
                StringUtils.defaultString(properties.getHarness().getBaseUrl()));
        resolved.put("harnessOrigin",
                ManagedAgentPreflight.harnessUrlVerdict(properties.getHarness()));
        Binder binder = Binder.get(environment);
        int port = binder.bind("server.port", Integer.class)
                .orElse(DEFAULT_SERVER_PORT);
        boolean ssl = Ssl.isEnabled(
                binder.bind("server.ssl", Ssl.class).orElse(null));
        String serverUrl = localUrl(ssl,
                binder.bind("server.address", InetAddress.class).orElse(null),
                port);
        resolved.put("serverUrl", serverUrl);
        resolved.put("healthUrl", healthUrl(binder, port, ssl, serverUrl));
        return resolved;
    }

    /**
     * A URL that reaches a listener from this host, or empty when it has no
     * fixed port: 0 picks one at start and a negative port starts none. A
     * wildcard bind serves the loopback interface of its family, and any
     * other address is dialled as bound.
     */
    private static String localUrl(boolean ssl, InetAddress address,
            int port) {
        if (port <= 0) {
            return "";
        }
        String host;
        if (address instanceof Inet6Address) {
            // ::1 is the only IPv6 loopback address.
            host = address.isAnyLocalAddress() || address.isLoopbackAddress()
                    ? "[::1]" : "[" + address.getHostAddress() + "]";
        } else {
            host = address == null || address.isAnyLocalAddress()
                    ? "127.0.0.1" : address.getHostAddress();
        }
        return (ssl ? "https" : "http") + "://" + host + ":" + port;
    }

    /**
     * Where the health endpoint answers, by Spring Boot's rules for the
     * management port (ManagementPortType): unset or equal to the server's,
     * it shares the server's listener; negative, it turns the HTTP endpoints
     * off; otherwise it opens a listener of its own, which binds
     * management.server.address and keeps the server's TLS unless
     * management.server.ssl replaces it. A blank path mapping keeps the
     * endpoint's name, as MappingWebEndpointPathMapper ignores it. Empty when
     * nothing answers at a fixed URL.
     */
    private static String healthUrl(Binder binder, int serverPort,
            boolean serverSsl, String serverUrl) {
        String endpoint = path(binder.bind("management.endpoints.web.base-path",
                String.class).orElse("/actuator"))
                + path(StringUtils.defaultIfBlank(binder.bind(
                        "management.endpoints.web.path-mapping.health",
                        String.class).orElse(null), "health"));
        Integer port = binder.bind("management.server.port", Integer.class)
                .orElse(null);
        if (port == null || port != 0 && port == serverPort) {
            return serverUrl.isEmpty() ? "" : serverUrl + endpoint;
        }
        Ssl ssl = binder.bind("management.server.ssl", Ssl.class).orElse(null);
        String url = localUrl(ssl == null ? serverSsl : Ssl.isEnabled(ssl),
                binder.bind("management.server.address", InetAddress.class)
                        .orElse(null),
                port);
        return url.isEmpty() ? "" : url + path(binder.bind(
                "management.server.base-path", String.class).orElse(""))
                + endpoint;
    }

    /** A path segment as Spring Boot joins it: one leading slash, no trailing one. */
    private static String path(String value) {
        String path = StringUtils.strip(StringUtils.trimToEmpty(value), "/");
        return path.isEmpty() ? "" : "/" + path;
    }

    /** Where the state directory came from, in the words of an operator. */
    private static String origin(ConfigurableEnvironment environment) {
        for (ConfigurationPropertySource source
                : ConfigurationPropertySources.get(environment)) {
            ConfigurationProperty property =
                    source.getConfigurationProperty(STATE_DIRECTORY);
            if (property == null) {
                continue;
            }
            Matcher placeholder =
                    PLACEHOLDER.matcher(String.valueOf(property.getValue()));
            if (placeholder.matches()
                    && environment.containsProperty(placeholder.group(1))) {
                return placeholder.group(1);
            }
            if (property.getOrigin() != null) {
                return property.getOrigin().toString();
            }
            return source.getUnderlyingSource() instanceof PropertySource<?> each
                    ? each.getName() : String.valueOf(source.getUnderlyingSource());
        }
        return "";
    }
}
