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
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Arrays;
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

    /**
     * Skips where another account cannot reach the temporary directory, as
     * under macOS's per-user TMPDIR.
     */
    private void assumeOthersCanSearchTheDirectory() {
        for (Path parent = directory.toAbsolutePath().getParent(); parent != null;
                parent = parent.getParent()) {
            try {
                assumeTrue(Files.getPosixFilePermissions(parent)
                        .contains(PosixFilePermission.OTHERS_EXECUTE),
                        parent + " shuts other accounts out");
            } catch (IOException error) {
                assumeTrue(false, parent + ": " + error.getMessage());
            }
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
        // Reached through an import inside another file, as well.
        Path importer = write("importer.yml", "spring.config.import: file:" + locked + "\n");
        config = refused(named("file:" + importer));
        assertEquals(locked + " is not readable by " + user, config.detail());
        assertEquals(ManagedAgentPreflight.unreadableFix(user, locked.toString()), config.fix());
    }

    @Test
    void namesTheFileTheIoErrorNamesWhereverSpringFoundIt() throws IOException {
        // An import inside another file names a file no location does.
        Path secrets = write("etc/secrets.yml", "spring.datasource.password: x\n");
        String user = System.getProperty("user.name");
        java.util.function.Predicate<Path> locked =
                file -> !file.toAbsolutePath().normalize().equals(secrets);
        for (RuntimeException error : List.of(cannotRead(secrets.toString()),
                // Relative to the working directory, as Spring opened it.
                cannotRead("etc/secrets.yml"),
                // And as NIO words it.
                new IllegalStateException(new java.nio.file.AccessDeniedException(
                        secrets.toString())))) {
            ServerEnvironment.Failure failure = ServerEnvironment.failure(error,
                    environment(Map.of()), locked, file -> false, directory);
            assertEquals(secrets + " is not readable by " + user, failure.detail(),
                    error.toString());
            assertEquals(secrets, failure.unreadable());
        }
        // A file it can read is not the one Spring could not.
        assertEquals("etc/secrets.yml (Permission denied)", ServerEnvironment.failure(
                cannotRead("etc/secrets.yml"), environment(Map.of()), file -> true,
                file -> false, directory).detail());
    }

    @Test
    void namesTheServiceAccountWhereTheServerCannotReadTheFile() throws IOException {
        assumeOthersCanSearchTheDirectory();
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
        assumeOthersCanSearchTheDirectory();
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

    @Test
    void namesADirectoryItCannotLookInRatherThanNoFile() throws IOException {
        assumeOthersCanSearchTheDirectory();
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwxr-xr-x"));
        // The bootstrap's config/, root:qwen 0750, as the operator's own
        // login meets it: Spring skips the optional file it cannot see.
        Path secret = write("etc/application.yml", "spring.datasource.password: s3cret\n");
        Path etc = secret.getParent();
        Path secrets = Files.createDirectories(etc.resolve("secrets"));
        Path config = Files.createDirectories(directory.resolve("config/edge"));
        // The directories the rows name, after any link, as /private/var for macOS's /var.
        Path realEtc = etc.toRealPath();
        Path realConfig = config.getParent().toRealPath();
        Files.setPosixFilePermissions(secret, PosixFilePermissions.fromString("rw-r--r--"));
        Files.setPosixFilePermissions(etc, PosixFilePermissions.fromString("---rwx---"));
        try {
            assumeFalse(Files.isReadable(secret), "root enters any directory");
            String group = Files.readAttributes(etc, PosixFileAttributes.class)
                    .group().getName();
            String runner = System.getProperty("user.name");
            ServiceAccount member = new ServiceAccount("qwen-preflight-member", Set.of(group));
            ManagedAgentPreflight.Prepared prepared = prepare(
                    named("optional:file:" + secret), new ArrayList<>());
            assertNull(prepared.failure());
            assertEquals(List.of(), prepared.files());
            assertEquals(List.of(new ServerEnvironment.Hidden(realEtc, false)), prepared.hidden());
            List<ManagedAgentPreflight.Check> rows =
                    ManagedAgentPreflight.configChecks(prepared, member, runner);
            assertEquals(1, rows.size(), rows.toString());
            assertEquals(ManagedAgentPreflight.Status.FAIL, rows.get(0).status());
            assertEquals(realEtc + " cannot be entered by " + runner + ", which runs this check,"
                    + " and the server may read a configuration file in it", rows.get(0).detail());
            assertEquals("run --check as qwen-preflight-member or as root", rows.get(0).fix());
            // The directory it cannot enter, however deep the file under it.
            assertEquals(List.of(new ServerEnvironment.Hidden(realEtc, false)), prepare(
                    named("optional:file:" + etc.resolve("deeper/application.yml")),
                    new ArrayList<>()).hidden());
            // The directory a symbolic link on the way leads to, as the kernel
            // looks the name up: the link to it, or the file linked into it.
            Path link = Files.createSymbolicLink(directory.resolve("link"), etc);
            Path linked = Files.createSymbolicLink(
                    Files.createDirectories(directory.resolve("open")).resolve("application.yml"),
                    secret);
            for (Path through : List.of(link.resolve("application.yml"), linked)) {
                assertEquals(List.of(new ServerEnvironment.Hidden(realEtc, false)),
                        prepare(named("optional:file:" + through), new ArrayList<>()).hidden(),
                        through.toString());
            }
            // A config tree Spring cannot see is skipped as silently.
            ManagedAgentPreflight.Prepared tree = prepare(environment(Map.of()),
                    new ArrayList<>(), "--spring.config.import=optional:configtree:" + secrets + "/");
            assertNull(tree.failure());
            assertEquals(List.of(new ServerEnvironment.Hidden(realEtc, false)), tree.hidden());
            // Entering it is all the account needs to look a name up there.
            Files.setPosixFilePermissions(etc, PosixFilePermissions.fromString("-----x---"));
            assertEquals(ManagedAgentPreflight.Status.FAIL, ManagedAgentPreflight.hiddenCheck(
                    prepared.hidden().get(0), member, runner).status());
            Files.setPosixFilePermissions(etc, PosixFilePermissions.fromString("---rwx---"));
            // An account that cannot enter it either reads no file there; nor
            // does this process, which stands in for a service account unset
            // or its own.
            for (ServiceAccount account : Arrays.asList(
                    new ServiceAccount("qwen-preflight-stranger", Set.of()), null)) {
                rows = ManagedAgentPreflight.configChecks(prepared, account, runner);
                assertEquals(1, rows.size(), rows.toString());
                assertEquals("no configuration file; packaged defaults and the"
                        + " environment only", rows.get(0).detail());
            }
            // A file it does see is still judged beside the directory it cannot.
            Path seen = write("seen.yml", "server.port: 9090\n");
            prepared = prepare(named("file:" + seen + ",optional:file:" + secret),
                    new ArrayList<>());
            rows = ManagedAgentPreflight.configChecks(prepared, member, runner);
            assertEquals(List.of(ManagedAgentPreflight.Status.PASS,
                    ManagedAgentPreflight.Status.FAIL),
                    rows.stream().map(ManagedAgentPreflight.Check::status).toList(),
                    rows.toString());
            assertEquals(seen.toString(), rows.get(0).detail());
            // config/*/ lists config/, which this process may enter, not list.
            Files.setPosixFilePermissions(config.getParent(),
                    PosixFilePermissions.fromString("--xr-x---"));
            List<ServerEnvironment.Hidden> hidden =
                    ServerEnvironment.hidden(environment(Map.of()), directory);
            assertEquals(List.of(new ServerEnvironment.Hidden(realConfig, true)), hidden);
            assertEquals(realConfig + " cannot be listed by " + runner
                    + ", which runs this check, and the server may read a configuration"
                    + " file in it", ManagedAgentPreflight.hiddenCheck(hidden.get(0), member,
                            runner).detail());
            // An account that may enter it but not list it finds none there.
            Files.setPosixFilePermissions(config.getParent(),
                    PosixFilePermissions.fromString("--x--x---"));
            assertNull(ManagedAgentPreflight.hiddenCheck(hidden.get(0), member, runner));
        } finally {
            Files.setPosixFilePermissions(etc, PosixFilePermissions.fromString("rwx------"));
            Files.setPosixFilePermissions(config.getParent(),
                    PosixFilePermissions.fromString("rwx------"));
        }
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
        // The broker's token, a key of a map in a directory of its own, and
        // the ID of the active key, which is no secret.
        Path token = write("secrets/qwen.managed-agent.runtime-broker.token", "s3cr3t-token");
        Path old = write("secrets/qwen.managed-agent.runtime-broker.previous-credential-keys/old-v1",
                "a2V5");
        Path id = write("secrets/qwen.managed-agent.runtime-broker.credential-key-id", "v2");
        for (Path file : List.of(password, port, token, old, id)) {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
        }
        ManagedAgentPreflight.Prepared prepared = prepare(environment(Map.of()),
                new ArrayList<>(), "--spring.config.import=optional:configtree:"
                        + password.getParent() + "/");
        assertEquals("hunter2", prepared.environment().getProperty("spring.datasource.password"));
        assertEquals("a2V5", prepared.environment().getProperty(
                "qwen.managed-agent.runtime-broker.previous-credential-keys.old-v1"));
        assertEquals(Set.of(password, port, token, old, id), Set.copyOf(prepared.files()));
        assertEquals("qwen.managed-agent.runtime-broker.previous-credential-keys.old-v1",
                prepared.values().get(old));
        // A value file holds a value alone; its property says whether that is a secret.
        Map<Path, String> rows = new HashMap<>();
        for (ManagedAgentPreflight.Check row : rows(prepared)) {
            rows.put(Path.of(row.detail().split(" ")[0]),
                    row.status() + (row.fix() == null ? "" : " " + row.fix()));
        }
        assertEquals(Map.of(
                password, "WARN chmod 600 " + password,
                token, "WARN chmod 600 " + token,
                old, "WARN chmod 600 " + old,
                port, "PASS",
                id, "PASS"), rows);
        // A file that names its properties is judged by what it holds.
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.configFileCheck(password, null).status());
    }

    @Test
    void tellsTheSecretPropertiesAsTheConfigurationReferenceDoes() {
        for (String secret : List.of("spring.datasource.password",
                "qwen.managed-agent.auth.signing-key",
                "qwen.managed-agent.harness.token",
                "qwen.managed-agent.runtime-broker.credential-key",
                "qwen.managed-agent.runtime-broker.previous-credential-keys.old-v1",
                "qwen.managed-agent.runtime-broker.previous-credential-keys[old-v1]",
                "qwen.managed-agent.runtime-broker.external-provider-token",
                "qwen.managed-agent.runtime-broker.static-token",
                "qwen.managed-agent.runtime-broker.token",
                "qwen.managed-agent.session-store.binding-key",
                "SPRING_DATASOURCE_PASSWORD", "server.ssl.key-store-password",
                "example.secret",
                // Spellings Spring binds to the same property.
                "qwen.managed-agent.runtime-broker.credentialKey",
                "qwen.managed-agent.runtime-broker.credentialkey",
                "qwen.managed-agent.runtime-broker.credential_key",
                "qwen.managed-agent.runtime-broker.previous_credential_keys.old-v1",
                "qwen.managed-agent.auth.signingKey", "example.APIKey")) {
            assertTrue(ManagedAgentPreflight.secretProperty(secret), secret);
        }
        // Paths to files that hold a secret, and IDs, hold none.
        for (String plain : List.of("server.port",
                "qwen.managed-agent.runtime-broker.credential-key-id",
                "qwen.managed-agent.harness.pool.kubernetes-token-file",
                "qwen.managed-agent.harness.pool.key-store-password-file",
                "qwen.managed-agent.harness.pool.key-store-file",
                "qwen.managed-agent.harness.credentials-file",
                "qwen.managed-agent.runtime-broker.resident-kubernetes-token-file",
                "qwen.managed-agent.auth.mode", "spring.datasource.username",
                "qwen.managed-agent.runtime-broker.credentialKeyId",
                "qwen.managed-agent.harness.pool.kubernetesTokenFile")) {
            assertTrue(!ManagedAgentPreflight.secretProperty(plain), plain);
        }
    }

    @Test
    void judgesAFileByTheKeysItDeclares() throws IOException {
        // The same rule as a config tree value file's name: a token the
        // three text markers do not spell is a secret all the same.
        Path yaml = write("conf/application.yml", "qwen.managed-agent.harness.token: abc123\n");
        Path properties = write("conf/broker.properties",
                "qwen.managed-agent.runtime-broker.staticToken=abc123\n");
        Path xml = write("conf/broker.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                + "<!DOCTYPE properties SYSTEM \"http://java.sun.com/dtd/properties.dtd\">\n"
                + "<properties><entry key=\"qwen.managed-agent.runtime-broker.token\">x</entry>"
                + "</properties>\n");
        // A path to a file that holds a secret is none.
        Path path = write("conf/pool.yml",
                "qwen.managed-agent.harness.pool.kubernetes-token-file: /var/run/token\n");
        for (Path file : List.of(yaml, properties, xml, path)) {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
        }
        for (Path file : List.of(yaml, properties, xml)) {
            ManagedAgentPreflight.Check check = ManagedAgentPreflight.configFileCheck(file, null);
            assertEquals(ManagedAgentPreflight.Status.WARN, check.status(), check.toString());
            assertEquals("chmod 600 " + file, check.fix());
        }
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.configFileCheck(path, null).status());
        // An ID named like a key holds no secret; a commented-out key still
        // asks for the chmod before the operator fills it in.
        Path id = write("conf/id.yml",
                "qwen.managed-agent.runtime-broker.credential-key-id: reference-v2\n");
        Path commented = write("conf/commented.yml",
                "# qwen.managed-agent.runtime-broker.credential-key: <key>\n");
        Files.setPosixFilePermissions(id, PosixFilePermissions.fromString("rw-r--r--"));
        Files.setPosixFilePermissions(commented, PosixFilePermissions.fromString("rw-r--r--"));
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.configFileCheck(id, null).status());
        assertEquals("chmod 600 " + commented,
                ManagedAgentPreflight.configFileCheck(commented, null).fix());
        // One rule for every key, live or commented out, however spelled:
        // Spring binds credential-key_id to credential-key-id, and the path
        // to a file that holds a password is none.
        Path spelled = write("conf/spelled.yml",
                "qwen.managed-agent.runtime-broker.credential-key_id: reference-v2\n");
        Path keyStore = write("conf/key-store.yml", "qwen.managed-agent.harness.pool:\n"
                + "  key-store-password-file: /etc/qwen-managed-agent/cert.pass\n"
                + "# key-store-password-file: /etc/qwen-managed-agent/old.pass\n"
                + "# The password itself is in the file it names.\n");
        Path cased = write("conf/cased.yml", "# Password: change-me\n");
        // A value holds one, as a JDBC URL's parameter or a URL's user
        // information does; so does a document no profile activates, and
        // an XML comment.
        Path jdbc = write("conf/jdbc.yml",
                "spring.datasource.url: jdbc:mysql://db/qwen?user=qwen&password=s3cret\n");
        Path userInfo = write("conf/user-info.properties",
                "#qwen.managed-agent.harness.base-url=http://svc:s3cret@harness:4170\n");
        Path inactive = write("conf/profiles.yml", "server.port: 9090\n---\n"
                + "spring.config.activate.on-profile: never\n"
                + "spring.datasource.password: s3cret\n");
        Path commentedXml = write("conf/commented.xml",
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                + "<!DOCTYPE properties SYSTEM \"http://java.sun.com/dtd/properties.dtd\">\n"
                + "<properties><entry key=\"server.port\">9090</entry>\n"
                + "<!-- <entry key=\"spring.datasource.password\">s3cret</entry> -->\n"
                + "</properties>\n");
        // A YAML comment after a value is a comment too; in .properties the
        // rest of the line is the value.
        Path inline = write("conf/inline.yml",
                "server:\n  port: 8080 # spring.datasource.password: s3cret\n");
        Path inlineProperties = write("conf/inline.properties",
                "server.port=8080 # spring.datasource.password: s3cret\n");
        Path inlineLater = write("conf/inline-later.yml",
                "motd: \"a #b\" # note # spring.datasource.password: s3cret\n");
        Map<Path, ManagedAgentPreflight.Status> verdicts = new HashMap<>();
        for (Path file : List.of(spelled, keyStore, cased, jdbc, userInfo, inactive,
                commentedXml, inline, inlineProperties, inlineLater)) {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
            verdicts.put(file, ManagedAgentPreflight.configFileCheck(file, null).status());
        }
        assertEquals(Map.of(
                spelled, ManagedAgentPreflight.Status.PASS,
                keyStore, ManagedAgentPreflight.Status.PASS,
                cased, ManagedAgentPreflight.Status.WARN,
                jdbc, ManagedAgentPreflight.Status.WARN,
                userInfo, ManagedAgentPreflight.Status.WARN,
                inactive, ManagedAgentPreflight.Status.WARN,
                commentedXml, ManagedAgentPreflight.Status.WARN,
                inline, ManagedAgentPreflight.Status.WARN,
                inlineProperties, ManagedAgentPreflight.Status.PASS,
                inlineLater, ManagedAgentPreflight.Status.WARN), verdicts);
    }

    @Test
    void failsTheRowsThatReadASettingSpringCannotResolve() throws IOException {
        // A placeholder with no value and no default, in a file the server
        // reads: Spring would not start, the rows that read it fail, and the
        // others still run.
        Path file = write("etc/application.yml", "server.port: ${QMA_PREFLIGHT_UNSET}\n"
                + "server.address: ${QMA_PREFLIGHT_UNSET}\n"
                + "spring.datasource.url: ${QMA_PREFLIGHT_UNSET}\n");
        Map<String, ManagedAgentPreflight.Check> rows = new HashMap<>();
        for (ManagedAgentPreflight.Check row : ManagedAgentPreflight.checks(
                new String[] {"--check"}, named("file:" + file))) {
            rows.put(row.name(), row);
        }
        for (String name : List.of("auth", "server-port", "database")) {
            assertEquals(ManagedAgentPreflight.Status.FAIL, rows.get(name).status(),
                    rows.toString());
            assertEquals("Could not resolve placeholder 'QMA_PREFLIGHT_UNSET' in value"
                    + " \"${QMA_PREFLIGHT_UNSET}\"", rows.get(name).detail());
        }
        assertEquals(ManagedAgentPreflight.Status.PASS, rows.get("java").status());
        assertEquals(ManagedAgentPreflight.Status.SKIP, rows.get("capacity").status());
    }

    @Test
    void judgesAFileAConfigTreeAlsoReadsByBoth() throws IOException {
        // A config tree imported over a configuration file's directory reads
        // that file as a value too, of a property named application.yml.
        Path both = write("config/application.yml", "spring.datasource.password: s3cret\n");
        Files.setPosixFilePermissions(both, PosixFilePermissions.fromString("rw-r--r--"));
        ManagedAgentPreflight.Prepared prepared = prepare(named("optional:file:" + both),
                new ArrayList<>(), "--spring.config.import=optional:configtree:"
                        + both.getParent() + "/");
        assertEquals("s3cret", prepared.environment().getProperty("spring.datasource.password"));
        assertEquals("application.yml", prepared.values().get(both));
        assertEquals(List.of(both), prepared.files());
        List<ManagedAgentPreflight.Check> rows = rows(prepared);
        assertEquals(1, rows.size(), rows.toString());
        assertEquals(ManagedAgentPreflight.Status.WARN, rows.get(0).status(), rows.toString());
        assertEquals("chmod 600 " + both, rows.get(0).fix());
        // A value file is judged by its value as well as by its property.
        Path url = write("tree/spring.datasource.url", "jdbc:mysql://db/qwen?password=s3cret");
        Path port = write("tree/server.port", "9090");
        for (Path file : List.of(url, port)) {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
        }
        assertEquals(ManagedAgentPreflight.Status.WARN, ManagedAgentPreflight.configFileCheck(
                url, null, "spring.datasource.url").status());
        assertEquals(ManagedAgentPreflight.Status.PASS, ManagedAgentPreflight.configFileCheck(
                port, null, "server.port").status());
        // A file whose extension Spring is told, as file:app.conf[.properties].
        Path hinted = write("etc/app.conf", "spring.datasource.password=s3cret\n");
        Files.setPosixFilePermissions(hinted, PosixFilePermissions.fromString("rw-r--r--"));
        prepared = prepare(named("file:" + hinted + "[.properties]"), new ArrayList<>());
        assertEquals("s3cret", prepared.environment().getProperty("spring.datasource.password"));
        assertEquals(List.of(hinted), prepared.files());
        assertEquals(ManagedAgentPreflight.Status.WARN, rows(prepared).get(0).status());
        // It is a value file too, of a property named app.conf, under a config
        // tree imported over its directory; its keys still tell.
        prepared = prepare(named("file:" + hinted + "[.properties]"), new ArrayList<>(),
                "--spring.config.import=optional:configtree:" + hinted.getParent() + "/");
        assertEquals("app.conf", prepared.values().get(hinted));
        assertEquals(Set.of(hinted), prepared.configurations());
        rows = rows(prepared);
        assertEquals(1, rows.size(), rows.toString());
        assertEquals(ManagedAgentPreflight.Status.WARN, rows.get(0).status(), rows.toString());
        assertEquals("chmod 600 " + hinted, rows.get(0).fix());
        // A value file Spring reads as no configuration file holds its value
        // alone, however its value reads.
        Path label = write("tree/qwen.managed-agent.label", "spring.datasource.password=s3cret");
        Files.setPosixFilePermissions(label, PosixFilePermissions.fromString("rw-r--r--"));
        prepared = prepare(environment(Map.of()), new ArrayList<>(),
                "--spring.config.import=optional:configtree:" + label.getParent() + "/");
        assertEquals("qwen.managed-agent.label", prepared.values().get(label));
        assertEquals(Set.of(), prepared.configurations());
        rows = rows(prepared);
        assertEquals(ManagedAgentPreflight.Status.PASS,
                rows.stream().filter(row -> row.detail().startsWith(label.toString()))
                        .findFirst().orElseThrow().status(), rows.toString());
        // Nor does a configuration file's name make it one, outside the
        // locations Spring reads configuration files at.
        Path notes = write("tree/application.yml", "spring.datasource.password: s3cret\n");
        Files.setPosixFilePermissions(notes, PosixFilePermissions.fromString("rw-r--r--"));
        prepared = prepare(environment(Map.of()), new ArrayList<>(),
                "--spring.config.import=optional:configtree:" + notes.getParent() + "/");
        assertEquals("application.yml", prepared.values().get(notes));
        rows = rows(prepared);
        assertEquals(ManagedAgentPreflight.Status.PASS,
                rows.stream().filter(row -> row.detail().startsWith(notes.toString()))
                        .findFirst().orElseThrow().status(), rows.toString());
    }

    @Test
    void readsTheImportsTheArgumentsTheEnvironmentAndTheSystemPropertiesName() throws IOException {
        // A top-level import, as SPRING_CONFIG_IMPORT gives it.
        Path top = write("top/top.yml", "# only a comment\n");
        ManagedAgentPreflight.Prepared prepared = prepare(environment(Map.of(
                "SPRING_CONFIG_IMPORT", "optional:file:" + top)), new ArrayList<>());
        assertEquals(List.of(top), prepared.files());
        // A -D system property, such as JAVA_TOOL_OPTIONS passes.
        Path system = write("system/application.yml", "# only a comment\n");
        ConfigurableEnvironment environment = environment(Map.of());
        environment.getPropertySources().replace(
                StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME,
                new MapPropertySource(StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME,
                        Map.of("spring.config.additional-location",
                                "optional:file:" + system.getParent() + "/")));
        prepared = prepare(environment, new ArrayList<>());
        assertEquals(List.of(system), prepared.files());
        // A placeholder in an import a file declares, which Spring resolves.
        Path near = write("near/near.yml", "# only a comment\n");
        Path declaring = write("decl/application.yml",
                "spring.config.import: optional:file:${NEAR_DIR}/near.yml\n");
        Map<String, Object> variables = new HashMap<>();
        variables.put("SPRING_CONFIG_ADDITIONAL_LOCATION", "optional:file:" + declaring);
        variables.put("NEAR_DIR", near.getParent().toString());
        prepared = prepare(environment(variables), new ArrayList<>());
        assertEquals(Set.of(declaring, near), Set.copyOf(prepared.files()));
    }

    @Test
    void resolvesAPlaceholderInALocationAsSpringDoes() throws IOException {
        // systemd does not expand ${...} in an environment file; Spring does,
        // from the same sources it reads the locations from.
        Path empty = write("etc/application.yml", "# only a comment\n");
        Map<String, Object> variables = new HashMap<>();
        variables.put("SPRING_CONFIG_ADDITIONAL_LOCATION", "optional:file:${CONF}/");
        variables.put("CONF", empty.getParent().toString());
        ManagedAgentPreflight.Prepared prepared = prepare(environment(variables),
                new ArrayList<>());
        assertEquals(List.of(empty), prepared.files());
        // A file cannot supply it.
        Path named = write("conf/application.yml", "CONF: " + empty.getParent() + "\n");
        variables.put("SPRING_CONFIG_ADDITIONAL_LOCATION",
                "optional:file:" + named.getParent() + "/,optional:file:${CONF}/");
        variables.remove("CONF");
        prepared = prepare(environment(variables), new ArrayList<>());
        assertEquals(List.of(named), prepared.files());
    }

    @Test
    void namesEveryVariantThatHoldsTheErrorUnlessAProfileSaysWhich() throws IOException {
        // Two variants with the very same error at the very same place.
        Path config = write("conf/application.yml", "server.port: 9090\n");
        Path aaa = write("conf/application-aaa.yml", "server: [\n");
        Path zzz = write("conf/application-zzz.yml", "server: [\n");
        String problem = ", line 2, column 1: expected the node content, but found '<stream end>'";
        Map<String, Object> variables = new HashMap<>();
        variables.put("SPRING_CONFIG_ADDITIONAL_LOCATION", "optional:file:" + config.getParent() + "/");
        variables.put("SPRING_PROFILES_ACTIVE", "zzz");
        assertEquals(zzz + problem, refused(environment(variables)).detail());
        variables.remove("SPRING_PROFILES_ACTIVE");
        variables.put("SPRING_PROFILES_INCLUDE", "zzz");
        assertEquals(zzz + problem, refused(environment(variables)).detail());
        // The profile set in a file, which the environment Spring was given
        // does not hold: both are named.
        Files.writeString(config, "spring.profiles.active: zzz\n");
        assertEquals(aaa + " or " + zzz + problem,
                refused(named("optional:file:" + config.getParent() + "/")).detail());
        // A base file Spring reads for certain is the one, even beside a
        // variant with the same error.
        Files.writeString(config, "server: [\n");
        assertEquals(config + problem,
                refused(named("optional:file:" + config.getParent() + "/")).detail());
    }

    @Test
    void listsAnXmlFileTheServerReads() throws IOException {
        // Spring reads application.xml, whose values carry no origin.
        Path xml = write("conf/application.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                + "<!DOCTYPE properties SYSTEM \"http://java.sun.com/dtd/properties.dtd\">\n"
                + "<properties><entry key=\"spring.datasource.password\">s3cret</entry></properties>\n");
        Files.setPosixFilePermissions(xml, PosixFilePermissions.fromString("rw-r--r--"));
        ManagedAgentPreflight.Prepared prepared = prepare(named("optional:file:"
                + xml.getParent() + "/"), new ArrayList<>());
        assertEquals("s3cret", prepared.environment().getProperty("spring.datasource.password"));
        assertEquals(List.of(xml), prepared.files());
        assertEquals("chmod 600 " + xml, rows(prepared).get(0).fix());
    }

    @Test
    void readsTheLocationsSpringReadsBeforeAnyFile() throws IOException {
        // A file cannot move Spring's locations: it ignores
        // spring.config.location and spring.config.name set there.
        Path conf = write("conf/application.yml", "spring.config.location: file:"
                + directory.resolve("other") + "/\nspring.config.name: renamed\nserver.port: 1111\n");
        Path fallback = write("conf/application-default.yml", "# only a comment\n");
        write("other/application.yml", "server.port: 2222\n");
        write("conf/renamed.yml", "# only a comment\n");
        Path example = write("config/application.yml", "# only a comment\n");
        ManagedAgentPreflight.Prepared prepared = prepare(named("optional:file:"
                + conf.getParent() + "/"), new ArrayList<>());
        assertEquals("1111", prepared.environment().getProperty("server.port"));
        // Base files first, then their profile variants.
        assertEquals(List.of(conf, example, fallback),
                ServerEnvironment.files(prepared.environment(), directory));
        // An import a file declares counts, each file's, in either form: a
        // bare relative one beside that file, a file: one in the working
        // directory.
        Path imports = write("etc/application.yml", "spring.config.import:\n"
                + "  - optional:beside.yml\n  - optional:file:" + directory.resolve("wd.yml") + "\n");
        Path other = write("etc2/application.yml",
                "spring.config.import: optional:near.yml, optional:probe.yml\n");
        Path beside = write("etc/beside.yml", "# only a comment\n");
        Path near = write("etc2/near.yml", "# only a comment\n");
        Path wd = write("wd.yml", "# only a comment\n");
        // Where Spring itself reads a bare one.
        Path probe = write("etc2/probe.yml", "probe.near: beside\n");
        prepared = prepare(named("optional:file:" + imports + ",optional:file:" + other),
                new ArrayList<>());
        assertEquals("beside", prepared.environment().getProperty("probe.near"));
        assertEquals(Set.of(imports, other, beside, near, wd, probe),
                Set.copyOf(prepared.files()));
        // Set where Spring reads it, it counts.
        prepared = prepare(named("optional:file:" + conf.getParent() + "/"),
                new ArrayList<>(), "--spring.config.name=renamed");
        assertEquals(List.of(directory.resolve("conf/renamed.yml")),
                ServerEnvironment.files(prepared.environment(), directory));
        // As a list Spring binds, from the variables that index it.
        prepared = prepare(environment(Map.of(
                "SPRING_CONFIG_ADDITIONAL_LOCATION", "optional:file:" + conf.getParent() + "/",
                "SPRING_CONFIG_NAME_0", "renamed")), new ArrayList<>());
        assertEquals(List.of(directory.resolve("conf/renamed.yml")),
                ServerEnvironment.files(prepared.environment(), directory));
    }

    @Test
    void readsALocationWhosePathHoldsAColon() throws IOException {
        // After file:, a colon is part of the path, as Spring reads it.
        Path empty = write("conf:b/application.yml", "# only a comment\n");
        ManagedAgentPreflight.Prepared prepared = prepare(named("optional:file:"
                + empty.getParent() + "/"), new ArrayList<>());
        assertEquals(List.of(empty), prepared.files());
        // Without file:, Spring reads classpath:/ as the class path, not as
        // a directory of that name.
        write("classpath:/application.yml", "# only a comment\n");
        prepared = prepare(environment(Map.of()), new ArrayList<>(),
                "--spring.config.additional-location=optional:classpath:/");
        assertEquals(List.of(), ServerEnvironment.files(prepared.environment(), directory));
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
        assumeOthersCanSearchTheDirectory();
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
        assertEquals("create a configuration file at a location Spring reads, such as"
                + " config/application.yml, for the credential key ring", rows.get(0).fix());
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
            // Only what starts a JVM: any other variable, such as SERVER_PORT,
            // could reach the configuration.
            builder.environment().keySet().retainAll(
                    Set.of("PATH", "HOME", "JAVA_HOME", "LANG", "TMPDIR"));
            Process process = builder.start();
            if (!process.waitFor(120, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw new AssertionError("--check did not finish: " + Files.readString(output));
            }
            String report = Files.readString(output);
            // The report says where it read the relative locations: the
            // working directory as the JVM sees it, /private/var for macOS's /var.
            Path root = directory.toRealPath();
            assertTrue(report.contains("Managed Agent preflight in " + root + "\n"), report);
            Map<String, List<String>> rows = new HashMap<>();
            report.lines().map(line -> line.split("\\s+", 3))
                    .filter(row -> row.length == 3)
                    .forEach(row -> rows.computeIfAbsent(row[1], name -> new ArrayList<>())
                            .add(row[0] + " " + row[2]));
            // The file with a setting first, then the one without.
            assertEquals(List.of("PASS " + root.resolve(directory.relativize(config)),
                    "PASS " + root.resolve(directory.relativize(example))),
                    rows.get("config"), report);
            assertEquals(1, rows.get("server-port").size(), report);
            assertTrue(rows.get("server-port").get(0).contains(":" + free + " "), report);
        } finally {
            Files.deleteIfExists(output);
        }
    }
}
