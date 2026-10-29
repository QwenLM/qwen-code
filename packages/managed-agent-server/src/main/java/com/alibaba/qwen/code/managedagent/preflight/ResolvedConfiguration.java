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
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.PropertySource;
import org.springframework.core.env.SimpleCommandLinePropertySource;

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
        return resolved;
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
