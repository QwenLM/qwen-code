package com.alibaba.qwen.code.managedagent.preflight;

import com.alibaba.qwen.code.managedagent.config.BrokerSecurity;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.lang3.StringUtils;
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
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.regex.Pattern;

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
        List<Check> checks = new ArrayList<>();
        ConfigurableEnvironment environment = baseEnvironment(args);
        List<String> locations = configLocations(args, environment);
        loadConfiguration(environment, locations, checks);
        ManagedAgentProperties properties = bind(environment, checks);
        checks.add(javaCheck());
        checks.add(configFileCheck(locations));
        checks.add(startupValidationCheck(properties));
        checks.add(keyRingCheck(properties));
        checks.add(authCheck(environment, properties));
        checks.add(harnessCheck(properties));
        checks.add(toolPathCheck(properties));
        checks.addAll(brokerChecks(properties));
        checks.add(workspaceCheck(properties));
        checks.add(portCheck("server",
                environment.getProperty("server.address", "127.0.0.1"),
                environment.getProperty("server.port", Integer.class,
                        DEFAULT_SERVER_PORT)));
        if (properties.getRuntimeBroker().isEnabled()) {
            checks.add(portCheck("broker",
                    properties.getRuntimeBroker().getHost(),
                    properties.getRuntimeBroker().getPort()));
        }
        checks.add(databaseCheck(environment));
        print(checks);
        return checks.stream().anyMatch(check ->
                check.status() == Status.FAIL) ? 1 : 0;
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

    private static ManagedAgentProperties bind(
            ConfigurableEnvironment environment, List<Check> checks) {
        try {
            return Binder.get(environment)
                    .bind("qwen.managed-agent",
                            Bindable.of(ManagedAgentProperties.class))
                    .orElseGet(ManagedAgentProperties::new);
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

    static Check configFileCheck(List<String> locations) {
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
        if (!Files.isReadable(file)) {
            return new Check("config", Status.FAIL,
                    path + " is not readable", "chmod 600 " + path);
        }
        try {
            String content = Files.readString(file, StandardCharsets.UTF_8);
            boolean secrets = content.contains("credential-key")
                    || content.contains("signing-key")
                    || content.contains("password");
            Set<PosixFilePermission> permissions =
                    Files.getPosixFilePermissions(file);
            if (secrets && (permissions.contains(PosixFilePermission.GROUP_READ)
                    || permissions.contains(
                    PosixFilePermission.OTHERS_READ))) {
                return new Check("config", Status.WARN,
                        path + " is group- or world-readable",
                        "chmod 600 " + path);
            }
        } catch (IOException | UnsupportedOperationException error) {
            return new Check("config", Status.WARN,
                    path + ": cannot inspect permissions", null);
        }
        return new Check("config", Status.PASS, path, null);
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

    static Check harnessCheck(ManagedAgentProperties properties) {
        ManagedAgentProperties.Harness harness = properties.getHarness();
        if (!harness.isEnabled()) {
            return new Check("harness", Status.SKIP, "disabled", null);
        }
        if (StringUtils.isBlank(harness.getToken())) {
            return new Check("harness", Status.FAIL, "token is empty",
                    "set QWEN_MANAGED_AGENT_HARNESS_TOKEN");
        }
        if (!isDigest(harness.getCapabilityDigest())) {
            return new Check("harness", Status.FAIL,
                    "capability digest is not sha256:<64 lowercase hex>",
                    "set QWEN_MANAGED_AGENT_CAPABILITY_DIGEST");
        }
        String baseUrl = harness.getBaseUrl();
        if (StringUtils.isBlank(baseUrl)) {
            return new Check("harness", Status.FAIL, "base URL is empty",
                    "set QWEN_MANAGED_AGENT_HARNESS_BASE_URL");
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
                        "set QWEN_MANAGED_AGENT_HARNESS_TOKEN to the token the"
                                + " Harness accepts");
            }
            if (response.statusCode() != 200) {
                return new Check("harness", Status.FAIL,
                        url + " answered " + response.statusCode(),
                        "start a compatible Hosted Harness");
            }
            return new Check("harness", Status.PASS,
                    url + " reachable; the digest is checked on the first "
                            + "Session",
                    null);
        } catch (IOException | RuntimeException error) {
            return new Check("harness", Status.FAIL,
                    url + " is unreachable: " + rootMessage(error),
                    "start `qwen serve --profile hosted-harness`");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return new Check("harness", Status.FAIL,
                    url + " probe was interrupted", null);
        }
    }

    static Check toolPathCheck(ManagedAgentProperties properties) {
        ManagedAgentProperties.Harness harness = properties.getHarness();
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        boolean files = harness.isWorkspaceFilesEnabled();
        boolean shell = harness.isWorkspaceShellEnabled();
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
        if (StringUtils.isBlank(broker.getToken())) {
            checks.add(new Check("broker", Status.FAIL, "token is empty",
                    "set QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN"));
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
        checks.add(directoryCheck("broker-state",
                broker.getStateDirectory()));
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
        } else {
            checks.add(new Check("broker", Status.FAIL,
                    "unknown provisioner " + broker.getProvisioner(),
                    "use local-process or static"));
        }
        return checks;
    }

    private static Check workspaceCheck(ManagedAgentProperties properties) {
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

    private static Check portCheck(String name, String address, int port) {
        InetSocketAddress endpoint = new InetSocketAddress(address, port);
        if (endpoint.isUnresolved()) {
            return new Check(name + "-port", Status.FAIL,
                    "cannot resolve " + address,
                    "fix the bind address");
        }
        try (ServerSocket socket = new ServerSocket()) {
            socket.setReuseAddress(false);
            socket.bind(endpoint);
            return new Check(name + "-port", Status.PASS,
                    address + ":" + port + " is free", null);
        } catch (IOException error) {
            return new Check(name + "-port", Status.FAIL,
                    address + ":" + port + " is unavailable: "
                            + rootMessage(error),
                    "stop the process holding it or choose another port");
        }
    }

    static Check databaseCheck(ConfigurableEnvironment environment) {
        String url = environment.getProperty("spring.datasource.url");
        String user = environment.getProperty("spring.datasource.username", "");
        String password =
                environment.getProperty("spring.datasource.password", "");
        if (StringUtils.isBlank(url)) {
            return new Check("database", Status.FAIL,
                    "no datasource URL", "set SPRING_DATASOURCE_URL");
        }
        Properties credentials = new Properties();
        credentials.setProperty("user", user);
        credentials.setProperty("password", password);
        credentials.setProperty("connectTimeout",
                String.valueOf(TIMEOUT_MILLIS));
        credentials.setProperty("socketTimeout",
                String.valueOf(TIMEOUT_MILLIS));
        try (Connection connection =
                DriverManager.getConnection(url, credentials)) {
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
            String schema = schemaVersion(connection);
            String expected = expectedSchemaVersion();
            if (expected != null && schema != null
                    && !expected.equals(schema)) {
                return new Check("database", Status.FAIL,
                        "schema=" + schema + " but the manifest expects "
                                + expected,
                        "install the distribution that matches the database");
            }
            return new Check("database", Status.PASS,
                    "schema=" + (schema == null ? "not migrated yet" : schema)
                            + "; performance_schema grant ok",
                    null);
        } catch (SQLException error) {
            return new Check("database", Status.FAIL,
                    url + ": " + error.getMessage(),
                    "check the datasource settings, grants and that MySQL 8 "
                            + "is running");
        }
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

    private static String rootMessage(Throwable error) {
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
