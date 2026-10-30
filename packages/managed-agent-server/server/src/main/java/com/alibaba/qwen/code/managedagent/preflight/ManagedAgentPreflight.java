package com.alibaba.qwen.code.managedagent.preflight;

import com.alibaba.qwen.code.managedagent.config.BrokerSecurity;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.harness.HarnessNegotiation;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessCapabilities;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessCapabilityFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessCapacityFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessTransportFailure;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.protocol.ExternalRuntimeKinds;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.lang3.StringUtils;
import org.flywaydb.core.api.FlywayException;
import org.flywaydb.core.api.MigrationVersion;
import org.springframework.boot.autoconfigure.web.ServerProperties;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcProperties;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.PropertySource;
import org.springframework.core.env.SimpleCommandLinePropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;

import java.io.File;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.UnknownHostException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Properties;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Read-only deployment preflight for the reference distribution.
 *
 * <p>It binds the same configuration Spring would load, checks the inputs that
 * otherwise fail during startup or on the first Turn, and never opens the web
 * server, a scheduler or a worker.
 */
public final class ManagedAgentPreflight {
    static final String CONFIG_LOCATION_ARG =
            "--spring.config.additional-location=";
    static final String CONFIG_LOCATION_ENV =
            "SPRING_CONFIG_ADDITIONAL_LOCATION";
    static final String ONLINE_ARG = "--online";
    private static final String WORKER_ARG = "managed-runtime-worker";
    // The kernel appends this to /proc/<pid>/cwd once the directory is removed.
    private static final String DELETED_SUFFIX = " (deleted)";
    private static final String SHELL_MCP_FEATURE = "workspace-shell-mcp/1";
    private static final Pattern QWEN_CODE_VERSION = Pattern.compile("[0-9A-Za-z.+-]{1,64}");
    private static final String OPTIONAL_PREFIX = "optional:";
    private static final String FILE_PREFIX = "file:";
    private static final Pattern DIGEST =
            Pattern.compile("sha256:[0-9a-f]{64}");
    private static final int TIMEOUT_MILLIS = 5_000;
    private static final int KEY_BYTES = 32;
    private static final int MIN_JAVA_FEATURE = 21;
    private static final int DEFAULT_SERVER_PORT = 8080;

    private ManagedAgentPreflight() {
    }

    /**
     * Runs the checks and returns a process exit code: 0 unless a check fails.
     */
    public static int run(String[] args) {
        List<Check> checks = checks(args);
        print(checks);
        return checks.stream().anyMatch(check ->
                check.status() == Status.FAIL) ? 1 : 0;
    }

    // --online, --online=true like the server's other --key=value arguments,
    // or --online=false to check offline; any other value fails, and the
    // remaining rows still run offline.
    static boolean online(String[] args, List<Check> checks) {
        boolean online = false;
        for (String arg : args) {
            if (arg.equals(ONLINE_ARG)) {
                online = true;
            } else if (arg.startsWith(ONLINE_ARG + "=")) {
                String value = arg.substring(ONLINE_ARG.length() + 1);
                if ("true".equalsIgnoreCase(value)) {
                    online = true;
                } else if ("false".equalsIgnoreCase(value)) {
                    online = false;
                } else {
                    checks.add(new Check("online", Status.FAIL,
                            arg + " is not true or false",
                            "pass --online, or leave it out while the service is stopped"));
                }
            }
        }
        return online;
    }

    static List<Check> checks(String[] args) {
        List<Check> checks = new ArrayList<>();
        // While the server runs it holds its ports and its Runtime workers.
        boolean online = online(args, checks);
        ConfigurableEnvironment environment = baseEnvironment(args);
        List<String> locations = configLocations(args, environment);
        loadConfiguration(environment, locations, checks);
        ManagedAgentProperties properties = bind(environment, checks);
        checks.add(javaCheck());
        AccessCheck access = serviceUserCheck(properties.getServiceUser(),
                System.getProperty("user.name", ""), ServiceAccount::lookup);
        checks.add(access.check());
        checks.add(configFileCheck(locations, access.account()));
        checks.add(startupValidationCheck(properties));
        checks.add(keyRingCheck(properties));
        checks.add(authCheck(environment, properties));
        checks.add(harnessCheck(properties, distributionQwenCodeVersion()));
        checks.add(credentialsFileCheck(properties, access.account()));
        checks.add(sessionStoreCheck(properties));
        checks.add(toolPathCheck(properties));
        checks.addAll(brokerChecks(properties));
        checks.add(workspaceCheck(properties));
        String serverAddress = environment.getProperty("server.address", "127.0.0.1");
        int serverPort = environment.getProperty("server.port", Integer.class,
                DEFAULT_SERVER_PORT);
        checks.add(online ? listeningCheck("server", serverAddress, serverPort)
                : portCheck("server", serverAddress, serverPort));
        if (properties.getRuntimeBroker().isEnabled()) {
            ManagedAgentProperties.RuntimeBroker broker = properties.getRuntimeBroker();
            checks.add(online ? listeningCheck("broker", broker.getHost(), broker.getPort())
                    : portCheck("broker", broker.getHost(), broker.getPort()));
        }
        checks.add(workersCheck(properties, () -> ProcessHandle.allProcesses()
                .collect(Collectors.toList()), online));
        Check database = databaseCheck(environment);
        checks.add(database);
        checks.add(database.status() == Status.PASS
                ? capacityCheck(environment)
                : new Check("capacity", Status.SKIP,
                        "database check did not pass; capacity not measured",
                        null));
        return checks;
    }

    static ConfigurableEnvironment baseEnvironment(String[] args) {
        StandardEnvironment environment = new StandardEnvironment();
        if (args.length > 0) {
            environment.getPropertySources().addFirst(
                    new SimpleCommandLinePropertySource(args));
        }
        return environment;
    }

    static List<String> configLocations(
            String[] args, ConfigurableEnvironment environment) {
        List<String> locations = new ArrayList<>();
        for (String arg : args) {
            if (arg.startsWith(CONFIG_LOCATION_ARG)) {
                addLocations(locations,
                        arg.substring(CONFIG_LOCATION_ARG.length()));
            }
        }
        if (locations.isEmpty()) {
            String configured = environment.getProperty(CONFIG_LOCATION_ENV);
            if (configured != null) {
                addLocations(locations, configured);
            }
        }
        return locations;
    }

    private static void addLocations(List<String> locations, String value) {
        for (String part : value.split(",")) {
            String trimmed = part.trim();
            if (!trimmed.isEmpty()) {
                locations.add(trimmed);
            }
        }
    }

    static void loadConfiguration(
            ConfigurableEnvironment environment, List<String> locations,
            List<Check> checks) {
        YamlPropertySourceLoader loader = new YamlPropertySourceLoader();
        for (int index = locations.size() - 1; index >= 0; index--) {
            String location = locations.get(index);
            boolean optional = location.startsWith(OPTIONAL_PREFIX);
            String path = optional
                    ? location.substring(OPTIONAL_PREFIX.length()) : location;
            if (path.startsWith(FILE_PREFIX)) {
                path = path.substring(FILE_PREFIX.length());
            }
            Resource resource = new FileSystemResource(path);
            if (!resource.exists()) {
                if (!optional) {
                    checks.add(new Check("config", Status.FAIL,
                            path + " does not exist",
                            "copy config/application.example.yml to "
                                    + "config/application.yml"));
                }
                continue;
            }
            addYaml(loader, environment, resource, "external-" + index,
                    checks);
        }
        addYaml(loader, environment, new ClassPathResource("application.yml"),
                "defaults", checks);
    }

    private static void addYaml(
            YamlPropertySourceLoader loader,
            ConfigurableEnvironment environment, Resource resource, String name,
            List<Check> checks) {
        try {
            for (PropertySource<?> source : loader.load(name, resource)) {
                environment.getPropertySources().addLast(source);
            }
        } catch (IOException error) {
            checks.add(new Check("config", Status.FAIL,
                    "cannot read " + resource.getDescription() + ": "
                            + error.getMessage(),
                    "fix the YAML syntax"));
        }
    }

    static ManagedAgentProperties bind(
            ConfigurableEnvironment environment, List<Check> checks) {
        try {
            ManagedAgentProperties properties = Binder.get(environment)
                    .bind("qwen.managed-agent",
                            Bindable.of(ManagedAgentProperties.class))
                    .orElseGet(ManagedAgentProperties::new);
            properties.setEnvironment(environment);
            return properties;
        } catch (RuntimeException error) {
            checks.add(new Check("config", Status.FAIL,
                    "binding failed: " + rootMessage(error),
                    "correct the configured value"));
            return new ManagedAgentProperties();
        }
    }

    static Check startupValidationCheck(ManagedAgentProperties properties) {
        try {
            properties.validateForPreflight();
            return new Check("validation", Status.PASS,
                    "startup properties accepted", null);
        } catch (RuntimeException error) {
            return new Check("validation", Status.FAIL, rootMessage(error),
                    "correct the startup configuration");
        }
    }

    static Check javaCheck() {
        Runtime.Version version = Runtime.version();
        return version.feature() >= MIN_JAVA_FEATURE
                ? new Check("java", Status.PASS, version.toString(), null)
                : new Check("java", Status.FAIL, version.toString(),
                        "install JDK 21 or later");
    }

    /** The account file rows check access for, or null for this process. */
    record AccessCheck(Check check, ServiceAccount account) {
    }

    interface AccountLookup {
        Optional<ServiceAccount> find(String name) throws IOException;
    }

    static AccessCheck serviceUserCheck(String name, String runner,
            AccountLookup lookup) {
        if (StringUtils.isBlank(name)) {
            return new AccessCheck(new Check("service-user", Status.SKIP,
                    "not set; file rows check access as " + runner, null), null);
        }
        if (name.equals(runner)) {
            return new AccessCheck(new Check("service-user", Status.PASS,
                    name + " (this process)", null), null);
        }
        Optional<ServiceAccount> account;
        try {
            account = lookup.find(name);
        } catch (IOException error) {
            return new AccessCheck(new Check("service-user", Status.WARN,
                    "cannot look up " + name + "; file rows check access as "
                            + runner, null), null);
        }
        if (account.isEmpty()) {
            return new AccessCheck(new Check("service-user", Status.FAIL,
                    name + " does not exist",
                    "create the account, or correct"
                            + " QWEN_MANAGED_AGENT_SERVICE_USER"), null);
        }
        return new AccessCheck(new Check("service-user", Status.PASS,
                name + " (groups " + String.join(", ",
                        new TreeSet<>(account.get().groups())) + ")",
                null), account.get());
    }

    // The server reads these files as its service account, which may not be
    // the account running preflight.
    private static boolean readable(Path file, ServiceAccount account) {
        if (account == null) {
            return Files.isReadable(file);
        }
        try {
            return account.canRead(file);
        } catch (UnsupportedOperationException error) {
            return Files.isReadable(file);
        } catch (IOException error) {
            return false;
        }
    }

    static Check configFileCheck(List<String> locations) {
        return configFileCheck(locations, null);
    }

    static Check configFileCheck(List<String> locations,
            ServiceAccount account) {
        if (locations.isEmpty()) {
            return new Check("config", Status.WARN,
                    "no external configuration; environment only",
                    "create config/application.yml for the credential key ring");
        }
        String location = locations.get(0);
        boolean optional = location.startsWith(OPTIONAL_PREFIX);
        String path = optional
                ? location.substring(OPTIONAL_PREFIX.length()) : location;
        if (path.startsWith(FILE_PREFIX)) {
            path = path.substring(FILE_PREFIX.length());
        }
        Path file = Path.of(path);
        if (!Files.exists(file) && optional) {
            return new Check("config", Status.WARN,
                    path + " does not exist (optional)", null);
        }
        if (!readable(file, account)) {
            return account == null
                    ? new Check("config", Status.FAIL,
                            path + " is not readable", "chmod 600 " + path)
                    : new Check("config", Status.FAIL,
                            path + " is not readable by " + account.name(),
                            unreadableFix(account, path));
        }
        String content;
        try {
            content = Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException error) {
            return new Check("config", Status.WARN,
                    path + ": cannot inspect permissions", null);
        }
        boolean secrets = content.contains("credential-key")
                || content.contains("signing-key")
                || content.contains("password");
        return secrets ? sharedSecretFileCheck("config", file, path)
                : new Check("config", Status.PASS, path, null);
    }

    private static String unreadableFix(ServiceAccount account, String path) {
        return "chown " + account.name() + " " + path + ", chmod 600 " + path
                + ", and let " + account.name()
                + " enter every directory on its path, following symbolic links";
    }

    // One policy for every file that holds a secret: WARN, not FAIL, when
    // anyone but its owner can read it, so the operator sees the chmod.
    private static Check sharedSecretFileCheck(String row, Path file,
            String path) {
        try {
            Set<PosixFilePermission> permissions =
                    Files.getPosixFilePermissions(file);
            if (permissions.contains(PosixFilePermission.GROUP_READ)
                    || permissions.contains(PosixFilePermission.OTHERS_READ)) {
                return new Check(row, Status.WARN,
                        path + " is group- or world-readable",
                        "chmod 600 " + path);
            }
        } catch (IOException | UnsupportedOperationException error) {
            return new Check(row, Status.WARN,
                    path + ": cannot inspect permissions", null);
        }
        return new Check(row, Status.PASS, path, null);
    }

    private static Check keyRingCheck(ManagedAgentProperties properties) {
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        String active = broker.getCredentialKeyId();
        Set<String> previous = broker.getPreviousCredentialKeys().keySet();
        if (StringUtils.isBlank(active)) {
            return previous.isEmpty()
                    ? new Check("key-ring", Status.SKIP,
                            "no Runtime credential key configured", null)
                    : new Check("key-ring", Status.FAIL,
                            "previous keys without an active key",
                            "set runtime-broker.credential-key-id");
        }
        String detail = "active=" + active
                + (previous.isEmpty() ? ""
                        : " previous=" + String.join(",", previous));
        return new Check("key-ring", Status.PASS, detail, null);
    }

    static Check authCheck(
            ConfigurableEnvironment environment,
            ManagedAgentProperties properties) {
        String address = environment.getProperty("server.address",
                "127.0.0.1");
        try {
            ServerProperties server = Binder.get(environment)
                    .bind("server", Bindable.of(ServerProperties.class))
                    .orElseGet(ServerProperties::new);
            WebMvcProperties mvc = Binder.get(environment)
                    .bind("spring.mvc", Bindable.of(WebMvcProperties.class))
                    .orElseGet(WebMvcProperties::new);
            new BrokerSecurity(properties, server, mvc);
        } catch (IllegalStateException error) {
            return new Check("auth", Status.FAIL, error.getMessage(),
                    "correct the auth or bind configuration");
        } catch (RuntimeException error) {
            return new Check("auth", Status.FAIL,
                    "cannot bind server configuration: " + rootMessage(error),
                    "correct the server or spring.mvc settings");
        }
        if (properties.getAuth().isAllowInsecureBind()) {
            return new Check("auth", Status.WARN,
                    "allow-insecure-bind publishes without authentication",
                    "remove QWEN_MANAGED_AGENT_AUTH_ALLOW_INSECURE_BIND");
        }
        return new Check("auth", Status.PASS,
                "address=" + address + " mode="
                        + String.valueOf(properties.getAuth().getMode()),
                null);
    }

    // Reads the values after the startup validation applied its defaults.
    static Check sessionStoreCheck(ManagedAgentProperties properties) {
        ManagedAgentProperties.SessionStore store =
                properties.getSessionStore();
        if (!properties.getHarness().isEnabled() || !store.isEnabled()) {
            return new Check("session-store", Status.SKIP, "disabled", null);
        }
        if (StringUtils.isBlank(store.getBaseUrl())) {
            return new Check("session-store", Status.FAIL,
                    "base URL is empty",
                    "set QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL to the"
                            + " listener the Harness reaches");
        }
        if (StringUtils.isBlank(store.getWorkspaceId())) {
            return new Check("session-store", Status.FAIL,
                    "workspace ID is empty",
                    "set QWEN_MANAGED_AGENT_WORKSPACE_CWD or"
                            + " QWEN_MANAGED_AGENT_WORKSPACE_ID");
        }
        return new Check("session-store", Status.PASS,
                store.getBaseUrl() + ", workspace "
                        + store.getWorkspaceId(),
                null);
    }

    static Check credentialsFileCheck(ManagedAgentProperties properties) {
        return credentialsFileCheck(properties, null);
    }

    static Check credentialsFileCheck(ManagedAgentProperties properties,
            ServiceAccount account) {
        ManagedAgentProperties.Harness harness = properties.getHarness();
        if (!harness.isEnabled()) {
            return new Check("credentials", Status.SKIP, "disabled", null);
        }
        String file = harness.getCredentialsFile();
        if (StringUtils.isBlank(file)) {
            return new Check("credentials", Status.SKIP,
                    StringUtils.isBlank(harness.getToken())
                            ? "no Harness credentials configured"
                            : "Harness credentials configured directly",
                    null);
        }
        Path path;
        try {
            path = Path.of(file);
        } catch (RuntimeException error) {
            return new Check("credentials", Status.WARN,
                    file + ": cannot inspect permissions", null);
        }
        // The server reads the file as its service account at startup.
        if (!readable(path, account)) {
            return account == null
                    ? new Check("credentials", Status.FAIL,
                            file + " is not readable",
                            "chown it to the service account, then chmod 600 "
                                    + file)
                    : new Check("credentials", Status.FAIL,
                            file + " is not readable by " + account.name(),
                            unreadableFix(account, file));
        }
        return sharedSecretFileCheck("credentials", path, file);
    }

    /**
     * Probes the Harness, then negotiates with it as the first Session does,
     * and compares its Qwen Code version with the distribution's manifest.
     */
    static Check harnessCheck(ManagedAgentProperties properties,
            String expectedQwenCodeVersion) {
        ManagedAgentProperties.Harness harness = properties.getHarness();
        if (!harness.isEnabled()) {
            return new Check("harness", Status.SKIP, "disabled", null);
        }
        String file = harness.getCredentialsFile();
        // Probing with whatever startup left bound would test credentials
        // it just refused.
        if (StringUtils.isNotBlank(file)
                && !properties.harnessCredentialsApplied()) {
            return new Check("harness", Status.SKIP,
                    "credentials were not read from " + file
                            + "; see the validation row",
                    null);
        }
        String tokenSetting = StringUtils.isBlank(file)
                ? "QWEN_MANAGED_AGENT_HARNESS_TOKEN"
                : "QWEN_SERVER_TOKEN in " + file;
        if (StringUtils.isBlank(harness.getToken())) {
            return new Check("harness", Status.FAIL, "token is empty",
                    "set " + tokenSetting);
        }
        // The shipped templates' placeholder works as a token, but anyone
        // can read it in the distribution.
        if (harness.getToken().startsWith("replace-")) {
            return new Check("harness", Status.FAIL,
                    "token is still the shipped template placeholder",
                    "set " + tokenSetting);
        }
        String digestSetting = StringUtils.isBlank(file)
                ? "QWEN_MANAGED_AGENT_CAPABILITY_DIGEST"
                : "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST in " + file;
        if (!isDigest(harness.getCapabilityDigest())) {
            return new Check("harness", Status.FAIL,
                    "capability digest is not sha256:<64 lowercase hex>",
                    "set " + digestSetting);
        }
        if (harness.getPool().isEnabled()) {
            if (!properties.getSessionStore().isEnabled() || StringUtils.isBlank(properties.getSessionStore().getBindingKey())) {
                return new Check("harness", Status.FAIL, "pool Session Store or binding key is missing", "enable session-store with a binding key");
            }
            return new Check("harness", Status.SKIP, "pool endpoints negotiate identity and TLS through the configured discovery source",
                    "verify individual Harness pool readiness after startup");
        }
        String baseUrl = harness.getBaseUrl();
        if (StringUtils.isBlank(baseUrl)) {
            return new Check("harness", Status.FAIL, "base URL is empty",
                    "set QWEN_MANAGED_AGENT_HARNESS_BASE_URL");
        }
        // A URL the probe cannot use fails on its setting alone: the parser's
        // own message quotes the value, credentials included. The server parses
        // this property untrimmed, so a padded value has to fail here too.
        URI origin = harnessOrigin(baseUrl);
        if (origin == null) {
            return unusableHarnessUrl();
        }
        String url = trimTrailingSlash(baseUrl) + "/capabilities";
        try {
            HttpClient client = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofMillis(TIMEOUT_MILLIS))
                    .build();
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofMillis(TIMEOUT_MILLIS))
                    .header("Accept", "application/json")
                    .header("Authorization", "Bearer " + harness.getToken())
                    .GET()
                    .build();
            HttpResponse<String> response = client.send(request,
                    HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 401 || response.statusCode() == 403) {
                return new Check("harness", Status.FAIL,
                        url + " rejected the configured token ("
                                + response.statusCode() + ")",
                        "set " + tokenSetting + " to the token the"
                                + " Harness accepts");
            }
            if (response.statusCode() != 200) {
                return new Check("harness", Status.FAIL,
                        url + " answered " + response.statusCode(),
                        "start a compatible Hosted Harness");
            }
            return compatibilityCheck(url, origin, response.body(), properties,
                    tokenSetting, StringUtils.isBlank(file), digestSetting,
                    expectedQwenCodeVersion);
        } catch (IOException | RuntimeException error) {
            return new Check("harness", Status.FAIL,
                    url + " is unreachable: " + printable(rootMessage(error)),
                    "start `qwen serve --profile hosted-harness`");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return new Check("harness", Status.FAIL,
                    url + " probe was interrupted", null);
        }
    }

    private static Check compatibilityCheck(String url, URI origin, String body,
            ManagedAgentProperties properties, String tokenSetting,
            boolean environmentDigest, String digestSetting,
            String expectedQwenCodeVersion) {
        ManagedAgentProperties.Harness harness = properties.getHarness();
        String install = expectedQwenCodeVersion == null
                ? "install the Qwen Code version the distribution manifest names"
                : "install Qwen Code " + expectedQwenCodeVersion;
        String retry = "check that the Harness is reachable, then run --check again";
        HarnessCapabilities capabilities;
        // The same client and rules the first Session uses.
        try (HarnessNegotiation negotiation = new HarnessNegotiation(origin, harness.getToken(),
                harness.getCapabilityDigest(), Duration.ofMillis(TIMEOUT_MILLIS))) {
            capabilities = negotiation.capabilities();
        } catch (HarnessCapabilityFailure mismatch) {
            // Without the credentials file, each process has its own variable.
            return new Check("harness", Status.FAIL,
                    url + " advertises another capability digest",
                    environmentDigest
                            ? "give the Harness's QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST"
                                    + " and the control plane's " + digestSetting
                                    + " the same value"
                            : "give the Harness and the control plane the same "
                                    + digestSetting);
        } catch (HarnessTransportFailure | HarnessCapacityFailure unanswered) {
            return new Check("harness", Status.FAIL,
                    url + " did not answer the compatibility request: "
                            + printable(rootMessage(unanswered)), retry);
        } catch (HarnessHttpFailure refused) {
            int status = refused.getStatusCode();
            // The status alone: the response body is the Harness's text.
            return status == 401 || status == 403
                    ? new Check("harness", Status.FAIL,
                            url + " rejected the configured token on the"
                                    + " compatibility request (" + status + ")",
                            "set " + tokenSetting + " to the token the Harness accepts")
                    : new Check("harness", Status.FAIL,
                            url + " answered the compatibility request with HTTP " + status,
                            retry);
        } catch (HarnessFailure incompatible) {
            return new Check("harness", Status.FAIL,
                    url + " is not a compatible Hosted Harness: "
                            + printable(rootMessage(incompatible)), install);
        } catch (IllegalArgumentException unusable) {
            return new Check("harness", Status.FAIL,
                    "the Harness base URL is not usable: "
                            + printable(rootMessage(unusable)),
                    "set QWEN_MANAGED_AGENT_HARNESS_BASE_URL to the Harness http(s)"
                            + " origin, without credentials, a query or a fragment");
        }
        Check lifecycle = lifecycleCheck(url, properties, capabilities, install);
        if (lifecycle != null) {
            return lifecycle;
        }
        String version = qwenCodeVersion(body);
        String detail = url + " compatible: Hosted Harness protocol "
                + capabilities.getCurrentProtocolVersion()
                + ", capability digest matches"
                + (version == null ? "" : ", Qwen Code " + version);
        List<String> warnings = new ArrayList<>();
        List<String> fixes = new ArrayList<>();
        if (expectedQwenCodeVersion != null && version == null) {
            warnings.add("it does not advertise a readable Qwen Code version, so"
                    + " it was not compared with " + expectedQwenCodeVersion);
            fixes.add(install);
        } else if (expectedQwenCodeVersion != null
                && !version.equals(expectedQwenCodeVersion)) {
            warnings.add("this distribution was built for " + expectedQwenCodeVersion);
            fixes.add(install);
        }
        // The connector refuses a Shell Session that pins MCP servers without it.
        if (harness.isWorkspaceShellEnabled()
                && !capabilities.getFeatures().contains(SHELL_MCP_FEATURE)) {
            warnings.add("it does not offer " + SHELL_MCP_FEATURE
                    + ", so Shell Sessions whose agent pins MCP servers fail");
            fixes.add("upgrade the Harness to a build that offers " + SHELL_MCP_FEATURE
                    + ", or disable Shell for agents that pin MCP servers");
        }
        return warnings.isEmpty()
                ? new Check("harness", Status.PASS, detail, null)
                : new Check("harness", Status.WARN,
                        detail + ", but " + String.join("; ", warnings),
                        String.join("; ", fixes));
    }

    // Each Workspace profile the deployment may admit needs its lifecycle, by
    // the rule the connector applies (WorkspaceToolProfiles.lifecycleProtocol).
    private static Check lifecycleCheck(String url, ManagedAgentProperties properties,
            HarnessCapabilities capabilities, String install) {
        ManagedAgentProperties.Harness harness = properties.getHarness();
        Set<String> profiles = new LinkedHashSet<>();
        if (harness.isWorkspaceFilesEnabled()) {
            profiles.add(WorkspaceToolProfiles.FILES);
            profiles.addAll(properties.getDefinitionToolProfiles());
        }
        if (harness.isWorkspaceShellEnabled()) {
            profiles.add(WorkspaceToolProfiles.SHELL);
        }
        // The Harness takes its list whole, so name every profile to keep.
        Set<String> v2Profiles = new LinkedHashSet<>();
        for (String advertised : capabilities.getLifecycleV2Profiles()) {
            if (WorkspaceToolProfiles.lifecycleProtocol(advertised) == 2) {
                v2Profiles.add(advertised);
            }
        }
        for (String profile : profiles) {
            if (WorkspaceToolProfiles.lifecycleProtocol(profile) == 2) {
                v2Profiles.add(profile);
            }
        }
        for (String profile : profiles) {
            int protocol = WorkspaceToolProfiles.lifecycleProtocol(profile);
            if (protocol == 1 && capabilities.getLifecycleProtocolVersion() != 1) {
                return new Check("harness", Status.FAIL,
                        url + " does not support Workspace files", install);
            }
            if (protocol == 2 && !capabilities.getLifecycleV2Profiles().contains(profile)) {
                return new Check("harness", Status.FAIL,
                        url + " does not offer " + profile,
                        "add " + profile + " to QWEN_HOSTED_LIFECYCLE_V2_PROFILES in the"
                                + " Harness environment; an explicit value replaces the"
                                + " whole list, so set it to "
                                + String.join(",", v2Profiles));
            }
        }
        return null;
    }

    // A Harness string reaches a root-run report, so only a version's shape.
    private static String qwenCodeVersion(String body) {
        try {
            JsonNode version = new ObjectMapper().readTree(body)
                    .path("qwenCodeVersion");
            return version.isTextual()
                    && QWEN_CODE_VERSION.matcher(version.asText()).matches()
                    ? version.asText() : null;
        } catch (IOException | RuntimeException error) {
            return null;
        }
    }

    /**
     * The Qwen Code version the reference distribution was built for, from the
     * manifest.json the database row also reads.
     */
    static String distributionQwenCodeVersion() {
        Path manifest = manifestPath();
        return manifest == null ? null : manifestQwenCodeVersion(manifest);
    }

    static String manifestQwenCodeVersion(Path manifest) {
        try {
            JsonNode version = new ObjectMapper().readTree(manifest.toFile())
                    .path("compatibility").path("qwenCodeVersion");
            return version.isTextual() ? version.asText() : null;
        } catch (IOException | RuntimeException error) {
            return null;
        }
    }

    // KillMode=process leaves Runtime workers running after the server stops,
    // and a following start races them for the state directory and Workspace.
    // Workers run with the state directory as their working directory.
    static Check workersCheck(ManagedAgentProperties properties,
            Supplier<List<ProcessHandle>> processes, boolean online) {
        ManagedAgentProperties.RuntimeBroker broker = properties.getRuntimeBroker();
        if (!broker.isEnabled() || !"local-process".equals(broker.getProvisioner())
                || StringUtils.isBlank(broker.getStateDirectory())) {
            return new Check("workers", Status.SKIP,
                    "no local-process Runtime configured", null);
        }
        if (!Files.isDirectory(Path.of("/proc"))) {
            return new Check("workers", Status.SKIP,
                    "not checked without /proc", null);
        }
        Path state;
        try {
            state = Path.of(broker.getStateDirectory()).toRealPath();
        } catch (NoSuchFileException missing) {
            return new Check("workers", Status.SKIP,
                    "state directory does not exist yet", null);
        } catch (IOException | RuntimeException unreadable) {
            return new Check("workers", Status.WARN,
                    broker.getStateDirectory() + " cannot be resolved ("
                            + rootMessage(unreadable) + "), so workers there"
                            + " were not checked",
                    "run --check as root or as the service account");
        }
        // A durable Broker adopts the workers that outlive a restart.
        boolean durable = broker.isDurableLocalProcess();
        if (online && durable) {
            return new Check("workers", Status.SKIP,
                    "online: the running durable Broker adopts surviving workers,"
                            + " so they cannot be told apart from leftovers", null);
        }
        long self = ProcessHandle.current().pid();
        List<Long> alive = new ArrayList<>();
        long uninspected = 0;
        for (ProcessHandle process : processes.get()) {
            WorkerMatch match = workerMatch(process, state, self,
                    broker.getNodeExecutable());
            if (match == WorkerMatch.UNREADABLE) {
                uninspected++;
            } else if (match == WorkerMatch.MATCH
                    // The running server's own workers are its children.
                    && (!online || isOrphan(process))) {
                alive.add(process.pid());
            }
        }
        alive.sort(Long::compare);
        if (!alive.isEmpty()) {
            String fix;
            if (durable) {
                fix = "a durable Broker adopts them when the server starts; to"
                        + " start clean, as an upgrade does, stop them first:"
                        + " systemctl kill --kill-whom=all -s TERM"
                        + " qwen-managed-agent-server";
            } else if (online) {
                fix = "online: to reap them without stopping the service, kill"
                        + " those pids; systemctl kill --kill-whom=all -s TERM"
                        + " qwen-managed-agent-server would also stop the running"
                        + " server";
            } else {
                fix = "stop them before starting the server: systemctl kill"
                        + " --kill-whom=all -s TERM qwen-managed-agent-server,"
                        + " or kill those pids";
            }
            String detail = alive.size()
                    + " Runtime worker(s) of an earlier run are alive (pid "
                    + alive.stream().map(String::valueOf)
                            .collect(Collectors.joining(", "))
                    + ")";
            // The list is not complete when a matching process was not read.
            if (uninspected > 0) {
                detail += "; " + uninspected + " more matching process(es) could"
                        + " not be inspected, so leftover workers were not ruled"
                        + " out";
                fix += "; run --check as root or as the service account";
            }
            return new Check("workers", Status.WARN, detail, fix);
        }
        // Another account's workers look exactly like this: argv readable,
        // /proc/<pid>/exe and cwd not.
        if (uninspected > 0) {
            return new Check("workers", Status.WARN, uninspected
                    + " process(s) matching the Runtime worker command line could"
                    + " not be inspected, so leftover workers were not ruled out",
                    "run --check as root or as the service account");
        }
        return new Check("workers", Status.PASS, online
                ? "online: no Runtime worker outlived an earlier run"
                : "no Runtime worker of an earlier run is alive", null);
    }

    enum WorkerMatch {
        MATCH, UNREADABLE, OTHER
    }

    static WorkerMatch workerMatch(ProcessHandle process, Path state, long self,
            String nodeExecutable) {
        ProcessHandle.Info info = process.info();
        if (process.pid() == self || info.arguments().isEmpty()) {
            return WorkerMatch.OTHER;
        }
        if (info.command().isEmpty()) {
            return isWorkerArguments(info.arguments().get())
                    ? WorkerMatch.UNREADABLE : WorkerMatch.OTHER;
        }
        if (!isWorkerCommand(info.command().get(), info.arguments().get(),
                nodeExecutable)) {
            return WorkerMatch.OTHER;
        }
        try {
            String cwd = Files.readSymbolicLink(Path.of("/proc",
                    Long.toString(process.pid()), "cwd")).toString();
            if (cwd.endsWith(DELETED_SUFFIX)) {
                cwd = cwd.substring(0, cwd.length() - DELETED_SUFFIX.length());
            }
            return Path.of(cwd).equals(state)
                    ? WorkerMatch.MATCH : WorkerMatch.OTHER;
        } catch (IOException | RuntimeException unreadable) {
            return WorkerMatch.UNREADABLE;
        }
    }

    // A worker runs `node <entry> managed-runtime-worker`. The command is
    // the executable's real path, and the arguments leave out argv[0], so the
    // marker follows the entry's absolute path. The Broker spawns whatever
    // node-executable names, so a renamed build counts too; an earlier run's
    // worker may still be a `node*` binary.
    static boolean isWorkerCommand(String command, String[] arguments,
            String nodeExecutable) {
        return isWorkerArguments(arguments)
                && (Path.of(command).getFileName().toString().startsWith("node")
                        || samePath(command, nodeExecutable));
    }

    // The configured path may be a symlink while /proc/<pid>/exe names the
    // target, so compare the files rather than how their paths are spelled.
    private static boolean samePath(String command, String configured) {
        if (configured == null || configured.isBlank()) {
            return false;
        }
        try {
            return Files.isSameFile(Path.of(command), Path.of(configured));
        } catch (IOException | RuntimeException unreadable) {
            return Path.of(command).toAbsolutePath().normalize()
                    .equals(Path.of(configured).toAbsolutePath().normalize());
        }
    }

    private static boolean isWorkerArguments(String[] arguments) {
        int last = arguments.length - 1;
        return last >= 1 && WORKER_ARG.equals(arguments[last])
                && arguments[last - 1].startsWith("/");
    }

    // KillMode=process reparents a stopped server's workers to init.
    private static boolean isOrphan(ProcessHandle process) {
        return process.parent().map(parent -> !parent.info().command()
                .map(command -> isServerCommand(
                        Path.of(command).getFileName().toString()))
                .orElse(false)).orElse(true);
    }

    // A replaced JDK binary keeps its inode, and the kernel marks the link.
    static boolean isServerCommand(String fileName) {
        String name = fileName.endsWith(DELETED_SUFFIX)
                ? fileName.substring(0, fileName.length()
                        - DELETED_SUFFIX.length())
                : fileName;
        return name.equals("java");
    }

    // --online: the running server holds the ports, so check that it
    // listens there instead of trying to bind them.
    // A port outside the TCP range would throw out of the row, aborting the
    // whole report instead of failing this one check.
    private static Check portRangeCheck(String name, int port) {
        return new Check(name + "-port", Status.FAIL,
                port + " is not a TCP port",
                "set the configured port between 0 and 65535");
    }

    static Check listeningCheck(String name, String address, int port) {
        if (port < 0 || port > 65535) {
            return portRangeCheck(name, port);
        }
        String host = address == null || address.isBlank()
                || "0.0.0.0".equals(address) || "::".equals(address)
                ? "127.0.0.1" : address;
        InetSocketAddress endpoint = new InetSocketAddress(host, port);
        if (endpoint.isUnresolved()) {
            return new Check(name + "-port", Status.FAIL,
                    "cannot resolve " + host, "fix the bind address");
        }
        try (Socket socket = new Socket()) {
            socket.connect(endpoint, TIMEOUT_MILLIS);
            return new Check(name + "-port", Status.PASS,
                    host + ":" + port + " is listening (online)", null);
        } catch (IOException | RuntimeException error) {
            return new Check(name + "-port", Status.FAIL,
                    "nothing listens on " + host + ":" + port + ": "
                            + rootMessage(error),
                    "start the server, or run --check without --online"
                            + " while it is stopped");
        }
    }

    static Check toolPathCheck(ManagedAgentProperties properties) {
        ManagedAgentProperties.Harness harness = properties.getHarness();
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        boolean files = harness.isWorkspaceFilesEnabled();
        boolean shell = harness.isWorkspaceShellEnabled();
        if (ExternalRuntimeKinds.isExternal(broker.getProvisioner()) && (files || shell)) {
            if (properties.isExternalWorkspaceFilesConfigured()) {
                return new Check("tool-path", Status.PASS,
                        "External Workspace files configuration is supported; negotiated readiness and original-worker close proof remain required", null);
            }
            return new Check("tool-path", Status.FAIL,
                    ExternalRuntimeKinds.isWorkspace(broker.getProvisioner())
                                    ? "External Workspace Runtime is a storage provisioning prerequisite"
                                    : "External Runtime supports scratch Sessions only",
                    "disable managed Workspace files and Shell");
        }
        if (broker.getSsh().isEnabled()
                && (!files || broker.getSsh().getNodes().isEmpty())) {
            return new Check("tool-path", Status.FAIL,
                    "SSH Runtime requires Workspace files and configured nodes",
                    "enable Workspace files and add runtime-broker.ssh.nodes");
        }
        if (!StringUtils.isBlank(broker.getWorkspaceCreationRoot()) && !files) {
            return new Check("tool-path", Status.FAIL,
                    "Workspace creation requires Workspace files",
                    "set QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED=true");
        }
        if (shell && !files) {
            return new Check("tool-path", Status.FAIL,
                    "Workspace Shell requires Workspace files",
                    "set QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED=true");
        }
        if (!files) {
            return new Check("tool-path", Status.SKIP,
                    "Workspace files disabled", null);
        }
        String mode = harness.getApprovalMode() == null
                ? "" : harness.getApprovalMode().toLowerCase(Locale.ROOT);
        if (!Set.of("yolo", "default", "auto-edit").contains(mode)) {
            return new Check("tool-path", Status.FAIL,
                    "unsupported approval mode " + mode,
                    "use yolo, default or auto-edit");
        }
        if (shell && !Set.of("default", "auto-edit").contains(mode)) {
            return new Check("tool-path", Status.FAIL,
                    "Workspace Shell does not support approval mode " + mode,
                    "use default or auto-edit");
        }
        if (!harness.isEnabled()) {
            return new Check("tool-path", Status.FAIL,
                    "Workspace files require the Hosted Harness",
                    "set QWEN_MANAGED_AGENT_HARNESS_ENABLED=true");
        }
        if (!properties.getSessionStore().isEnabled()) {
            return new Check("tool-path", Status.FAIL,
                    "Workspace files require the Managed Session Store",
                    "set QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED=true");
        }
        if (!properties.getRuntimeBroker().isEnabled()) {
            return new Check("tool-path", Status.FAIL,
                    "Workspace files require the Runtime Broker",
                    "set QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED=true");
        }
        if ("static".equals(broker.getProvisioner())) {
            return new Check("tool-path", Status.FAIL,
                    "Workspace files cannot use the static provisioner",
                    "use the local-process provisioner");
        }
        if (!"local-process".equals(broker.getProvisioner())) {
            return new Check("tool-path", Status.WARN,
                    "not evaluated for provisioner " + broker.getProvisioner(),
                    null);
        }
        if (!WorkspaceExecutionProfile.admitsIsolationClass(
                broker.getIsolationClass())) {
            return new Check("tool-path", Status.FAIL,
                    "unsupported isolation class "
                            + broker.getIsolationClass(),
                    "use session isolation");
        }
        if (broker.getWorkspaceMounts().isEmpty()
                && StringUtils.isBlank(broker.getWorkspaceCreationRoot())
                && broker.getSsh().getNodes().isEmpty()) {
            return new Check("tool-path", Status.FAIL,
                    "no Workspace mount, creation root or SSH node",
                    "add runtime-broker.workspace-mounts to "
                            + "config/application.yml");
        }
        if (!StringUtils.isBlank(broker.getWorkspaceCreationRoot())
                && (!broker.isDurableLocalProcess()
                        || !broker.isVerifiedWorkspaceRecoveryEnabled())) {
            return new Check("tool-path", Status.FAIL,
                    "Workspace creation requires durable local-process"
                            + " execution and verified recovery",
                    "set verified-workspace-recovery-enabled=true");
        }
        return new Check("tool-path", Status.PASS,
                "Workspace files enabled in mode " + mode, null);
    }

    static List<Check> brokerChecks(
            ManagedAgentProperties properties) {
        List<Check> checks = new ArrayList<>();
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        if (!broker.isEnabled()) {
            checks.add(new Check("broker", Status.SKIP, "disabled", null));
            return checks;
        }
        String file = properties.getHarness().getCredentialsFile();
        // Startup reads the file only while the Harness is enabled.
        boolean readsFile = properties.getHarness().isEnabled()
                && StringUtils.isNotBlank(file);
        if (StringUtils.isBlank(broker.getToken())) {
            String fix;
            if (!readsFile) {
                fix = "set QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN";
            } else if (properties.harnessCredentialsApplied()) {
                // The Harness takes both from the file, or neither.
                fix = "set QWEN_MANAGED_RUNTIME_BROKER_URL and"
                        + " QWEN_MANAGED_RUNTIME_BROKER_TOKEN in " + file;
            } else {
                fix = "credentials were not read from " + file
                        + "; see the validation row";
            }
            checks.add(new Check("broker", Status.FAIL, "token is empty",
                    fix));
        }
        Check listen = brokerListenCheck(broker);
        if (listen != null) {
            checks.add(listen);
        }
        if (readsFile && properties.harnessCredentialsApplied()) {
            checks.add(harnessBrokerUrlCheck(
                    properties.harnessBrokerUrl(), broker, file));
        }
        if (StringUtils.isBlank(broker.getCredentialKeyId())
                || StringUtils.isBlank(broker.getCredentialKey())) {
            checks.add(new Check("broker", Status.FAIL,
                    "credential key pair is incomplete",
                    "set runtime-broker.credential-key-id and credential-key"));
        } else if (!isCredentialKey(broker.getCredentialKey())) {
            checks.add(new Check("broker", Status.FAIL,
                    "credential key is not a base64-encoded 32-byte value",
                    "generate one with `openssl rand -base64 32`"));
        }
        for (Map.Entry<String, String> entry
                : broker.getPreviousCredentialKeys().entrySet()) {
            if (!isCredentialKey(entry.getValue())) {
                checks.add(new Check("broker", Status.FAIL,
                        "previous key " + entry.getKey()
                                + " is not base64 32 bytes",
                        "re-enter the recorded key"));
            }
        }
        if (!ExternalRuntimeKinds.isExternal(broker.getProvisioner())) {
            checks.add(directoryCheck("broker-state", broker.getStateDirectory()));
        }
        if ("local-process".equals(broker.getProvisioner())) {
            checks.add(executableCheck("node", broker.getNodeExecutable()));
            checks.add(readableCheck("worker-entry",
                    broker.getWorkerEntry()));
        } else if ("static".equals(broker.getProvisioner())) {
            if (StringUtils.isBlank(broker.getStaticEndpoint())
                    || StringUtils.isBlank(broker.getStaticToken())) {
                checks.add(new Check("broker", Status.FAIL,
                        "static provisioner needs endpoint and token",
                        "set static-endpoint and static-token"));
            }
        } else if (ExternalRuntimeKinds.isExternal(broker.getProvisioner())) {
            try {
                properties.validateExternalRuntime();
                checks.add(new Check("broker", Status.PASS,
                        broker.getProvisioner() + " configuration accepted; provider reachability,"
                                + " worker attestation and storage registration are checked on first use",
                        null));
                if (ExternalRuntimeKinds.isWorkspace(broker.getProvisioner())) {
                    // Configurable is not the same as usable: say so, so an
                    // operator is never misled by the PASS above.
                    checks.add(new Check("external-prerequisite", Status.WARN,
                            properties.isExternalWorkspaceFilesConfigured()
                                    ? "External files require exact Harness negotiation and current registration; original-worker close proof is checked at drain"
                                    : "external-workspace files are disabled or incompletely configured; new Hosted files Sessions fail closed",
                            "keep this profile out of production until files execution and"
                                    + " Session close are verified (step 3b/3c)"));
                }
            } catch (RuntimeException error) {
                checks.add(new Check("broker", Status.FAIL, rootMessage(error),
                        "correct the external Runtime configuration"));
            }
        } else {
            checks.add(new Check("broker", Status.FAIL,
                    "unknown provisioner " + broker.getProvisioner(),
                    "use local-process, static or "
                            + ExternalRuntimeKinds.supported()));
        }
        return checks;
    }

    // The Harness takes its Broker URL from its own environment file, which
    // nothing else reconciles with the address the Broker binds. The URL is
    // first read the way the Harness reads it when it starts
    // (HarnessBrokerUrl); then only a URL that names the Broker's own
    // plain-HTTP listener can be checked, and one that names another address
    // may reach it through a proxy.
    static Check harnessBrokerUrlCheck(String url,
            ManagedAgentProperties.RuntimeBroker broker, String file) {
        String host = broker.getHost();
        // An IPv6 literal needs brackets before the port.
        String address = (host.contains(":") && !host.startsWith("[")
                ? "[" + host + "]" : host) + ":" + broker.getPort();
        if (StringUtils.isBlank(url)) {
            return new Check("broker-url", Status.WARN,
                    file + " gives the Hosted Harness no Broker URL",
                    "set QWEN_MANAGED_RUNTIME_BROKER_URL and"
                            + " QWEN_MANAGED_RUNTIME_BROKER_TOKEN in " + file
                            + ", unless the Harness environment or command"
                            + " line sets them");
        }
        String direct = directBrokerUrl(broker);
        String fix = "point QWEN_MANAGED_RUNTIME_BROKER_URL in " + file
                + " at " + (direct != null ? direct
                        : "the https URL of the TLS-terminating proxy in front"
                                + " of " + address);
        HarnessBrokerUrl.Result read = HarnessBrokerUrl.read(url);
        String refusal = switch (read.verdict()) {
            case INVALID -> ", which is not a valid URL";
            case NOT_ORIGIN -> ", which is not an http or https origin";
            case PLAIN_OUTSIDE_LOOPBACK -> ", because it uses plain http"
                    + " outside the loopback interface";
            case ACCEPTED, UNCLASSIFIED -> null;
        };
        if (refusal != null) {
            return new Check("broker-url", Status.FAIL,
                    "the Hosted Harness refuses " + url + refusal, fix);
        }
        if (read.verdict() == HarnessBrokerUrl.Verdict.UNCLASSIFIED) {
            // Only FAIL sets the exit code, so a spelling preflight cannot
            // read never blocks a start.
            return new Check("broker-url", Status.WARN, "preflight cannot read "
                    + url + " the way the Hosted Harness does",
                    "check that the Hosted Harness starts and reaches "
                            + address);
        }
        // The URL names the Broker's own socket, which speaks plain HTTP.
        Check tls = new Check("broker-url", Status.FAIL, "the Hosted Harness"
                + " dials " + url + ", but the Broker serves plain HTTP there,"
                + " so TLS cannot connect", fix);
        if (read.port() == broker.getPort()
                && served(read.hostname(), broker.getHost())) {
            return read.https() ? tls
                    : new Check("broker-url", Status.PASS, url, null);
        }
        if (read.port() == broker.getPort()
                && servedOnlyDualStack(read.hostname(), broker.getHost())) {
            // Whether the Broker's socket takes this address depends on a JVM
            // option preflight cannot see; when it does not, another listener,
            // such as a TLS proxy, may hold it.
            if (read.https()) {
                return new Check("broker-url", Status.WARN, "the Hosted Harness"
                        + " dials " + url + " over IPv6: a Broker JVM that"
                        + " listens on both families takes it on the plain-HTTP"
                        + " socket at " + address + ", where TLS cannot"
                        + " connect, while under -Djava.net.preferIPv4Stack=true"
                        + " another listener, such as a TLS proxy, may hold it",
                        fix + ", unless a proxy forwards " + url + " there");
            }
            return new Check("broker-url", Status.WARN,
                    "the Hosted Harness dials " + url + " over IPv6, but the"
                            + " Broker binds " + broker.getHost() + ", which"
                            + " takes IPv6 only when its JVM listens on both"
                            + " families, unlike under"
                            + " -Djava.net.preferIPv4Stack=true", fix);
        }
        return new Check("broker-url", Status.WARN, "the Hosted Harness dials "
                + url + ", not the Broker's listener at " + address
                + "; a proxy may forward it, which preflight cannot verify",
                direct != null
                        ? fix + ", unless a proxy forwards " + url + " there"
                        : "check that a proxy forwards " + url + " to "
                                + address);
    }

    // The URL that reaches the Broker's listener directly, which the Harness
    // accepts only on the loopback interface; null for a non-loopback bind,
    // which the Harness reaches through a TLS-terminating proxy. It is built
    // from the bound address, which the Harness reads the same way whatever
    // the configured spelling.
    private static String directBrokerUrl(
            ManagedAgentProperties.RuntimeBroker broker) {
        InetAddress bind = new InetSocketAddress(broker.getHost(), 0)
                .getAddress();
        if (bind == null
                || (!bind.isAnyLocalAddress() && !bind.isLoopbackAddress())) {
            return null;
        }
        String host;
        if (bind instanceof Inet6Address) {
            // ::1 is the only IPv6 loopback address.
            host = "[::1]";
        } else {
            host = bind.isAnyLocalAddress() ? "127.0.0.1"
                    : bind.getHostAddress();
        }
        return "http://" + host + ":" + broker.getPort();
    }

    // The Broker refuses a non-loopback listen address unless told it sits
    // behind a TLS-terminating layer (RuntimeBrokerHttpServer).
    static Check brokerListenCheck(ManagedAgentProperties.RuntimeBroker broker) {
        InetAddress bind = new InetSocketAddress(broker.getHost(), 0)
                .getAddress();
        if (broker.isAllowNonLoopback()
                || (bind != null && bind.isLoopbackAddress())) {
            return null;
        }
        return new Check("broker", Status.FAIL, "the Broker refuses to listen"
                + " on " + broker.getHost() + " without"
                + " runtime-broker.allow-non-loopback",
                "bind 127.0.0.1, or set"
                        + " QWEN_MANAGED_AGENT_RUNTIME_BROKER_ALLOW_NON_LOOPBACK=true"
                        + " behind a TLS-terminating proxy");
    }

    // Whether the Broker's socket accepts connections to this host: a
    // specific bind serves only its own address, and a wildcard bind every
    // address of this machine in its family. The JDK binds :: only on a
    // dual-stack socket, which takes IPv4 as well, but binds 0.0.0.0 to IPv4
    // alone under -Djava.net.preferIPv4Stack=true, a JVM option the server
    // may get from an environment preflight does not share.
    private static boolean served(String host, String bindHost) {
        return servedBy(host, bindHost, false);
    }

    // Whether only a dual-stack listener would serve this host: an IPv6
    // address of this machine against the IPv4 wildcard.
    private static boolean servedOnlyDualStack(String host, String bindHost) {
        return !served(host, bindHost) && servedBy(host, bindHost, true);
    }

    private static boolean servedBy(String host, String bindHost,
            boolean dualStack) {
        try {
            InetAddress bind = InetAddress.getByName(bindHost);
            for (InetAddress address : InetAddress.getAllByName(host)) {
                if (bind.isAnyLocalAddress()
                        ? isLocal(address) && (dualStack
                                || bind instanceof Inet6Address
                                || address instanceof Inet4Address)
                        : address.equals(bind)) {
                    return true;
                }
            }
        } catch (UnknownHostException | SecurityException unresolved) {
            return false;
        }
        return false;
    }

    private static boolean isLocal(InetAddress address) {
        try {
            return address.isLoopbackAddress() || address.isAnyLocalAddress()
                    || NetworkInterface.getByInetAddress(address) != null;
        } catch (SocketException error) {
            return false;
        }
    }

    private static Check workspaceCheck(ManagedAgentProperties properties) {
        if (ExternalRuntimeKinds.isExternal(properties.getRuntimeBroker().getProvisioner())) {
            return new Check("workspace", Status.SKIP,
                    "the external worker owns the mount root; no local directory required", null);
        }
        String cwd = properties.getRuntimeBroker().getWorkspaceCwd();
        if (StringUtils.isBlank(cwd)) {
            return new Check("workspace", Status.SKIP,
                    "no Workspace cwd configured", null);
        }
        Check directory = directoryCheck("workspace", cwd);
        if (directory.status() != Status.PASS) {
            return directory;
        }
        return new Check("workspace", Status.PASS,
                cwd + " (mount registration is not checked)", null);
    }

    private static Check directoryCheck(String name, String path) {
        if (StringUtils.isBlank(path)) {
            return new Check(name, Status.FAIL, "not configured",
                    "set the directory");
        }
        Path directory = Path.of(path);
        if (!Files.isDirectory(directory)) {
            return new Check(name, Status.FAIL,
                    path + " is not a directory", "create it");
        }
        if (!Files.isWritable(directory)) {
            return new Check(name, Status.FAIL, path + " is not writable",
                    "grant write access to the service account");
        }
        return new Check(name, Status.PASS, path, null);
    }

    private static Check executableCheck(String name, String path) {
        if (StringUtils.isBlank(path)) {
            return new Check(name, Status.FAIL, "not configured",
                    "set the executable path");
        }
        return Files.isExecutable(Path.of(path))
                ? new Check(name, Status.PASS, path, null)
                : new Check(name, Status.FAIL, path + " is not executable",
                        "install the executable or fix its path");
    }

    private static Check readableCheck(String name, String path) {
        if (StringUtils.isBlank(path)) {
            return new Check(name, Status.FAIL, "not configured",
                    "set the worker entry path");
        }
        return Files.isReadable(Path.of(path))
                ? new Check(name, Status.PASS, path, null)
                : new Check(name, Status.FAIL, path + " is not readable",
                        "install the Qwen Code CLI or fix its path");
    }

    static Check portCheck(String name, String address, int port) {
        if (port < 0 || port > 65535) {
            return portRangeCheck(name, port);
        }
        InetSocketAddress endpoint = new InetSocketAddress(address, port);
        if (endpoint.isUnresolved()) {
            return new Check(name + "-port", Status.FAIL,
                    "cannot resolve " + address,
                    "fix the bind address");
        }
        // Keeps the JDK's SO_REUSEADDR, as Tomcat and the Broker's
        // HttpServer do: a port the stopped server left in TIME_WAIT is free
        // to them, while a live listener still refuses the bind.
        try (ServerSocket socket = new ServerSocket()) {
            socket.bind(endpoint);
            return new Check(name + "-port", Status.PASS,
                    address + ":" + port + " is free", null);
        } catch (IOException error) {
            return new Check(name + "-port", Status.FAIL,
                    address + ":" + port + " is unavailable: "
                            + rootMessage(error),
                    "stop the process holding it or choose another port; if"
                            + " the service is meant to be running, run --check --online");
        }
    }

    static Check databaseCheck(ConfigurableEnvironment environment) {
        String url = environment.getProperty("spring.datasource.url");
        if (StringUtils.isBlank(url)) {
            return new Check("database", Status.FAIL,
                    "no datasource URL", "set SPRING_DATASOURCE_URL");
        }
        try (Connection connection = databaseConnection(environment)) {
            try (Statement statement = connection.createStatement()) {
                statement.execute("SELECT 1");
            }
            try {
                requirePerformanceSchemaGrant(connection);
            } catch (SQLException error) {
                return new Check("database", Status.FAIL,
                        "performance_schema grant missing ("
                                + error.getErrorCode() + ")",
                        "grant SELECT ON "
                                + "performance_schema.user_variables_by_thread"
                                + " to the datasource user");
            }
            return schemaCheck(connection, expectedSchemaVersion());
        } catch (SQLException error) {
            return new Check("database", Status.FAIL,
                    url + ": " + error.getMessage(),
                    "check the datasource settings, grants and that MySQL 8 "
                            + "is running");
        }
    }

    /**
     * Reports durable counts that are useful for capacity triage. These are
     * logical SQL records, not physical process or memory measurements. The
     * report deliberately does not infer idle work or reclaim anything.
     */
    static Check capacityCheck(ConfigurableEnvironment environment) {
        try (Connection connection = databaseConnection(environment)) {
            return capacityCheck(connection);
        } catch (SQLException error) {
            return capacityUnavailable(error);
        }
    }

    static Check capacityCheck(Connection connection) {
        try {
            Map<String, Long> bindings = stateCounts(connection,
                    "ma_runtime_binding", "binding_state");
            Map<String, Long> sessions = stateCounts(connection,
                    "ma_runtime_session", "session_state");
            Map<String, Long> operations = stateCounts(connection,
                    "ma_operation", "state");
            String detail = "runtime-bindings=" + bindings
                    + "; runtime-sessions=" + sessions
                    + "; operations=" + operations
                    + "; physical-processes=unknown"
                    + "; memory=unknown; idle-reclamation=not measured";
            return new Check("capacity", Status.PASS, detail, null);
        } catch (SQLException error) {
            return capacityUnavailable(error);
        }
    }

    private static Check capacityUnavailable(SQLException error) {
        if (isTimeout(error)) {
            return new Check("capacity", Status.WARN,
                    "durable capacity facts unavailable: observation timed "
                            + "out before all state counts were read",
                    "retry when the database is less busy; this observation "
                            + "reads the full state tables");
        }
        return new Check("capacity", Status.WARN,
                "durable capacity facts unavailable: " + rootMessage(error),
                "check the datasource grants and managed schema");
    }

    private static boolean isTimeout(Throwable error) {
        for (Throwable current = error; current != null;
                current = current.getCause()) {
            if (current instanceof SQLTimeoutException
                    || current instanceof SocketTimeoutException) {
                return true;
            }
            String message = current.getMessage();
            if (message != null) {
                String lower = message.toLowerCase(Locale.ROOT);
                if (lower.contains("timeout")
                        || lower.contains("timed out")) {
                    return true;
                }
            }
        }
        return false;
    }

    private static Map<String, Long> stateCounts(Connection connection,
            String table, String stateColumn) throws SQLException {
        Map<String, Long> counts = new TreeMap<>();
        String sql = "SELECT " + stateColumn + ", COUNT(*) FROM " + table
                + " GROUP BY " + stateColumn;
        try (Statement statement = connection.createStatement();
                ResultSet result = statement.executeQuery(sql)) {
            while (result.next()) {
                counts.put(result.getString(1), result.getLong(2));
            }
        }
        return counts;
    }

    private static Connection databaseConnection(
            ConfigurableEnvironment environment) throws SQLException {
        String user = environment.getProperty("spring.datasource.username", "");
        String password =
                environment.getProperty("spring.datasource.password", "");
        Properties credentials = new Properties();
        credentials.setProperty("user", user);
        credentials.setProperty("password", password);
        credentials.setProperty("connectTimeout",
                String.valueOf(TIMEOUT_MILLIS));
        credentials.setProperty("socketTimeout",
                String.valueOf(TIMEOUT_MILLIS));
        return DriverManager.getConnection(
                environment.getRequiredProperty("spring.datasource.url"),
                credentials);
    }

    private static void requirePerformanceSchemaGrant(Connection connection)
            throws SQLException {
        try (Statement statement = connection.createStatement();
                ResultSet result = statement.executeQuery(
                        "SELECT COUNT(*) FROM "
                                + "performance_schema.user_variables_by_thread")) {
            result.next();
        }
    }

    interface SchemaValidation {
        void run() throws SQLException;
    }

    // An older schema is what an upgrade looks like until its first start,
    // which migrates it forward; only a newer one cannot be served. A schema at
    // this release's version is held to the same validation the server runs
    // at startup: until the first formal release, a release may change its
    // baseline in place.
    static Check schemaCheck(String schema, String expected,
            SchemaValidation validation) {
        if (expected != null && schema != null && !expected.equals(schema)) {
            int order;
            try {
                order = MigrationVersion.fromVersion(schema)
                        .compareTo(MigrationVersion.fromVersion(expected));
            } catch (FlywayException error) {
                order = 1;
            }
            if (order > 0) {
                return new Check("database", Status.FAIL,
                        "schema=" + schema + " but the manifest expects "
                                + expected,
                        "install the distribution that matches the database;"
                                + " a database downgrade is unsupported");
            }
            if (order < 0) {
                return new Check("database", Status.WARN,
                        "schema=" + schema + "; the first start migrates it to "
                                + expected + ", which only a database backup"
                                + " undoes",
                        "back up the database before starting this"
                                + " distribution");
            }
        }
        if (schema != null) {
            try {
                validation.run();
            } catch (SQLException error) {
                return new Check("database", Status.FAIL,
                        "schema=" + schema + " does not match this"
                                + " distribution: " + error.getMessage(),
                        "start this distribution on a new, empty database, or"
                                + " keep the release that created this one");
            }
        }
        return new Check("database", Status.PASS,
                "schema=" + (schema == null ? "not migrated yet" : schema)
                        + "; performance_schema grant ok",
                null);
    }

    /** The database row for a reachable database: its schema, held to the server's validation. */
    static Check schemaCheck(Connection connection, String expected) {
        return schemaCheck(schemaVersion(connection), expected,
                () -> ManagedSchema.validate(connection));
    }

    private static String schemaVersion(Connection connection) {
        try (Statement statement = connection.createStatement();
                ResultSet result = statement.executeQuery(
                        "SELECT version FROM flyway_schema_history "
                                + "ORDER BY installed_rank DESC LIMIT 1")) {
            return result.next() ? result.getString(1) : null;
        } catch (SQLException error) {
            return null;
        }
    }

    static String expectedSchemaVersion() {
        Path manifest = manifestPath();
        return manifest == null ? null : expectedSchemaVersion(manifest);
    }

    static String expectedSchemaVersion(Path manifest) {
        try {
            JsonNode root = new ObjectMapper().readTree(manifest.toFile());
            JsonNode value = root.path("compatibility")
                    .path("databaseSchema").path("latestMigrationVersion");
            return value.isTextual() ? value.asText() : null;
        } catch (IOException error) {
            return null;
        }
    }

    static Path findManifest(String classPath) {
        if (classPath == null) {
            return null;
        }
        for (String entry : classPath.split(File.pathSeparator)) {
            Path file = Path.of(entry).toAbsolutePath().normalize();
            if (!entry.endsWith(".jar") || !Files.isRegularFile(file)) {
                continue;
            }
            Path lib = file.getParent();
            Path root = lib == null ? null : lib.getParent();
            if (root == null) {
                continue;
            }
            Path manifest = root.resolve("manifest.json");
            if (Files.isRegularFile(manifest)) {
                return manifest;
            }
        }
        return null;
    }

    private static Path manifestPath() {
        Path fromClassPath = findManifest(
                System.getProperty("java.class.path", ""));
        if (fromClassPath != null) {
            return fromClassPath;
        }
        try {
            Path code = Path.of(ManagedAgentPreflight.class
                    .getProtectionDomain().getCodeSource().getLocation()
                    .toURI());
            if (!Files.isRegularFile(code)) {
                return null;
            }
            Path lib = code.getParent();
            Path root = lib == null ? null : lib.getParent();
            if (root == null) {
                return null;
            }
            Path manifest = root.resolve("manifest.json");
            return Files.isRegularFile(manifest) ? manifest : null;
        } catch (Exception error) {
            return null;
        }
    }

    private static void print(List<Check> checks) {
        System.out.println("Managed Agent preflight");
        System.out.printf("%-6s %-14s %s%n", "STATUS", "CHECK", "DETAIL");
        for (Check check : checks) {
            System.out.printf("%-6s %-14s %s%n",
                    check.status(), check.name(), check.detail());
            if (check.fix() != null) {
                System.out.printf("%-6s %-14s fix: %s%n",
                        "", "", check.fix());
            }
        }
        long failures = checks.stream()
                .filter(check -> check.status() == Status.FAIL).count();
        long warnings = checks.stream()
                .filter(check -> check.status() == Status.WARN).count();
        System.out.printf("%d check(s), %d warning(s), %d failure(s)%n",
                checks.size(), warnings, failures);
    }

    static boolean isLoopback(String address) {
        return StringUtils.isBlank(address)
                || "127.0.0.1".equals(address)
                || "::1".equals(address)
                || "localhost".equalsIgnoreCase(address);
    }

    static boolean isDigest(String value) {
        return value != null && DIGEST.matcher(value).matches();
    }

    static boolean isCredentialKey(String value) {
        if (StringUtils.isBlank(value)) {
            return false;
        }
        try {
            return Base64.getDecoder().decode(value).length == KEY_BYTES;
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private static String trimTrailingSlash(String value) {
        String trimmed = value;
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }

    // Nothing the URL contains reaches the report, so a typo cannot print
    // credentials. Null unless it is an HTTP origin without user information,
    // a query or a fragment; the getUserInfo check is what keeps credentials
    // out, since every URL that carries them is rejected here.
    private static URI harnessOrigin(String base) {
        try {
            URI origin = URI.create(base);
            String scheme = origin.getScheme();
            return ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                    && origin.getHost() != null
                    && origin.getUserInfo() == null
                    && origin.getQuery() == null
                    && origin.getFragment() == null
                    ? origin : null;
        } catch (IllegalArgumentException unusable) {
            return null;
        }
    }

    private static Check unusableHarnessUrl() {
        return new Check("harness", Status.FAIL,
                "the Harness base URL is not usable",
                "set QWEN_MANAGED_AGENT_HARNESS_BASE_URL to the Harness http(s)"
                        + " origin, without credentials, a query or a fragment");
    }

    // Text another process controls, kept to one bounded line.
    static String printable(String text) {
        String line = text.codePoints()
                .map(c -> Character.isISOControl(c) ? '?' : c)
                .collect(StringBuilder::new, StringBuilder::appendCodePoint,
                        StringBuilder::append)
                .toString();
        int points = line.codePointCount(0, line.length());
        return points > 200
                ? line.substring(0, line.offsetByCodePoints(0, 200)) + "..."
                : line;
    }

    static String rootMessage(Throwable error) {
        Throwable current = error;
        while (current.getCause() != null) {
            current = current.getCause();
        }
        return current.getMessage() == null
                ? current.getClass().getSimpleName()
                : current.getMessage();
    }

    enum Status {
        PASS, WARN, FAIL, SKIP
    }

    record Check(String name, Status status, String detail, String fix) {
    }
}
