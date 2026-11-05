package com.alibaba.qwen.code.managedagent.preflight;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.ApplicationContextFactory;
import org.springframework.boot.WebApplicationType;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.MutablePropertySources;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.env.SystemEnvironmentPropertySource;

import java.io.IOException;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeFalse;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The preflight reads the configuration the server reads (#16057): Spring's
 * own preparation of the environment, so files at its default locations,
 * imports and profile files count, and a configuration the server would
 * refuse fails the config row.
 */
class ServerEnvironmentTest {
    @TempDir
    Path directory;

    /** A servlet environment with these process variables and no system properties. */
    private static ConfigurableEnvironment environment(Map<String, Object> variables) {
        ConfigurableEnvironment environment = ApplicationContextFactory.DEFAULT
                .createEnvironment(WebApplicationType.SERVLET);
        MutablePropertySources sources = environment.getPropertySources();
        sources.replace(
                StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                new SystemEnvironmentPropertySource(
                        StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                        variables));
        sources.replace(
                StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME,
                new MapPropertySource(
                        StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME,
                        Map.of()));
        return environment;
    }

    /** What the launcher or server.env sets. */
    private static ConfigurableEnvironment named(String locations) {
        return environment(Map.of("SPRING_CONFIG_ADDITIONAL_LOCATION", locations));
    }

    private Path write(String name, String text) throws IOException {
        Path file = directory.resolve(name);
        Files.createDirectories(file.getParent());
        Files.writeString(file, text);
        return file;
    }

    private static ManagedAgentPreflight.Prepared prepare(
            ConfigurableEnvironment environment,
            List<ManagedAgentPreflight.Check> checks, String... args) {
        return ManagedAgentPreflight.prepare(args, environment, checks);
    }

    /** The config rows of a preparation, as this process. */
    private static List<ManagedAgentPreflight.Check> rows(
            ManagedAgentPreflight.Prepared prepared) {
        return ManagedAgentPreflight.configChecks(prepared, null,
                System.getProperty("user.name"));
    }

    /** The one row for a configuration Spring refused. */
    private static ManagedAgentPreflight.Check refused(ConfigurableEnvironment environment) {
        ManagedAgentPreflight.Prepared prepared =
                prepare(environment, new ArrayList<>());
        List<ManagedAgentPreflight.Check> rows = rows(prepared);
        assertEquals(1, rows.size(), rows.toString());
        assertEquals(ManagedAgentPreflight.Status.FAIL, rows.get(0).status());
        return rows.get(0);
    }

    /** What Spring throws for a file, as the server would meet it. */
    private static RuntimeException thrown(ConfigurableEnvironment environment) {
        return assertThrows(RuntimeException.class,
                () -> ServerEnvironment.prepare(new String[0], environment));
    }

    private static int freePort() throws IOException {
        try (ServerSocket probe = new ServerSocket(0)) {
            return probe.getLocalPort();
        }
    }

    private static boolean nobodyExists() {
        try {
            return ServiceAccount.lookup("nobody").isPresent();
        } catch (IOException error) {
            return false;
        }
    }

    @Test
    void readsEveryFileTheServerReadsBesideTheNamedOne() throws IOException {
        // server.env names /etc's file, and the server also reads the
        // distribution's config/application.yml, which Spring finds at its
        // default ./config/ location in the unit's working directory. This
        // JVM's working directory is the module's, so the test names that
        // directory; readsTheFilesAtTheDefaultLocationsOfTheDirectoryItRunsIn
        // reads it unnamed, in a JVM of its own.
        Path imported = write("etc/runtime.yml", "server.address: 127.0.0.2\n");
        Path named = write("etc/application.yml", "spring.profiles.active: edge\n"
                + "spring.config.import: file:" + imported + "\n");
        // A named file's profile variant keeps its extension.
        Path profile = write("etc/application-edge.yml",
                "qwen.managed-agent.harness.base-url: http://127.0.0.1:4171\n");
        Path beside = write("dist/config/application.yml", "server.port: 9090\n");
        List<ManagedAgentPreflight.Check> checks = new ArrayList<>();
        ManagedAgentPreflight.Prepared prepared = prepare(named("file:" + named
                + ",optional:file:" + beside.getParent() + "/"), checks);

        assertTrue(checks.isEmpty(), checks.toString());
        assertNull(prepared.failure());
        ConfigurableEnvironment environment = prepared.environment();
        assertEquals("9090", environment.getProperty("server.port"));
        assertEquals("127.0.0.2", environment.getProperty("server.address"));
        assertEquals("http://127.0.0.1:4171",
                environment.getProperty("qwen.managed-agent.harness.base-url"));
        // The packaged defaults are read too, and listed as no file.
        assertEquals("qwen-managed-agent-server",
                environment.getProperty("spring.application.name"));
        assertEquals(Set.of(named, imported, profile, beside),
                Set.copyOf(prepared.files()));
        assertEquals(4, prepared.files().size(), prepared.files().toString());

        List<ManagedAgentPreflight.Check> rows = rows(prepared);
        assertEquals(4, rows.size(), rows.toString());
        for (ManagedAgentPreflight.Check row : rows) {
            assertEquals("config", row.name());
            assertEquals(ManagedAgentPreflight.Status.PASS, row.status(), row.toString());
            assertTrue(prepared.files().contains(Path.of(row.detail())), row.detail());
        }
    }

    @Test
    void listsAFileReadThroughTwoLocationsOnce() throws IOException {
        // The launcher names config/application.yml, which Spring's default
        // location in the distribution's root finds again.
        Path config = write("config/application.yml", "server.port: 9090\n");
        List<ManagedAgentPreflight.Check> checks = new ArrayList<>();
        ManagedAgentPreflight.Prepared prepared = prepare(named("file:" + config
                + ",optional:file:" + config.getParent() + "/"), checks);
        assertTrue(checks.isEmpty(), checks.toString());
        assertEquals(List.of(config), prepared.files());
    }

    @Test
    void laterLocationsOverrideEarlierOnesWithoutDroppingKeys() throws IOException {
        Path first = write("first.yml", "server:\n  address: 0.0.0.0\n  port: 1\n");
        Path second = write("second.yml", "server:\n  port: 0\n");
        List<ManagedAgentPreflight.Check> checks = new ArrayList<>();
        ConfigurableEnvironment environment = prepare(environment(Map.of()),
                checks, "--spring.config.additional-location=file:" + first
                        + ",file:" + second).environment();
        assertTrue(checks.isEmpty(), checks.toString());
        assertEquals("0.0.0.0", environment.getProperty("server.address"));
        assertEquals("0", environment.getProperty("server.port"));
    }

    @Test
    void theArgumentNamesTheLocationOverTheVariable() throws IOException {
        Path argument = write("argument.yml", "server.port: 9091\n");
        Path variable = write("variable.yml", "server.port: 9092\n");
        List<ManagedAgentPreflight.Check> checks = new ArrayList<>();
        ManagedAgentPreflight.Prepared prepared = prepare(named("file:" + variable),
                checks, "--spring.config.additional-location=file:" + argument);
        assertTrue(checks.isEmpty(), checks.toString());
        assertEquals("9091", prepared.environment().getProperty("server.port"));
        assertEquals(List.of(argument), prepared.files());
    }

    @Test
    void failsTheConfigRowWhereTheServerWouldNotStart() throws IOException {
        Path missing = directory.resolve("missing.yml");
        List<ManagedAgentPreflight.Check> checks = new ArrayList<>();
        ManagedAgentPreflight.Prepared prepared =
                prepare(named("file:" + missing), checks);
        assertTrue(checks.isEmpty(), checks.toString());
        List<ManagedAgentPreflight.Check> rows = rows(prepared);
        assertEquals(1, rows.size(), rows.toString());
        ManagedAgentPreflight.Check config = rows.get(0);
        assertEquals("config", config.name());
        assertEquals(ManagedAgentPreflight.Status.FAIL, config.status());
        assertEquals(missing + " does not exist", config.detail());
        assertEquals("create it, or correct the location that names it",
                config.fix());
        assertNull(prepared.failure().unreadable());
        // No file rows follow, and the other rows read the packaged defaults.
        assertEquals(List.of(), prepared.files());
        assertEquals("qwen-managed-agent-server",
                prepared.environment().getProperty("spring.application.name"));

        // An import names a location as well.
        Path importing = write("importing.yml",
                "spring.config.import: file:" + missing + "\n");
        assertEquals(missing + " does not exist",
                refused(named("file:" + importing)).detail());

        // A file Spring cannot parse stops the server too. Spring's error
        // names no file, so the row finds the one that does not parse.
        Path fine = write("fine.yml", "server.port: 9090\n");
        Path broken = write("broken.yml", "server: [\n");
        ManagedAgentPreflight.Check yaml = refused(named("file:" + fine + ",file:" + broken));
        assertEquals(broken + ", line 2, column 1: expected the node content,"
                + " but found '<stream end>'", yaml.detail());
        assertEquals("fix the YAML syntax", yaml.fix());
        // In a file an import names from inside another, it says what it can.
        Path importer = write("importer.yml",
                "spring.config.import: file:" + broken + "\n");
        assertEquals("a configuration file, line 2, column 1: expected the node"
                + " content, but found '<stream end>'",
                refused(named("file:" + importer)).detail());
    }

    @Test
    void theOtherRowsReadWhatSpringWasGivenWhereItRefuses() throws IOException {
        Path fine = write("fine.yml", "server.port: 9090\n");
        Path broken = write("broken.yml", "server: [\n");
        Map<String, Object> variables = new HashMap<>();
        variables.put("SPRING_CONFIG_ADDITIONAL_LOCATION", "file:" + fine + ",file:" + broken);
        variables.put("SERVER_ADDRESS", "127.0.0.2");
        variables.put("QWEN_MANAGED_AGENT_SERVICE_USER", "qwen-preflight-stranger");
        List<ManagedAgentPreflight.Check> checks = new ArrayList<>();
        ManagedAgentPreflight.Prepared prepared = prepare(environment(variables), checks,
                "--server.address=0.0.0.0", "--qwen.managed-agent.auth.mode=open");
        assertTrue(prepared.failure().detail().startsWith(broken.toString()),
                prepared.failure().toString());
        ConfigurableEnvironment environment = prepared.environment();
        // The arguments over the process environment, which the packaged
        // defaults map; no file Spring read before it failed.
        assertEquals("0.0.0.0", environment.getProperty("server.address"));
        assertEquals("open", environment.getProperty("qwen.managed-agent.auth.mode"));
        assertEquals("qwen-preflight-stranger",
                ManagedAgentPreflight.bind(environment, checks).getServiceUser());
        assertEquals("qwen-managed-agent-server",
                environment.getProperty("spring.application.name"));
        assertTrue(!"9090".equals(environment.getProperty("server.port")),
                environment.getProperty("server.port"));
        assertTrue(checks.isEmpty(), checks.toString());
    }

    @Test
    void namesTheProfileVariantThatDoesNotParse() throws IOException {
        // The named file activates the profile, so the environment Spring
        // was given does not say which variants it read.
        Path named = write("etc/application.yml", "spring.profiles.active: edge\n");
        Path edge = write("etc/application-edge.yml", "server: [\n");
        // A variant no profile activates may hold another error, or the same
        // one elsewhere, and is no culprit; they sort first.
        write("etc/application-a.yml", "a: b: c\n");
        write("etc/application-b.yml", "a: 1\nserver: [\n");
        assertEquals(edge + ", line 2, column 1: expected the node content,"
                + " but found '<stream end>'", refused(named("file:" + named)).detail());
        // In a directory location as well.
        Path config = write("dist/config/application.yml", "spring.profiles.active: edge\n");
        Path variant = write("dist/config/application-edge.yml", "server: [\n");
        assertEquals(variant + ", line 2, column 1: expected the node content,"
                + " but found '<stream end>'",
                refused(named("optional:file:" + config.getParent() + "/")).detail());
    }

    @Test
    void namesTheFileThisProcessCannotRead() throws IOException {
        // Spring words it as its cause's FileNotFoundException, with the
        // location as written; the row names the file and the account.
        Path locked = write("locked.yml", "server.port: 9090\n");
        Files.setPosixFilePermissions(locked, PosixFilePermissions.fromString("---------"));
        assumeFalse(Files.isReadable(locked), "root reads any file");
        ManagedAgentPreflight.Check config = refused(named("file:" + locked));
        String user = System.getProperty("user.name");
        assertEquals(locked + " is not readable by " + user, config.detail());
        assertEquals("chown " + user + " " + locked + ", chmod 600 " + locked
                + ", and let " + user + " enter every directory on its path,"
                + " following symbolic links", config.fix());
    }

    @Test
    void namesTheServiceAccountWhereTheServerCannotReadTheFile() throws IOException {
        // The guide's second terminal: neither root nor the service account
        // runs the check, with server.env's QWEN_MANAGED_AGENT_SERVICE_USER.
        Path locked = write("etc/application.yml", "server.port: 9090\n");
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwxr-xr-x"));
        Files.setPosixFilePermissions(locked.getParent(),
                PosixFilePermissions.fromString("rwxr-xr-x"));
        Files.setPosixFilePermissions(locked, PosixFilePermissions.fromString("---------"));
        assumeFalse(Files.isReadable(locked), "root reads any file");
        assumeTrue(nobodyExists(), "no account named nobody");
        Map<String, Object> variables = new HashMap<>();
        variables.put("SPRING_CONFIG_ADDITIONAL_LOCATION", "file:" + locked);
        variables.put("QWEN_MANAGED_AGENT_SERVICE_USER", "nobody");
        // The server cannot read it either: the fix is for its account.
        List<ManagedAgentPreflight.Check> config = ManagedAgentPreflight.checks(
                new String[] {"--check", "--spring.datasource.url="}, environment(variables))
                .stream().filter(row -> row.name().equals("config")).toList();
        assertEquals(1, config.size(), config.toString());
        assertEquals(locked + " is not readable by nobody", config.get(0).detail());
        assertEquals(ManagedAgentPreflight.unreadableFix("nobody", locked.toString()),
                config.get(0).fix());
        // Only this process cannot read it, so it cannot check what the server reads.
        Files.setPosixFilePermissions(locked, PosixFilePermissions.fromString("------r--"));
        config = ManagedAgentPreflight.checks(
                new String[] {"--check", "--spring.datasource.url="}, environment(variables))
                .stream().filter(row -> row.name().equals("config")).toList();
        assertEquals(locked + " is not readable by " + System.getProperty("user.name")
                + ", which runs this check", config.get(0).detail());
        assertEquals("run --check as nobody or as root", config.get(0).fix());
    }

    @Test
    void namesTheAccountThatMustReadTheFileItCannot() throws IOException {
        // As root reads every file, the failure Spring would meet is given.
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwxr-xr-x"));
        Path shared = write("shared.yml", "server.port: 9090\n");
        Path own = write("own.yml", "server.port: 9090\n");
        Files.setPosixFilePermissions(shared, PosixFilePermissions.fromString("rw-r--r--"));
        Files.setPosixFilePermissions(own, PosixFilePermissions.fromString("rw-------"));
        ServiceAccount stranger = new ServiceAccount("qwen-preflight-stranger", Set.of());
        // The service account cannot read it either.
        ManagedAgentPreflight.Check check = ManagedAgentPreflight.configFailureCheck(
                new ServerEnvironment.Failure("x", "y", own), stranger, "operator");
        assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
        assertEquals(own + " is not readable by qwen-preflight-stranger", check.detail());
        assertEquals(ManagedAgentPreflight.unreadableFix("qwen-preflight-stranger",
                own.toString()), check.fix());
        // It can, so this process cannot check what the server reads.
        check = ManagedAgentPreflight.configFailureCheck(
                new ServerEnvironment.Failure("x", "y", shared), stranger, "operator");
        assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
        assertEquals(shared + " is not readable by operator, which runs this check",
                check.detail());
        assertEquals("run --check as qwen-preflight-stranger or as root", check.fix());
        // A path this process cannot look along leaves the account's view unknown.
        Path unseen = directory.resolve("gone/application.yml");
        check = ManagedAgentPreflight.configFailureCheck(
                new ServerEnvironment.Failure("x", "y", unseen), stranger, "operator");
        assertEquals("run --check as qwen-preflight-stranger or as root", check.fix());
        // Without a service account, the row names this process, as Spring's failure does.
        check = ManagedAgentPreflight.configFailureCheck(
                new ServerEnvironment.Failure("x", "y", own), null, "operator");
        assertEquals("x", check.detail());
        assertEquals("y", check.fix());
        // A failure that is not about reading a file is not about an account.
        check = ManagedAgentPreflight.configFailureCheck(
                new ServerEnvironment.Failure("x", "y"), stranger, "operator");
        assertEquals("x", check.detail());
    }

    @Test
    void saysAFileBehindADirectoryItCannotEnterIsNotMissing() throws IOException {
        // Spring reads a file it cannot see as missing; this process can
        // only tell that it cannot tell.
        Path hidden = directory.resolve("etc/application.yml");
        ConfigurableEnvironment environment = named("file:" + hidden);
        RuntimeException error = thrown(environment);
        ServerEnvironment.Failure failure = ServerEnvironment.failure(error, environment,
                file -> true, file -> !file.equals(hidden), directory);
        assertEquals(hidden + " is not readable by " + System.getProperty("user.name"),
                failure.detail());
        assertEquals(hidden, failure.unreadable());
        assertEquals(hidden + " does not exist", ServerEnvironment.failure(error,
                environment, file -> true, file -> true, directory).detail());
    }

    /** Spring's error for a file this process cannot read. */
    private static RuntimeException cannotRead(String file) {
        return new IllegalStateException(new java.io.FileNotFoundException(
                file + " (Permission denied)"));
    }

    @Test
    void namesTheFileTheProcessCannotReadAmongThoseItMayHaveFailedOn() throws IOException {
        // As root reads every file, the account's view is passed in.
        Path fine = write("fine.yml", "server.port: 9090\n");
        Path locked = write("dist/config/application.yml", "server.port: 9091\n");
        String user = System.getProperty("user.name");
        ServerEnvironment.Failure failure = ServerEnvironment.failure(cannotRead("x"),
                named("file:" + fine + ",optional:file:" + locked.getParent() + "/"),
                file -> !file.toAbsolutePath().normalize().equals(locked),
                file -> false, directory);
        assertEquals(locked + " is not readable by " + user, failure.detail());
        assertEquals(locked, failure.unreadable());
        // A file it reads and that parses is no culprit.
        assertEquals("x (Permission denied)", ServerEnvironment.failure(cannotRead("x"),
                named("file:" + fine), file -> true, file -> false, directory).detail());
        // Nor is one it cannot read when Spring failed on no read.
        assertEquals("bad value", ServerEnvironment.failure(
                new IllegalStateException("bad value"),
                named("file:" + fine + ",optional:file:" + locked.getParent() + "/"),
                file -> !file.toAbsolutePath().normalize().equals(locked),
                file -> false, directory).detail());
        // A profile variant may be what Spring could not read.
        Path variant = write("dist/config/application-edge.yml", "server.port: 9092\n");
        assertEquals(variant + " is not readable by " + user, ServerEnvironment.failure(
                cannotRead("x"),
                named("file:" + fine + ",optional:file:" + locked.getParent() + "/"),
                file -> !file.toAbsolutePath().normalize().equals(variant),
                file -> false, directory).detail());
    }

    @Test
    void looksAtTheDefaultLocationsInTheWorkingDirectory() throws IOException {
        // Nothing names the distribution's config/application.yml, which the
        // server finds in its working directory, as Spring finds it.
        Path config = write("config/application.yml", "server:\n  port: [\n");
        RuntimeException error = thrown(named("file:" + config));
        ServerEnvironment.Failure failure = ServerEnvironment.failure(error,
                environment(Map.of()), file -> true, file -> false, directory);
        assertEquals(config + ", line 3, column 1: expected the node content,"
                + " but found '<stream end>'", failure.detail());
        // Unless spring.config.location replaces them.
        ServerEnvironment.Failure replaced = ServerEnvironment.failure(error,
                environment(Map.of("SPRING_CONFIG_LOCATION", "optional:classpath:/")),
                file -> true, file -> false, directory);
        assertEquals("a configuration file, line 3, column 1: expected the node content,"
                + " but found '<stream end>'", replaced.detail());
        // config/*/ is a default location too.
        Files.writeString(config, "server.port: 9090\n");
        Path nested = write("config/edge/application.yml", "server.port: 9091\n");
        assertEquals(nested + " is not readable by " + System.getProperty("user.name"),
                ServerEnvironment.failure(cannotRead("x"),
                        environment(Map.of()),
                        file -> !file.toAbsolutePath().normalize().equals(nested),
                        file -> false, directory).detail());
        // A location named relative to the working directory is read there.
        Path relative = write("etc/relative.yml", "server.port: 9094\n");
        assertEquals(relative + " is not readable by " + System.getProperty("user.name"),
                ServerEnvironment.failure(cannotRead("x"), named("file:etc/relative.yml"),
                        file -> !file.toAbsolutePath().normalize().equals(relative),
                        file -> false, directory).detail());
        // So is spring.config.name's.
        Path renamed = write("config/server.yml", "server.port: 9093\n");
        assertEquals(renamed + " is not readable by " + System.getProperty("user.name"),
                ServerEnvironment.failure(cannotRead("x"),
                        environment(Map.of("SPRING_CONFIG_NAME", "server")),
                        file -> !file.toAbsolutePath().normalize().equals(renamed),
                        file -> false, directory).detail());
    }

    @Test
    void listsTheFilesTheServerReadsThatHoldNoSetting() throws IOException {
        // The shipped example copied to a default location, every line a
        // comment: Spring reads it and adds no property source.
        Path named = write("etc/application.yml", "server.port: 9090\n");
        Path example = write("config/application.yml",
                "# spring.datasource.password: change-me\n");
        Path empty = write("conf.d/application.yml", "");
        ManagedAgentPreflight.Prepared prepared = prepare(named("file:" + named
                + ",optional:file:" + empty.getParent() + "/"), new ArrayList<>());
        assertEquals(List.of(named, empty), prepared.files());
        List<Path> files = ServerEnvironment.files(prepared.environment(), directory);
        assertEquals(List.of(named, empty, example), files);
        // Its row checks its permissions as any other.
        Files.setPosixFilePermissions(example, PosixFilePermissions.fromString("rw-r--r--"));
        List<ManagedAgentPreflight.Check> rows =
                ManagedAgentPreflight.configFileChecks(files, null);
        assertEquals(ManagedAgentPreflight.Status.WARN, rows.get(2).status(), rows.toString());
        assertEquals("chmod 600 " + example, rows.get(2).fix());
        // A variant of the active profile, or of the default one when none is.
        Path fallback = write("config/application-default.yml", "");
        assertEquals(List.of(named, empty, example, fallback),
                ServerEnvironment.files(prepared.environment(), directory));
        write("etc/application-edge.yml", "");
        prepared = prepare(named("file:" + named), new ArrayList<>(),
                "--spring.profiles.active=edge");
        assertEquals(List.of(named, directory.resolve("config/application.yml"),
                directory.resolve("etc/application-edge.yml")),
                ServerEnvironment.files(prepared.environment(), directory));
        // spring.config.location replaces the defaults.
        prepared = prepare(environment(Map.of("SPRING_CONFIG_LOCATION", "file:" + named)),
                new ArrayList<>());
        assertEquals(List.of(named), ServerEnvironment.files(prepared.environment(), directory));
    }

    @Test
    void listsEachFileOfAConfigTree() throws IOException {
        // Kubernetes mounts a Secret as one file for each property.
        Path password = write("secrets/spring.datasource.password", "hunter2");
        Path port = write("secrets/server.port", "9090");
        Files.setPosixFilePermissions(password, PosixFilePermissions.fromString("rw-r--r--"));
        Files.setPosixFilePermissions(port, PosixFilePermissions.fromString("rw-r--r--"));
        ManagedAgentPreflight.Prepared prepared = prepare(environment(Map.of()),
                new ArrayList<>(), "--spring.config.import=optional:configtree:"
                        + password.getParent() + "/");
        assertEquals("hunter2", prepared.environment().getProperty("spring.datasource.password"));
        assertEquals(Set.of(password, port), Set.copyOf(prepared.files()));
        // A value file is named for its property, so the name says it holds a secret.
        ManagedAgentPreflight.Check secret = ManagedAgentPreflight.configFileCheck(password, null);
        assertEquals(ManagedAgentPreflight.Status.WARN, secret.status());
        assertEquals("chmod 600 " + password, secret.fix());
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.configFileCheck(port, null).status());
    }

    @Test
    void checksThePermissionsOfAConfigurationFileInAnyEncoding() throws IOException {
        // Spring reads .properties as ISO-8859-1, where any byte is a character.
        Path properties = directory.resolve("config/application.properties");
        Files.createDirectories(properties.getParent());
        Files.write(properties, ("banner.caf\u00e9=x\nspring.datasource.password=s3cret\n")
                .getBytes(StandardCharsets.ISO_8859_1));
        // And YAML as UTF-16 after a byte order mark, either way round.
        Path big = directory.resolve("config/application.yml");
        Files.write(big, "spring.datasource.password: s3cret\n".getBytes(StandardCharsets.UTF_16));
        Path little = directory.resolve("config/application.yaml");
        Files.write(little, ("\ufeffspring.datasource.password: s3cret\n")
                .getBytes(StandardCharsets.UTF_16LE));
        for (Path file : List.of(properties, big, little)) {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.configFileCheck(file, null);
            assertEquals(ManagedAgentPreflight.Status.WARN, check.status(), check.toString());
            assertEquals(file + " is group- or world-readable", check.detail());
            assertEquals("chmod 600 " + file, check.fix());
        }
        // Spring reads them all.
        ManagedAgentPreflight.Prepared prepared = prepare(named("optional:file:"
                + properties.getParent() + "/"), new ArrayList<>());
        assertEquals(Set.of(properties, big, little), Set.copyOf(prepared.files()));
        assertNull(prepared.failure());
    }

    @Test
    void checksEachFileAsTheServiceAccount() throws IOException {
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwxr-xr-x"));
        Path shared = write("shared.yml", "server.port: 9090\n");
        Path own = write("own.yml", "server.port: 9091\n");
        Files.setPosixFilePermissions(shared, PosixFilePermissions.fromString("rw-r--r--"));
        Files.setPosixFilePermissions(own, PosixFilePermissions.fromString("rw-------"));
        List<ManagedAgentPreflight.Check> rows = ManagedAgentPreflight.configFileChecks(
                List.of(shared, own), new ServiceAccount("qwen-preflight-stranger", Set.of()));
        assertEquals(2, rows.size(), rows.toString());
        assertEquals(ManagedAgentPreflight.Status.PASS, rows.get(0).status(), rows.toString());
        assertEquals(ManagedAgentPreflight.Status.FAIL, rows.get(1).status());
        assertEquals(own + " is not readable by qwen-preflight-stranger", rows.get(1).detail());
        assertEquals(ManagedAgentPreflight.unreadableFix("qwen-preflight-stranger",
                own.toString()), rows.get(1).fix());
    }

    @Test
    void saysAWrappedCauseOnce() {
        // Spring wraps an I/O error in a message that repeats it.
        ServerEnvironment.Failure failure = ServerEnvironment.failure(
                new IllegalStateException("java.io.FileNotFoundException: x.yml (Permission denied)",
                        new java.io.FileNotFoundException("x.yml (Permission denied)")),
                environment(Map.of()), file -> true, file -> false, directory);
        assertEquals("x.yml (Permission denied)", failure.detail());
        assertEquals("correct the configuration Spring names", failure.fix());
        assertEquals("cannot bind: bad value", ServerEnvironment.failure(
                new IllegalStateException("cannot bind",
                        new IllegalArgumentException("bad\n  value")),
                environment(Map.of()), file -> true, file -> false, directory).detail());
    }

    @Test
    void warnsWhenTheServerReadsNoFile() {
        // An optional location that does not exist is no file the server reads.
        List<ManagedAgentPreflight.Check> checks = new ArrayList<>();
        ManagedAgentPreflight.Prepared prepared = prepare(named("optional:file:"
                + directory.resolve("missing.yml")), checks);
        assertTrue(checks.isEmpty(), checks.toString());
        assertEquals(List.of(), prepared.files());
        List<ManagedAgentPreflight.Check> rows = rows(prepared);
        assertEquals(1, rows.size());
        assertEquals(ManagedAgentPreflight.Status.WARN, rows.get(0).status());
        assertEquals("no configuration file; packaged defaults and the"
                + " environment only", rows.get(0).detail());
    }

    @Test
    void theRowsCheckTheSettingsFromAFileBesideTheNamedOne() throws IOException {
        // The issue's case: server.port only in the file the named one does
        // not mention. The server-port row checks the port the server binds.
        int free = freePort();
        // The named file holds no setting, as a copy of the example with
        // every line commented out does, and is listed all the same.
        Path named = write("etc/application.yml", "# server.port: 8080\n");
        Path beside = write("dist/config/application.yml",
                "server.port: " + free + "\n");
        List<ManagedAgentPreflight.Check> rows = ManagedAgentPreflight.checks(
                new String[] {"--check", "--spring.datasource.url="},
                named("file:" + named + ",optional:file:" + beside.getParent() + "/"));
        ManagedAgentPreflight.Check port = rows.stream()
                .filter(row -> row.name().equals("server-port"))
                .findFirst().orElseThrow();
        assertTrue(port.detail().contains(String.valueOf(free)), port.toString());
        List<String> config = rows.stream()
                .filter(row -> row.name().equals("config"))
                .map(row -> row.status() + " " + row.detail()).toList();
        assertEquals(2, config.size(), config.toString());
        assertEquals(Set.of("PASS " + named, "PASS " + beside), Set.copyOf(config));

        // With a service account, each row checks access as it.
        assumeTrue(nobodyExists(), "no account named nobody");
        Map<String, Object> variables = new HashMap<>();
        variables.put("SPRING_CONFIG_ADDITIONAL_LOCATION",
                "file:" + named + ",optional:file:" + beside.getParent() + "/");
        variables.put("QWEN_MANAGED_AGENT_SERVICE_USER", "nobody");
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
        config = ManagedAgentPreflight.checks(
                new String[] {"--check", "--spring.datasource.url="}, environment(variables))
                .stream().filter(row -> row.name().equals("config"))
                .map(row -> row.status() + " " + row.detail()).toList();
        assertEquals(Set.of("FAIL " + named + " is not readable by nobody",
                "FAIL " + beside + " is not readable by nobody"), Set.copyOf(config));
    }

    @Test
    void readsTheFilesAtTheDefaultLocationsOfTheDirectoryItRunsIn() throws Exception {
        // The server's own entry point, in a JVM whose working directory is
        // the distribution's root, as the unit runs it: nothing names a file.
        int free = freePort();
        Path config = write("config/application.yml", "server.port: " + free + "\n");
        Path example = write("application.yml", "# server.port: 8080\n");
        Path output = Files.createTempFile("preflight", ".out");
        try {
            ProcessBuilder builder = new ProcessBuilder(
                    Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                    "-cp", System.getProperty("java.class.path"),
                    "com.alibaba.qwen.code.managedagent.ManagedAgentServerApplication",
                    "--check", "--spring.datasource.url=")
                    .directory(directory.toFile())
                    .redirectErrorStream(true)
                    .redirectOutput(output.toFile());
            builder.environment().keySet().removeIf(name -> name.startsWith("SPRING_")
                    || name.startsWith("QWEN_MANAGED_AGENT_"));
            Process process = builder.start();
            if (!process.waitFor(120, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw new AssertionError("--check did not finish: " + Files.readString(output));
            }
            String report = Files.readString(output);
            Map<String, List<String>> rows = new HashMap<>();
            report.lines().map(line -> line.split("\\s+", 3))
                    .filter(row -> row.length == 3)
                    .forEach(row -> rows.computeIfAbsent(row[1], name -> new ArrayList<>())
                            .add(row[0] + " " + row[2]));
            // The file with a setting first, then the one without.
            assertEquals(List.of("PASS " + config, "PASS " + example), rows.get("config"), report);
            assertEquals(1, rows.get("server-port").size(), report);
            assertTrue(rows.get("server-port").get(0).contains(":" + free + " "), report);
        } finally {
            Files.deleteIfExists(output);
        }
    }
}
