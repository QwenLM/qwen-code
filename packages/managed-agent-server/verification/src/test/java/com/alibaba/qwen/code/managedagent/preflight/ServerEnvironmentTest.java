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
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeFalse;

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

    @Test
    void readsEveryFileTheServerReadsBesideTheNamedOne() throws IOException {
        // server.env names /etc's file, and the server also reads the
        // distribution's config/application.yml, which Spring finds at its
        // default ./config/ location in the unit's working directory.
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

        List<ManagedAgentPreflight.Check> rows =
                ManagedAgentPreflight.configFileChecks(prepared.files(), null);
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
        assertEquals(1, checks.size(), checks.toString());
        ManagedAgentPreflight.Check config = checks.get(0);
        assertEquals("config", config.name());
        assertEquals(ManagedAgentPreflight.Status.FAIL, config.status());
        assertEquals(missing + " does not exist", config.detail());
        assertEquals("create it, or correct the location that names it",
                config.fix());
        // No file rows follow, and the other rows read the packaged defaults.
        assertNull(prepared.files());
        assertEquals(List.of(),
                ManagedAgentPreflight.configFileChecks(prepared.files(), null));
        assertEquals("qwen-managed-agent-server",
                prepared.environment().getProperty("spring.application.name"));

        // An import names a location as well.
        Path importing = write("importing.yml",
                "spring.config.import: file:" + missing + "\n");
        checks.clear();
        prepare(named("file:" + importing), checks);
        assertEquals(ManagedAgentPreflight.Status.FAIL, checks.get(0).status());
        assertEquals(missing + " does not exist", checks.get(0).detail());

        // A file Spring cannot parse stops the server too. Spring's error
        // names no file, so the row finds the one that does not parse.
        Path fine = write("fine.yml", "server.port: 9090\n");
        Path broken = write("broken.yml", "server: [\n");
        checks.clear();
        prepare(named("file:" + fine + ",file:" + broken), checks);
        assertEquals(1, checks.size(), checks.toString());
        assertEquals(ManagedAgentPreflight.Status.FAIL, checks.get(0).status());
        assertEquals(broken + ", line 2, column 1: expected the node content,"
                + " but found '<stream end>'", checks.get(0).detail());
        assertEquals("fix the YAML syntax", checks.get(0).fix());
        // In a file an import names from inside another, it says what it can.
        Path importer = write("importer.yml",
                "spring.config.import: file:" + broken + "\n");
        checks.clear();
        prepare(named("file:" + importer), checks);
        assertEquals("a configuration file, line 2, column 1: expected the node"
                + " content, but found '<stream end>'", checks.get(0).detail());
    }

    @Test
    void namesTheFileThisProcessCannotRead() throws IOException {
        // Spring words it as its cause's FileNotFoundException, with the
        // location as written; the row names the file and the account.
        Path locked = write("locked.yml", "server.port: 9090\n");
        Files.setPosixFilePermissions(locked, PosixFilePermissions.fromString("---------"));
        assumeFalse(Files.isReadable(locked), "root reads any file");
        List<ManagedAgentPreflight.Check> checks = new ArrayList<>();
        prepare(named("file:" + locked), checks);
        assertEquals(1, checks.size(), checks.toString());
        String user = System.getProperty("user.name");
        assertEquals(locked + " is not readable by " + user, checks.get(0).detail());
        assertEquals("chown " + user + " " + locked + ", chmod 600 " + locked
                + ", and let " + user + " enter every directory on its path",
                checks.get(0).fix());
    }

    @Test
    void namesTheFileTheProcessCannotReadAmongThoseItMayHaveFailedOn() throws IOException {
        // As root reads every file, the account's view is passed in.
        Path fine = write("fine.yml", "server.port: 9090\n");
        Path locked = write("dist/config/application.yml", "server.port: 9091\n");
        String user = System.getProperty("user.name");
        ServerEnvironment.Failure failure = ServerEnvironment.failure(
                new IllegalStateException("java.io.FileNotFoundException: x"),
                named("file:" + fine + ",optional:file:" + locked.getParent() + "/"),
                file -> !file.toAbsolutePath().normalize().equals(locked), directory);
        assertEquals(locked + " is not readable by " + user, failure.detail());
        // A file it reads and that parses is no culprit.
        assertEquals("java.io.FileNotFoundException: x", ServerEnvironment.failure(
                new IllegalStateException("java.io.FileNotFoundException: x"),
                named("file:" + fine), file -> true, directory).detail());
    }

    @Test
    void looksAtTheDefaultLocationsInTheWorkingDirectory() throws IOException {
        // Nothing names the distribution's config/application.yml, which the
        // server finds in its working directory, as Spring finds it.
        Path config = write("config/application.yml", "server:\n  port: [\n");
        ServerEnvironment.Failure failure = ServerEnvironment.failure(
                new IllegalStateException("x"), environment(Map.of()), file -> true, directory);
        assertEquals(config + ", line 3, column 1: expected the node content,"
                + " but found '<stream end>'", failure.detail());
        // config/*/ is a default location too.
        Files.writeString(config, "server.port: 9090\n");
        Path nested = write("config/edge/application.yml", "server.port: 9091\n");
        assertEquals(nested + " is not readable by " + System.getProperty("user.name"),
                ServerEnvironment.failure(new IllegalStateException("x"),
                        environment(Map.of()),
                        file -> !file.toAbsolutePath().normalize().equals(nested),
                        directory).detail());
    }

    @Test
    void saysAWrappedCauseOnce() {
        // Spring wraps an I/O error in a message that repeats it.
        ServerEnvironment.Failure failure = ServerEnvironment.failure(
                new IllegalStateException("java.io.FileNotFoundException: x.yml (Permission denied)",
                        new java.io.FileNotFoundException("x.yml (Permission denied)")),
                environment(Map.of()));
        assertEquals("x.yml (Permission denied)", failure.detail());
        assertEquals("correct the configuration Spring names", failure.fix());
        assertEquals("cannot bind: bad value", ServerEnvironment.failure(
                new IllegalStateException("cannot bind",
                        new IllegalArgumentException("bad\n  value")),
                environment(Map.of())).detail());
    }

    @Test
    void warnsWhenTheServerReadsNoFile() {
        // An optional location that does not exist is no file the server reads.
        List<ManagedAgentPreflight.Check> checks = new ArrayList<>();
        ManagedAgentPreflight.Prepared prepared = prepare(named("optional:file:"
                + directory.resolve("missing.yml")), checks);
        assertTrue(checks.isEmpty(), checks.toString());
        assertEquals(List.of(), prepared.files());
        List<ManagedAgentPreflight.Check> rows =
                ManagedAgentPreflight.configFileChecks(prepared.files(), null);
        assertEquals(1, rows.size());
        assertEquals(ManagedAgentPreflight.Status.WARN, rows.get(0).status());
        assertEquals("no configuration file; packaged defaults and the"
                + " environment only", rows.get(0).detail());
    }

    @Test
    void theRowsCheckTheSettingsFromAFileBesideTheNamedOne() throws IOException {
        // The issue's case: server.port only in the file the named one does
        // not mention. The server-port row checks the port the server binds.
        int free;
        try (ServerSocket probe = new ServerSocket(0)) {
            free = probe.getLocalPort();
        }
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
    }
}
