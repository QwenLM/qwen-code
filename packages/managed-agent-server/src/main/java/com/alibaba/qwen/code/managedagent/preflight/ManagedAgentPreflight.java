package com.alibaba.qwen.code.managedagent.preflight;

import com.alibaba.qwen.code.managedagent.config.BrokerSecurity;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalRuntimeProvisioner;
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
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.UnknownHostException;
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
import java.sql.SQLTimeoutException;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Properties;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
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
        List<Check> checks = checks(args);
        print(checks);
        return checks.stream().anyMatch(check ->
                check.status() == Status.FAIL) ? 1 : 0;
    }

    static List<Check> checks(String[] args) {
        List<Check> checks = new ArrayList<>();
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
        checks.add(harnessCheck(properties));
        checks.add(credentialsFileCheck(properties, access.account()));
        checks.add(sessionStoreCheck(properties));
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

    static Check harnessCheck(ManagedAgentProperties properties) {
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
        if (!isDigest(harness.getCapabilityDigest())) {
            return new Check("harness", Status.FAIL,
                    "capability digest is not sha256:<64 lowercase hex>",
                    "set " + (StringUtils.isBlank(file)
                            ? "QWEN_MANAGED_AGENT_CAPABILITY_DIGEST"
                            : "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST in "
                                    + file));
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
        if (ExternalRuntimeProvisioner.KIND.equals(broker.getProvisioner()) && (files || shell)) {
            return new Check("tool-path", Status.FAIL,
                    "External Runtime supports scratch Sessions only",
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
        if (!ExternalRuntimeProvisioner.KIND.equals(broker.getProvisioner())) {
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
        } else if (ExternalRuntimeProvisioner.KIND.equals(broker.getProvisioner())) {
            try {
                properties.validateExternalRuntime();
                checks.add(new Check("broker", Status.PASS,
                        "external-scratch configuration accepted; provider reachability and worker attestation"
                                + " are checked on first use", null));
            } catch (RuntimeException error) {
                checks.add(new Check("broker", Status.FAIL, rootMessage(error),
                        "correct the external Runtime configuration"));
            }
        } else {
            checks.add(new Check("broker", Status.FAIL,
                    "unknown provisioner " + broker.getProvisioner(),
                    "use local-process, static or " + ExternalRuntimeProvisioner.KIND));
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
        if (ExternalRuntimeProvisioner.KIND.equals(properties.getRuntimeBroker().getProvisioner())) {
            return new Check("workspace", Status.SKIP,
                    "external scratch cwd belongs to the worker; no local directory required", null);
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
