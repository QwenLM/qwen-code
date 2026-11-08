package com.alibaba.qwen.code.managedagent.preflight;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
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
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeFalse;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The preflight reads the configuration the server reads (#16057): Spring's
 * own preparation of the environment, so files at its default locations,
 * imports and profile files count, and a configuration the server would
 * refuse fails the config row.
 */
@DisabledOnOs(OS.WINDOWS)
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

    /**
     * An environment Spring has prepared, or failed to, which keeps the
     * files it looked for, as the one a failure is read from does.
     */
    private static ConfigurableEnvironment looked(ConfigurableEnvironment environment) {
        try {
            ServerEnvironment.prepare(new String[0], environment);
        } catch (RuntimeException refused) {
            // Spring looked before it refused.
        }
        return environment;
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
        ServiceAccountTest.assumeOthersCanSearchAbove(directory);
    }

    private static boolean nobodyExists() {
        return ServiceAccountTest.nobodyExists();
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
    void stopsAtASymbolicLinkToItself() throws IOException {
        // Spring reads no file through it, and the check names no directory for it.
        Path loop = Files.createSymbolicLink(directory.resolve("loop"), Path.of("loop"));
        ManagedAgentPreflight.Prepared prepared = assertTimeoutPreemptively(Duration.ofSeconds(30),
                () -> prepare(named("optional:file:" + loop + "/application.yml"), new ArrayList<>()));
        assertNull(prepared.failure());
        assertEquals(List.of(), prepared.files());
        assertEquals(List.of(), prepared.hidden());
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    void followsNoMoreSymbolicLinksThanTheKernel() throws IOException {
        // A chain of links to a directory this process cannot enter. Linux
        // follows 40 links and no more, so the server cannot reach the
        // directory through 41, and the check names none. The chain starts
        // at the real path, so no link above it counts.
        Path root = directory.toRealPath();
        Path linked = Files.createDirectory(root.resolve("linked"));
        Path chain = linked;
        for (int link = 1; link <= 41; link++) {
            chain = Files.createSymbolicLink(root.resolve("link" + link), chain.getFileName());
        }
        Path within = root.resolve("link40");
        assertTrue(Files.isDirectory(within), "the kernel follows 40 links");
        assertFalse(Files.isDirectory(chain), "the kernel follows no more than 40 links");
        Files.setPosixFilePermissions(linked, PosixFilePermissions.fromString("---------"));
        try {
            assumeFalse(Files.isExecutable(linked), "root enters any directory");
            ManagedAgentPreflight.Prepared prepared =
                    prepare(named("optional:file:" + chain + "/"), new ArrayList<>());
            assertNull(prepared.failure());
            assertEquals(List.of(), prepared.files());
            assertEquals(List.of(), prepared.hidden());
            // Through 40, the directory is one it cannot look in.
            assertEquals(List.of(new ServerEnvironment.Hidden(linked, false)),
                    prepare(named("optional:file:" + within + "/"), new ArrayList<>()).hidden());
        } finally {
            Files.setPosixFilePermissions(linked, PosixFilePermissions.fromString("rwx------"));
        }
    }

    @Test
    void aReplacedLocationDropsTheClasspathDefaults() throws IOException {
        // spring.config.location replaces the classpath location as well, and
        // with it the packaged loopback address, unless it names it again.
        Path etc = Files.createDirectories(directory.resolve("etc"));
        assertEquals("127.0.0.1", prepare(environment(Map.of()), new ArrayList<>())
                .environment().getProperty("server.address"));
        assertNull(prepare(environment(Map.of("SPRING_CONFIG_LOCATION", "file:" + etc + "/")),
                new ArrayList<>()).environment().getProperty("server.address"));
        assertEquals("127.0.0.1", prepare(environment(Map.of("SPRING_CONFIG_LOCATION",
                "optional:classpath:/,file:" + etc + "/")), new ArrayList<>())
                .environment().getProperty("server.address"));
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
        // As in a file an import names from inside another, which Spring
        // looked up as any other.
        Path importer = write("importer.yml",
                "spring.config.import: file:" + broken + "\n");
        assertEquals(broken + ", line 2, column 1: expected the node"
                + " content, but found '<stream end>'",
                refused(named("file:" + importer)).detail());
        // And in one a location tells Spring is YAML, whatever its name.
        Path hinted = write("broken.conf", "server: [\n");
        assertEquals(hinted + ", line 2, column 1: expected the node content,"
                + " but found '<stream end>'",
                refused(named("file:" + hinted + "[.yml]")).detail());
        // Spring stopped at the first, so a candidate it never read may hold
        // an alias its YAML loader would follow without end; that is no
        // culprit, and the row still names the file.
        Path endless = write("f/w/a/app.conf", "a: &x [*x]\n");
        assertEquals(broken + ", line 2, column 1: expected the node content,"
                + " but found '<stream end>'", refused(named("optional:file:"
                        + endless.getParent().getParent() + "/*/app.conf[.yml],file:" + broken))
                        .detail());
        // A wildcard's variant of a profile no one activated is a candidate
        // Spring never read: nor is one whose key holds a collection that
        // holds itself, which overflows as it is hashed.
        Path unparsed = write("chain/sub/application.yml", "server: [\n");
        write("chain/sub/application-edge.yml", "? [&a [*a]]\n: 1\n");
        assertEquals(unparsed + ", line 2, column 1: expected the node content, but found"
                + " '<stream end>'", refused(named("optional:file:" + directory.resolve("chain")
                        + "/*/")).detail());
        // Nor one that would expand an alias of aliases without end.
        StringBuilder laughs = new StringBuilder("{a0: &a0 [x]");
        for (int level = 1; level < 9; level++) {
            laughs.append(", a").append(level).append(": &a").append(level).append(" [")
                    .append(String.join(", ", Collections.nCopies(10, "*a" + (level - 1))))
                    .append("]");
        }
        // Nor one whose key is such an alias, which hashing would expand.
        StringBuilder keyed = new StringBuilder("a0: &a0 [x]\n");
        for (int level = 1; level < 11; level++) {
            keyed.append('a').append(level).append(": &a").append(level).append(" [")
                    .append(String.join(", ", Collections.nCopies(10, "*a" + (level - 1))))
                    .append("]\n");
        }
        Path unread = write("bomb/sub/application.yml", "server: [\n");
        write("bomb/sub/application-edge.yml", laughs + "}\n");
        write("bomb/sub/application-keyed.yml", keyed + "? *a10\n: 1\n");
        StringBuilder doubled = new StringBuilder("a0: &a0 [x, x]\n");
        for (int level = 1; level <= 20; level++) {
            doubled.append('a').append(level).append(": &a").append(level).append(" [*a")
                    .append(level - 1).append(", *a").append(level - 1).append("]\n");
        }
        write("bomb/sub/application-recursive.yml", doubled + "? &k [*a20, *k]\n: 1\n");
        assertTimeoutPreemptively(Duration.ofSeconds(10), () -> assertEquals(unread
                + ", line 2, column 1: expected the node content, but found '<stream end>'",
                refused(named("optional:file:" + directory.resolve("bomb") + "/*/")).detail()));
        // It reads each candidate as Spring's loader would otherwise: a tag
        // it has no constructor for is the same error, and so is a key twice,
        // and a file of any size is read.
        Path tagged = write("tag/application.yml", "a: !vault abc\n");
        assertTrue(refused(named("optional:file:" + tagged.getParent() + "/")).detail()
                .startsWith(tagged + ", line 1, column 4: could not determine a constructor"));
        // Within bounds, though: a recursive key, which Spring allows, ends
        // the reading before Spring's error, which the row still gives.
        Path recursive = write("rk/application.yml", "&m {*m: 1}\n---\nb: [\n");
        assertEquals("a configuration file, line 4, column 1: expected the node content, but"
                + " found '<stream end>'", refused(named("optional:file:" + recursive.getParent()
                        + "/")).detail());
        Path dated = write("date/application.yml", "2001-01-01: a\n2001-01-01: b\n");
        assertTrue(refused(named("optional:file:" + dated.getParent() + "/")).detail()
                .startsWith(dated + ", line 2, column 1: found duplicate key 2001-01-01"));
        Path twice = write("dup/application.yml", "a: 1\na: 2\n");
        assertTrue(refused(named("optional:file:" + twice.getParent() + "/")).detail()
                .startsWith(twice + ", line 2, column 1: found duplicate key a"));
        Path large = write("large/application.yml",
                "# padding\n".repeat(400_000) + "server: [\n");
        assertTrue(refused(named("optional:file:" + large.getParent() + "/")).detail()
                .startsWith(large + ", line 400002, column 1: expected the node content"));
        // Where the check cannot make a path of a name Spring looks for,
        // Spring's error still makes the row, of the files it looked up.
        Files.createDirectories(directory.resolve("nulw/a"));
        assertEquals(broken + ", line 2, column 1: expected the node content,"
                + " but found '<stream end>'", refused(named("optional:file:"
                        + directory.resolve("nulw") + "/*/x\u0000.yml,file:" + broken)).detail());
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
            // Root enters it whatever its modes.
            rows = ManagedAgentPreflight.configChecks(prepared,
                    new ServiceAccount("root", Set.of("root")), runner);
            assertEquals(1, rows.size(), rows.toString());
            assertEquals(ManagedAgentPreflight.Status.FAIL, rows.get(0).status());
            assertEquals("run --check as root", rows.get(0).fix());
            // A wildcard's directory it may list but not enter hides the
            // directories in it, which Spring then finds none of.
            Path wild = Files.createDirectories(directory.resolve("wild/edge")).getParent();
            Path realWild = wild.toRealPath();
            Files.setPosixFilePermissions(wild, PosixFilePermissions.fromString("r--r-xr--"));
            try {
                ManagedAgentPreflight.Prepared listed = prepare(
                        named("optional:file:" + wild + "/*/"), new ArrayList<>());
                assertEquals(List.of(new ServerEnvironment.Hidden(realWild, false)),
                        listed.hidden());
                assertEquals(ManagedAgentPreflight.Status.FAIL, ManagedAgentPreflight.hiddenCheck(
                        listed.hidden().get(0), member, runner).status());
            } finally {
                Files.setPosixFilePermissions(wild, PosixFilePermissions.fromString("rwxr-xr-x"));
            }
            // As does one it may not list for a file's wildcard.
            assertEquals(List.of(new ServerEnvironment.Hidden(realEtc, true)), prepare(
                    named("optional:file:" + etc + "/*/application.yml"),
                    new ArrayList<>()).hidden());
            // However Spring is told of a file there: a scheme in another
            // case, a resource: prefix or an extension hint.
            for (String location : List.of("optional:File:" + etc + "/",
                    "optional:resource:file:" + secret,
                    "optional:file:" + etc.resolve("app.conf") + "[.properties]")) {
                assertEquals(List.of(new ServerEnvironment.Hidden(realEtc, false)),
                        prepare(named(location), new ArrayList<>()).hidden(), location);
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
                looked(named("file:" + fine + ",optional:file:" + locked.getParent() + "/")),
                file -> !file.toAbsolutePath().normalize().equals(locked),
                file -> false, directory);
        assertEquals(locked + " is not readable by " + user, failure.detail());
        assertEquals(locked, failure.unreadable());
        // A file it reads and that parses is no culprit.
        assertEquals("x (Permission denied)", ServerEnvironment.failure(cannotRead("x"),
                looked(named("file:" + fine)), file -> true, file -> false, directory).detail());
        // Nor is one it cannot read when Spring failed on no read.
        assertEquals("bad value", ServerEnvironment.failure(
                new IllegalStateException("bad value"),
                looked(named("file:" + fine + ",optional:file:" + locked.getParent() + "/")),
                file -> !file.toAbsolutePath().normalize().equals(locked),
                file -> false, directory).detail());
        // A variant of a profile Spring activated may be what it could not read.
        Path variant = write("dist/config/application-edge.yml", "server.port: 9092\n");
        Map<String, Object> edge = new HashMap<>();
        edge.put("SPRING_CONFIG_ADDITIONAL_LOCATION",
                "file:" + fine + ",optional:file:" + locked.getParent() + "/");
        edge.put("SPRING_PROFILES_ACTIVE", "edge");
        assertEquals(variant + " is not readable by " + user, ServerEnvironment.failure(
                cannotRead("x"), looked(environment(edge)),
                file -> !file.toAbsolutePath().normalize().equals(variant),
                file -> false, directory).detail());
        // Not that of a profile it did not.
        assertEquals("x (Permission denied)", ServerEnvironment.failure(cannotRead("x"),
                looked(named("file:" + fine + ",optional:file:" + locked.getParent() + "/")),
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
                looked(environment(Map.of())), file -> true, file -> false, directory);
        assertEquals(config + ", line 3, column 1: expected the node content,"
                + " but found '<stream end>'", failure.detail());
        // Unless spring.config.location replaces them.
        ServerEnvironment.Failure replaced = ServerEnvironment.failure(error,
                looked(environment(Map.of("SPRING_CONFIG_LOCATION", "optional:classpath:/"))),
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
                ServerEnvironment.failure(cannotRead("x"),
                        looked(named("file:etc/relative.yml")),
                        file -> !file.toAbsolutePath().normalize().equals(relative),
                        file -> false, directory).detail());
        // A file both a location and config/*/ name is named once, though
        // one names it from a relative working directory, as the server's is.
        Files.writeString(nested, "server: [\n");
        RuntimeException twice = thrown(named("optional:file:" + nested.getParent() + "/"));
        assertEquals(nested + ", line 2, column 1: expected the node content, but found"
                + " '<stream end>'", ServerEnvironment.failure(twice,
                        looked(named("optional:file:" + nested.getParent() + "/")),
                        file -> true, file -> false,
                        Path.of("").toAbsolutePath().relativize(directory)).detail());
        Files.writeString(nested, "server.port: 9091\n");
        // So is spring.config.name's.
        Path renamed = write("config/server.yml", "server.port: 9093\n");
        assertEquals(renamed + " is not readable by " + System.getProperty("user.name"),
                ServerEnvironment.failure(cannotRead("x"),
                        looked(environment(Map.of("SPRING_CONFIG_NAME", "server"))),
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

    // The files, each once, in no order: those of locations that hold no
    // setting have no precedence to keep.
    private static void assertSameFiles(Set<Path> expected, List<Path> files) {
        assertEquals(expected, Set.copyOf(files), files.toString());
        assertEquals(expected.size(), files.size(), files.toString());
    }

    @Test
    void findsTheFilesSpringLooksForHoweverALocationIsSpelled() throws IOException {
        // Each holds no setting, so only where Spring looked finds it: a
        // scheme in another case, a resource: prefix, and a name with a
        // colon, which Spring reads as a file in the working directory.
        Path upper = write("upper/application.yml", "# spring.datasource.password: x\n");
        Path resource = write("resource/application.yml", "# server.port: 9090\n");
        Path colon = write("foo:bar.yml", "# server.port: 9090\n");
        ManagedAgentPreflight.Prepared prepared = prepare(named("optional:File:"
                + upper.getParent() + "/,optional:resource:file:" + resource.getParent()
                + "/,optional:foo:bar.yml"), new ArrayList<>());
        assertNull(prepared.failure());
        assertSameFiles(Set.of(colon, resource, upper),
                ServerEnvironment.files(prepared.environment(), directory));
        // A wildcard, which Spring lists rather than looks a file up in,
        // named so or imported beside the file that imports it.
        Path listed = write("listed/edge/application.yml", "# server.port: 9090\n");
        Path importer = write("importer/application.yml",
                "spring.config.import: optional:conf.d/*/\n");
        Path imported = write("importer/conf.d/edge/application.yml", "# server.port: 9091\n");
        prepared = prepare(named("optional:File:" + directory.resolve("listed") + "/*/,optional:file:"
                + importer.getParent() + "/"), new ArrayList<>());
        assertNull(prepared.failure());
        assertSameFiles(Set.of(importer, listed, imported),
                ServerEnvironment.files(prepared.environment(), directory));
        // A file's wildcard: Spring looks for the one name in each directory,
        // and for the variant of each profile, named as for a hinted file.
        Path wild = write("fw/b/application.yml", "# server.port: 9090\n");
        Path hinted = write("fn/a/notes.conf", "qwen.preflight.probe=hinted\n");
        Path variant = write("fn/a/notes.conf-edge", "# server.port: 9091\n");
        prepared = prepare(named("optional:file:" + directory.resolve("fw") + "/*/application.yml"
                + ",optional:file:" + directory.resolve("fn") + "/*/notes.conf[.properties]"),
                new ArrayList<>(), "--spring.profiles.active=edge");
        assertNull(prepared.failure());
        assertEquals("hinted", prepared.environment().getProperty("qwen.preflight.probe"));
        assertSameFiles(Set.of(wild, hinted, variant),
                ServerEnvironment.files(prepared.environment(), directory));
        // Spring matches the extension in any case and looks for the
        // loader's own, and reads nothing for an extension no loader takes.
        Path lower = write("fu/a/application.yml", "# server.port: 9090\n");
        write("fj/a/notes.conf", "# server.port: 9090\n");
        prepared = prepare(named("optional:file:" + directory.resolve("fu") + "/*/application.YML"
                + ",optional:file:" + directory.resolve("fj") + "/*/notes.conf[.json]"),
                new ArrayList<>());
        assertNull(prepared.failure());
        assertSameFiles(Set.of(lower), ServerEnvironment.files(prepared.environment(), directory));
        // An empty spring.config.location or spring.config.name leaves
        // Spring no file to look for, not its defaults.
        Path config = write("config/application.yml", "# server.port: 9090\n");
        write("config/edge/application.yml", "# server.port: 9091\n");
        // Spring lists no directory named from "..", as a ConfigMap's ..data.
        write("config/..data/application.yml", "# server.port: 9092\n");
        assertEquals(List.of(config, directory.resolve("config/edge/application.yml")),
                ServerEnvironment.files(prepare(environment(Map.of()), new ArrayList<>())
                        .environment(), directory));
        for (String property : List.of("SPRING_CONFIG_LOCATION", "SPRING_CONFIG_NAME")) {
            assertEquals(List.of(), ServerEnvironment.files(prepare(
                    environment(Map.of(property, "")), new ArrayList<>()).environment(),
                    directory), property);
        }
    }

    @Test
    void leavesAWildcardFileNamedOnlyByAnExtensionToSpring() throws IOException {
        // */properties leaves Spring a location whose last directory is no
        // wildcard, which it refuses, optional or not; the row says so.
        Files.createDirectories(directory.resolve("conf/a"));
        for (String name : List.of("properties", "YML")) {
            List<ManagedAgentPreflight.Check> checks = new ArrayList<>();
            ManagedAgentPreflight.Prepared prepared = prepare(environment(Map.of()), checks,
                    "--spring.config.location=optional:file:" + directory.resolve("conf")
                            + "/*/" + name);
            assertEquals(List.of(), prepared.files());
            assertNotNull(prepared.failure(), name);
            assertTrue(prepared.failure().detail().endsWith("must end with '*/'"),
                    prepared.failure().toString());
        }
        // Spring cuts the character before the extension, whatever it is, so
        // */xproperties looks for .properties in each directory.
        Path dotted = write("conf/a/.properties", "qwen.preflight.probe=dotted\n");
        ManagedAgentPreflight.Prepared cut = prepare(environment(Map.of()), new ArrayList<>(),
                "--spring.config.location=optional:file:" + directory.resolve("conf")
                        + "/*/xproperties");
        assertNull(cut.failure());
        assertEquals("dotted", cut.environment().getProperty("qwen.preflight.probe"));
        assertEquals(List.of(dotted), cut.files());
        Files.delete(dotted);
        // */[.yml] names no file, though a profile's variant, -edge, is one.
        Path variant = write("conf/a/-edge", "qwen.preflight.probe: dash\n");
        ManagedAgentPreflight.Prepared prepared = prepare(environment(Map.of()),
                new ArrayList<>(), "--spring.config.location=optional:file:"
                        + directory.resolve("conf") + "/*/[.yml]", "--spring.profiles.active=edge");
        assertNull(prepared.failure());
        assertEquals("dash", prepared.environment().getProperty("qwen.preflight.probe"));
        assertEquals(List.of(variant), prepared.files());
        assertEquals(Map.of(variant, Set.of(ServerEnvironment.Format.YAML)),
                prepared.configurations());
    }

    @Test
    void readsAFileForASecretAsTheLoaderSpringReadsItWith() throws IOException {
        // The loader is the one a location names, which a hint may name
        // against the file's own extension; the .properties one reads a name
        // that ends in .xml as XML, whatever the hint.
        Path yml = write("etc/a.yml", "qwen.preflight.a=properties\n");
        Path conf = write("etc/b.conf", "qwen.preflight.b: yaml\n");
        Path xml = write("etc/c.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                + "<!DOCTYPE properties SYSTEM \"http://java.sun.com/dtd/properties.dtd\">\n"
                + "<properties><entry key=\"qwen.preflight.c\">xml</entry></properties>\n");
        Path hintedXml = write("etc/d.conf", "qwen.preflight.d=properties\n");
        Path wild = write("wild/a/e.yml", "qwen.preflight.e=properties\n");
        ManagedAgentPreflight.Prepared prepared = prepare(named("file:" + yml + "[.properties],"
                + "file:" + conf + "[.yaml],file:" + xml + "[.properties],file:" + hintedXml
                + "[.xml],file:" + directory.resolve("wild") + "/*/e.yml[.properties]"),
                new ArrayList<>());
        assertNull(prepared.failure());
        for (String each : List.of("a=properties", "b=yaml", "c=xml", "d=properties",
                "e=properties")) {
            String[] expected = each.split("=");
            assertEquals(expected[1], prepared.environment().getProperty(
                    "qwen.preflight." + expected[0]), each);
        }
        assertEquals(Map.of(yml, Set.of(ServerEnvironment.Format.PROPERTIES),
                conf, Set.of(ServerEnvironment.Format.YAML),
                xml, Set.of(ServerEnvironment.Format.XML),
                hintedXml, Set.of(ServerEnvironment.Format.PROPERTIES),
                wild, Set.of(ServerEnvironment.Format.PROPERTIES)), prepared.configurations());
        // So a password YAML would not see is one; and in its own file
        // beside a wildcard.
        Path password = write("etc/app.yml", "spring.datasource.password=s3cret\n");
        Path listed = write("wild/b/app.yml", "spring.datasource.password=s3cret\n");
        for (Path file : List.of(password, listed)) {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
        }
        prepared = prepare(named("file:" + password + "[.properties],optional:file:"
                + directory.resolve("wild") + "/*/app.yml[.properties]"), new ArrayList<>());
        assertEquals("s3cret", prepared.environment().getProperty("spring.datasource.password"));
        List<ManagedAgentPreflight.Check> rows = rows(prepared);
        assertEquals(2, rows.size(), rows.toString());
        for (ManagedAgentPreflight.Check row : rows) {
            assertEquals(ManagedAgentPreflight.Status.WARN, row.status(), rows.toString());
            assertTrue(row.fix().equals("chmod 600 " + password)
                    || row.fix().equals("chmod 600 " + listed), rows.toString());
        }
        // Spring reads a relative import in a file a wildcard found beside
        // the wildcard, so in every directory of it, as the hint says.
        Path importer = write("found/sub/application.yml",
                "spring.config.import: extra.yml[.properties]\n");
        Path extra = write("found/sub/extra.yml", "spring.datasource.password=s3cret\n");
        Path sibling = write("found/z/extra.yml", "# spring.datasource.password=hunter2\n");
        for (Path file : List.of(extra, sibling)) {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
        }
        prepared = prepare(named("optional:file:" + directory.resolve("found") + "/*/"),
                new ArrayList<>());
        assertEquals("s3cret", prepared.environment().getProperty("spring.datasource.password"));
        assertEquals(Map.of(importer, Set.of(ServerEnvironment.Format.YAML),
                extra, Set.of(ServerEnvironment.Format.PROPERTIES),
                sibling, Set.of(ServerEnvironment.Format.PROPERTIES)), prepared.configurations());
        for (ManagedAgentPreflight.Check row : rows(prepared)) {
            assertEquals(row.detail().startsWith(importer.toString())
                    ? ManagedAgentPreflight.Status.PASS : ManagedAgentPreflight.Status.WARN,
                    row.status(), row.toString());
        }
        // The same where another location looks the importing file up, which
        // Spring read through the wildcard first, as it reads the last first.
        Path overlap = write("both/a/application.yml",
                "spring.config.import: extra.yml[.properties]\n");
        Path near = write("both/a/extra.yml", "spring.datasource.password=s3cret\n");
        Path far = write("both/b/extra.yml", "qwen.preflight.probe=far\n");
        Files.setPosixFilePermissions(near, PosixFilePermissions.fromString("rw-r--r--"));
        prepared = prepare(environment(Map.of()), new ArrayList<>(),
                "--spring.config.location=file:" + overlap + ",optional:file:"
                        + directory.resolve("both") + "/*/");
        assertEquals("s3cret", prepared.environment().getProperty("spring.datasource.password"));
        assertEquals("far", prepared.environment().getProperty("qwen.preflight.probe"));
        assertEquals(Map.of(overlap, Set.of(ServerEnvironment.Format.YAML),
                near, Set.of(ServerEnvironment.Format.PROPERTIES),
                far, Set.of(ServerEnvironment.Format.PROPERTIES)), prepared.configurations());
        assertEquals("chmod 600 " + near, rows(prepared).stream()
                .filter(row -> row.detail().startsWith(near.toString())).findFirst()
                .orElseThrow().fix());
        // A hint that names a loader the file is not written for leaves what
        // Spring does not bind in the file; it is judged as its name says too.
        Path misnamed = write("n/app.properties", "spring.datasource.password=s3cret\n");
        Path flow = write("n/app.conf", "spring: {datasource: {password: s3cret}}\n");
        for (Path file : List.of(misnamed, flow)) {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
        }
        prepared = prepare(environment(Map.of()), new ArrayList<>(),
                "--spring.config.location=file:" + misnamed + "[.yml],file:" + flow
                        + "[.properties]");
        assertNull(prepared.environment().getProperty("spring.datasource.password"));
        assertEquals(Map.of(misnamed, Set.of(ServerEnvironment.Format.YAML),
                flow, Set.of(ServerEnvironment.Format.PROPERTIES)), prepared.configurations());
        for (ManagedAgentPreflight.Check row : rows(prepared)) {
            assertEquals(ManagedAgentPreflight.Status.WARN, row.status(), row.toString());
        }
        // Comments too, and a YAML key with white space in it, which is no
        // prose outside a comment.
        Path inline = write("n2/app.yml", "server:\n  port: 8080 # spring.datasource.password: x\n");
        Path bang = write("n2/app.properties", "! spring.datasource.password=s3cret\n");
        Path spaced = write("n2/b.yml", "db password: s3cret\n");
        for (Path file : List.of(inline, bang, spaced)) {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
        }
        prepared = prepare(environment(Map.of()), new ArrayList<>(),
                "--spring.config.location=file:" + inline + "[.properties],file:" + bang
                        + "[.yml],file:" + spaced + "[.properties]");
        assertNull(prepared.failure());
        List<ManagedAgentPreflight.Check> misread = rows(prepared);
        assertEquals(3, misread.size(), misread.toString());
        for (ManagedAgentPreflight.Check row : misread) {
            assertEquals(ManagedAgentPreflight.Status.WARN, row.status(), row.toString());
        }
        // A file Spring read through a lookup is judged in that format alone,
        // though a wildcard names it too: not as YAML, which this would
        // recurse in without end.
        // So is the variant of a profile the wildcard names.
        Path endless = write("m/a/app.yml", "a: &x [*x]\n");
        Path variant = write("m/a/app-edge.yml", "b: &y [*y]\n");
        prepared = prepare(environment(Map.of()), new ArrayList<>(),
                "--spring.config.location=optional:file:" + directory.resolve("m")
                        + "/*/app.yml,file:" + endless + "[.properties],file:" + variant
                        + "[.properties]", "--spring.profiles.active=edge");
        assertEquals("&x [*x]", prepared.environment().getProperty("a"));
        assertEquals("&y [*y]", prepared.environment().getProperty("b"));
        assertEquals(Map.of(endless, Set.of(ServerEnvironment.Format.PROPERTIES),
                variant, Set.of(ServerEnvironment.Format.PROPERTIES)), prepared.configurations());
        for (ManagedAgentPreflight.Check row : rows(prepared)) {
            assertEquals(ManagedAgentPreflight.Status.PASS, row.status(), row.toString());
        }
        // Spring reads the last location first, here the wildcard, and does
        // not read again a file it then looks up by name: the format is still
        // the one it read it in.
        Path twice = write("twice/a/app.yml", "spring.datasource.password=s3cret\n");
        Files.setPosixFilePermissions(twice, PosixFilePermissions.fromString("rw-r--r--"));
        prepared = prepare(named("file:" + twice + "[.properties],optional:file:"
                + directory.resolve("twice") + "/*/app.yml[.properties]"), new ArrayList<>());
        assertEquals("s3cret", prepared.environment().getProperty("spring.datasource.password"));
        assertEquals(Map.of(twice, Set.of(ServerEnvironment.Format.PROPERTIES)),
                prepared.configurations());
        assertEquals(ManagedAgentPreflight.Status.WARN, rows(prepared).get(0).status());
    }

    @Test
    void readsACommentAsTheSettingItWouldBeUncommented() throws IOException {
        // .properties reads white space as a separator, so this is the
        // password key; a value a backslash continues holds the second line,
        // which is then no comment, unless the backslash is escaped.
        Path spaced = write("config/application.properties",
                "# spring.datasource.password hunter2\n");
        Path continued = write("conf/continued.properties",
                "motd=a\\\n# spring.datasource.password hunter2\n");
        Path escaped = write("conf/escaped.properties",
                "motd=a\\\\\n# spring.datasource.password hunter2\n");
        // However many markers start it, after any indent; and a value is
        // read with its escapes.
        Path marked = write("conf/marked.properties", "#!spring.datasource.password hunter2\n");
        Path indented = write("conf/indented.properties",
                " \t\f# spring.datasource.password hunter2\n");
        Path unicode = write("conf/unicode.properties",
                "spring.datasource.url=jdbc:mysql://db/qwen?pass\\u0077ord=s3cret\n");
        // In YAML, a comment is one however many markers start it, and one
        // YAML cannot read is still read as a line of .properties would be,
        // as is a .properties line in YAML; prose that does not start with a
        // secret's name is none.
        Path doubled = write("conf/doubled.yml", "## spring.datasource.password: x\n");
        Path unreadable = write("conf/unreadable.yml", "# spring.datasource.password: a: b\n");
        Path pasted = write("conf/pasted.yml", "# spring.datasource.password=hunter2\n");
        Path prose = write("conf/prose.yml", "# Set the password in the environment.\n");
        // A list item YAML reads; a # with no white space before it is none.
        Path item = write("conf/item.yml", "# - password: x\n");
        Path fragment = write("conf/fragment.yml", "motd: x#spring.datasource.password: s3cret\n");
        // A value holds one in a comment too, wherever a line would split it.
        Path url = write("conf/url.yml", "# contact jdbc:mysql://app:s3cret@db/qwen\n");
        Path bare = write("conf/bare.properties", "#//app:s3cret@db/qwen\n");
        Path xml = write("conf/prose.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                + "<!DOCTYPE properties SYSTEM \"http://java.sun.com/dtd/properties.dtd\">\n"
                + "<properties><!-- old: <entry key=\"spring.datasource.password\">x</entry>"
                + " --></properties>\n");
        // XML in UTF-16, which its parser reads by the byte order mark.
        Path wide = directory.resolve("conf/wide.xml");
        Files.write(wide, ("<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n"
                + "<!DOCTYPE properties SYSTEM \"http://java.sun.com/dtd/properties.dtd\">\n"
                + "<properties><!-- <entry key=\"spring.datasource.password\">x</entry> -->"
                + "</properties>\n").getBytes(StandardCharsets.UTF_16));
        Map<Path, ManagedAgentPreflight.Status> verdicts = new HashMap<>();
        for (Path file : List.of(spaced, continued, escaped, marked, indented, unicode, doubled,
                unreadable, pasted, prose, item, fragment, url, bare, xml, wide)) {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
            verdicts.put(file, ManagedAgentPreflight.configFileCheck(file, null).status());
        }
        assertEquals(Map.ofEntries(
                Map.entry(spaced, ManagedAgentPreflight.Status.WARN),
                Map.entry(continued, ManagedAgentPreflight.Status.PASS),
                Map.entry(escaped, ManagedAgentPreflight.Status.WARN),
                Map.entry(marked, ManagedAgentPreflight.Status.WARN),
                Map.entry(indented, ManagedAgentPreflight.Status.WARN),
                Map.entry(unicode, ManagedAgentPreflight.Status.WARN),
                Map.entry(doubled, ManagedAgentPreflight.Status.WARN),
                Map.entry(unreadable, ManagedAgentPreflight.Status.WARN),
                Map.entry(pasted, ManagedAgentPreflight.Status.WARN),
                Map.entry(prose, ManagedAgentPreflight.Status.PASS),
                Map.entry(item, ManagedAgentPreflight.Status.WARN),
                Map.entry(fragment, ManagedAgentPreflight.Status.PASS),
                Map.entry(url, ManagedAgentPreflight.Status.WARN),
                Map.entry(bare, ManagedAgentPreflight.Status.WARN),
                Map.entry(xml, ManagedAgentPreflight.Status.WARN),
                Map.entry(wide, ManagedAgentPreflight.Status.WARN)), verdicts);
        // Spring reads the first at its default location.
        ManagedAgentPreflight.Prepared prepared = prepare(named("optional:file:"
                + spaced.getParent() + "/"), new ArrayList<>());
        List<ManagedAgentPreflight.Check> rows = rows(prepared);
        assertEquals(List.of(spaced), prepared.files());
        assertEquals("chmod 600 " + spaced, rows.get(0).fix(), rows.toString());
        // A file that is a config tree's value file too is judged by its
        // value as well: here a URL with a password, in a YAML comment.
        Path both = write("both/application.yml", "# contact jdbc:mysql://app:s3cret@db/qwen\n");
        Files.setPosixFilePermissions(both, PosixFilePermissions.fromString("rw-r--r--"));
        prepared = prepare(named("optional:file:" + both), new ArrayList<>(),
                "--spring.config.import=optional:configtree:" + both.getParent() + "/");
        assertEquals("application.yml", prepared.values().get(both));
        assertEquals(Map.of(both, Set.of(ServerEnvironment.Format.YAML)),
                prepared.configurations());
        rows = rows(prepared);
        assertEquals(1, rows.size(), rows.toString());
        assertEquals(ManagedAgentPreflight.Status.WARN, rows.get(0).status(), rows.toString());
        assertEquals("chmod 600 " + both, rows.get(0).fix());
    }

    @Test
    void judgesWhatACommentHoldsHoweverItIsWritten() throws IOException {
        Map<Path, ManagedAgentPreflight.Status> expected = new HashMap<>();
        // A backslash alone where a key would start joins the next line on,
        // so Spring reads that line afresh, here as a comment; and a comment
        // that ends in one may take the next line in, which is judged too.
        expected.put(write("p/alone.properties", "\\\n# spring.datasource.password=hunter2\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("p/indented.properties", "   \\\n# spring.datasource.password=x\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("p/swallowed.properties", "#x\\\nspring.datasource.password=x\n"),
                ManagedAgentPreflight.Status.WARN);
        // Spring reads an escaped marker as a marker too.
        expected.put(write("p/escaped.properties", "\\# spring.datasource.password=hunter2\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("p/bang.properties", "\\!spring.datasource.password hunter2\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("p/note.properties", "\\# note \\\nspring.datasource.password=x\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("p/unicode.properties", "\\u0023 spring.datasource.password=x\n"),
                ManagedAgentPreflight.Status.WARN);
        // A key Spring writes a collection into names what the collection
        // holds; a key with nothing to bind, as {}, names nothing, and
        // neither does one that is no string. A set's members and pairs'
        // keys, which Spring binds as values, are judged as keys too.
        expected.put(write("k/complex.yml", "? [password]\n: hunter2\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("k/nested.yml", "spring:\n  datasource:\n    ? [password]\n    : x\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("k/empty.yml", "qwen:\n  managed-agent:\n    runtime-broker:\n"
                + "      previous-credential-keys: {}\nserver:\n  port: 8080\n"),
                ManagedAgentPreflight.Status.PASS);
        expected.put(write("k/null.yml", "!!null password: x\n"), ManagedAgentPreflight.Status.PASS);
        expected.put(write("k/set.yml", "x: !!set {password}\n"), ManagedAgentPreflight.Status.WARN);
        expected.put(write("k/blank.yml", "password:\n"), ManagedAgentPreflight.Status.WARN);
        expected.put(write("k/mapkey.yml", "? {a: [password]}\n: x\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("k/emptyset.yml", "password: !!set {}\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("k/emptylist.yml", "password: []\n"), ManagedAgentPreflight.Status.WARN);
        expected.put(write("k/listofempty.yml", "password: [{}]\n"),
                ManagedAgentPreflight.Status.PASS);
        // A merged set's members are keys, and so are the keys of a merge
        // through sets or pairs; pairs bind; a merge of nothing binds nothing.
        expected.put(write("k/mergeset.yml", "<<: !!set {password}\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("k/mergealias.yml", "s: &s !!set {spring.datasource.password}\n"
                + "other:\n  <<: *s\n"), ManagedAgentPreflight.Status.WARN);
        expected.put(write("k/pairs.yml", "password: !!pairs [a: {}]\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("k/pairkeys.yml", "x: !!pairs [password: hunter2]\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("k/mergethrough.yml", "spring:\n  datasource:\n"
                + "    url: jdbc:postgresql://db/app\n"
                + "    <<: !!set {<<: !!pairs [{password: hunter2}]}\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("k/mergesets.yml", "c: {<<: !!set {<<: !!set {password}}}\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("k/mergenothing.yml", "password: {<<: []}\n"),
                ManagedAgentPreflight.Status.PASS);
        expected.put(write("k/mergenested.yml", "s: &s {<<: !!set {password}}\nother:\n  <<: *s\n"),
                ManagedAgentPreflight.Status.WARN);
        // A map that is also a pair is a map where it is one.
        expected.put(write("k/pairalias.yml", "spring:\n  datasource: &m\n    password: hunter2\n"
                + "z: !!pairs [*m]\n"), ManagedAgentPreflight.Status.WARN);
        expected.put(write("k/setmerge.yml", "x: !!set {<<: !!set {password}}\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("k/mergelist.yml", "a: &a {x: 1}\nb: &b !!set {password}\n"
                + "c:\n  <<: [*a, *b]\n"), ManagedAgentPreflight.Status.WARN);
        // A file Spring reads with many aliases, as it lifts SnakeYAML's limit.
        expected.put(write("a/aliases.yml", "base: &b [x]\n" + IntStream.rangeClosed(1, 60)
                .mapToObj(each -> "k" + each + ": *b\n").collect(Collectors.joining())
                + "spring.datasource.password: s3cret\n"), ManagedAgentPreflight.Status.WARN);
        // A key with no value holds no secret.
        expected.put(write("p/bare.properties", "# spring.datasource.password\n"),
                ManagedAgentPreflight.Status.PASS);
        // A value is read with its escapes whatever its key.
        expected.put(write("p/url.properties", "# url jdbc:mysql://db/q?pass\\u0077ord=x\n"),
                ManagedAgentPreflight.Status.WARN);
        // A key and value written as both formats write one, quoted or after
        // a list marker; and a mark or white space an editor put first.
        expected.put(write("p/quoted.yml", "# \"spring.datasource.password\":s3cret\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("p/argument.yml", "# - --spring.datasource.password=s3cret\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("p/quoted.properties", "# \"spring.datasource.password\": s3cret\n"),
                ManagedAgentPreflight.Status.WARN);
        expected.put(write("p/tab.properties", "\u000b# spring.datasource.password=x\n"),
                ManagedAgentPreflight.Status.WARN);
        Path marked = directory.resolve("p/marked.properties");
        Files.write(marked, "\ufeff# spring.datasource.password=hunter2\n"
                .getBytes(StandardCharsets.UTF_8));
        expected.put(marked, ManagedAgentPreflight.Status.WARN);
        Path wide = directory.resolve("p/wide.properties");
        Files.write(wide, "# spring.datasource.password=hunter2\n"
                .getBytes(StandardCharsets.UTF_16));
        expected.put(wide, ManagedAgentPreflight.Status.WARN);
        // XML comments that are no document of their own, entry by entry.
        String head = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE properties SYSTEM"
                + " \"http://java.sun.com/dtd/properties.dtd\">\n<properties>\n";
        String entry = "<entry key=\"spring.datasource.password\">s3cret";
        for (String comment : List.of(
                "<entry key=\"spring.datasource.url\">jdbc:mysql://db/q?a=1&b=2</entry>\n"
                        + entry + "</entry>",
                entry, entry + "</entry> replace with <your-password>",
                "dev & test: " + entry + "</entry>")) {
            expected.put(write("x/" + expected.size() + ".xml", head + "<!-- " + comment
                    + " -->\n<entry key=\"server.port\">8080</entry>\n</properties>\n"),
                    ManagedAgentPreflight.Status.WARN);
        }
        // And as a document of its own, which reads a character reference.
        expected.put(write("x/reference.xml", head + "<!-- <entry key=\"spring.datasource.pass"
                + "&#119;ord\">x</entry> -->\n</properties>\n"), ManagedAgentPreflight.Status.WARN);
        // Prose is no setting, though it names one before a colon.
        expected.put(write("q/database.yml",
                "# Database password: set SPRING_DATASOURCE_PASSWORD in the unit environment\n"),
                ManagedAgentPreflight.Status.PASS);
        expected.put(write("q/admin.yml", "server:\n  port: 8080 # the admin token: see the vault\n"),
                ManagedAgentPreflight.Status.PASS);
        expected.put(write("q/signing.yml", "# Note on the signing key: rotate it yearly\n"),
                ManagedAgentPreflight.Status.PASS);
        // In .properties, a key white space ends is a setting's only where it
        // has a dot, as a property's name has, and prose's first word none.
        for (String prose : List.of("# Password rotation happens yearly",
                "# Key ring for the credential keys, see the configuration reference",
                "# Secret values live in Vault", "# Token refresh is automatic",
                "# password is set in server.env", "! Password policy: see the wiki",
                "# Hockey team settings",
                "# spring.datasource.password is supplied by the unit environment",
                "# qwen.managed-agent.runtime.credential-key must be a base64 32-byte key")) {
            expected.put(write("q/" + expected.size() + ".properties",
                    "server.port=8080\n" + prose + "\n"), ManagedAgentPreflight.Status.PASS);
        }
        expected.put(write("q/pairs.xml", head + "<!-- key=value pairs below -->\n"
                + "<entry key=\"server.port\">8080</entry>\n</properties>\n"),
                ManagedAgentPreflight.Status.PASS);
        Map<Path, ManagedAgentPreflight.Status> verdicts = new HashMap<>();
        for (Path file : expected.keySet()) {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
            verdicts.put(file, ManagedAgentPreflight.configFileCheck(file, null).status());
        }
        assertEquals(expected, verdicts);
    }

    @Test
    void keepsTheRowsWhereItCannotTellTheFilesSpringRead() throws IOException {
        // Spring prepares these, but the check cannot resolve the import's
        // placeholder, or make a path of it; it says so and the other rows
        // still print.
        Path b = write("u/b.properties", "p=${q}\nq=${p}\n");
        Path a = write("u/a.properties", "spring.config.import=optional:file:${p}\n");
        Path nul = write("u/nul.properties", "spring.config.import=optional:file:"
                + directory.resolve("u") + "/*/x\u0000.yml\n");
        Files.createDirectories(directory.resolve("u/d"));
        // So do those a wildcard found, in either format its hint may name,
        // and those a loader read that hold no setting.
        Path found = write("u/w/x/app.yml", "spring.datasource.password=s3cret\n");
        Path endless = write("u/r/x/app.yml", "motd: &y [*y]\n");
        Path quiet = write("u/c.yml", "# spring.datasource.password: s3cret\n");
        for (Path file : List.of(found, endless, quiet)) {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
        }
        ManagedAgentPreflight.Prepared listed = prepare(environment(Map.of()), new ArrayList<>(),
                "--spring.config.location=optional:file:" + directory.resolve("u/w")
                        + "/*/app.yml[.properties],optional:file:" + directory.resolve("u/r")
                        + "/*/app.yml[.properties],file:" + quiet + ",file:" + b + ",file:" + a);
        assertNotNull(listed.unlisted());
        assertEquals("s3cret", listed.environment().getProperty("spring.datasource.password"));
        Map<String, ManagedAgentPreflight.Status> statuses = new HashMap<>();
        for (ManagedAgentPreflight.Check row : rows(listed)) {
            statuses.put(row.detail().split(" ")[0], row.status());
        }
        assertEquals(ManagedAgentPreflight.Status.WARN, statuses.get(found.toString()));
        assertEquals(ManagedAgentPreflight.Status.PASS, statuses.get(endless.toString()));
        assertEquals(ManagedAgentPreflight.Status.WARN, statuses.get(quiet.toString()));
        // The files the property sources name keep their rows, as one the
        // service account cannot read would fail.
        Map<String, List<Path>> named = Map.of("file:" + b + ",file:" + a, List.of(a, b),
                "file:" + nul, List.of(nul));
        for (Map.Entry<String, List<Path>> location : named.entrySet()) {
            List<ManagedAgentPreflight.Check> checks = new ArrayList<>();
            ManagedAgentPreflight.Prepared prepared = prepare(environment(Map.of()), checks,
                    "--spring.config.location=" + location.getKey());
            assertNull(prepared.failure(), location.getKey());
            assertNotNull(prepared.unlisted(), location.getKey());
            assertEquals(Set.copyOf(location.getValue()), Set.copyOf(prepared.files()));
            List<ManagedAgentPreflight.Check> rows = rows(prepared);
            assertEquals(location.getValue().size() + 1, rows.size(), rows.toString());
            ManagedAgentPreflight.Check last = rows.get(rows.size() - 1);
            assertEquals(ManagedAgentPreflight.Status.WARN, last.status());
            assertTrue(last.detail().startsWith("cannot tell which other files the server reads: "),
                    rows.toString());
        }
    }

    @Test
    void boundsWhatACommentCanCost() throws IOException {
        // Spring's YAML loader follows an alias that holds itself, and
        // expands one alias of another without end; a comment never runs
        // either, and a long line of comments takes no time to judge.
        StringBuilder laughs = new StringBuilder("# {a0: &a0 [x]");
        for (int level = 1; level < 9; level++) {
            laughs.append(", a").append(level).append(": &a").append(level).append(" [");
            laughs.append(String.join(", ", Collections.nCopies(10, "*a" + (level - 1))));
            laughs.append("]");
        }
        laughs.append("}");
        StringBuilder chain = new StringBuilder("# {a0: &a0 [x]");
        StringBuilder values = new StringBuilder("# {a0: &a0 {}");
        for (int level = 1; level <= 5000; level++) {
            chain.append(", a").append(level).append(": &a").append(level).append(" [*a")
                    .append(level - 1).append(']');
            values.append(", a").append(level).append(": &a").append(level).append(" {x: *a")
                    .append(level - 1).append('}');
        }
        StringBuilder shared = new StringBuilder("# {k: &k [" + "x, ".repeat(9999) + "x]");
        StringBuilder sharedNamed = new StringBuilder(shared);
        for (int each = 0; each < 10_000; each++) {
            shared.append(", ? [*k, ").append(each).append("] : 1");
            sharedNamed.append(", ? [password, *k, ").append(each).append("] : {}");
        }
        // Many secret keys over values that hold one large map binding
        // nothing: the same value, and others that hold it.
        StringBuilder empties = new StringBuilder("{a0: {}");
        for (int each = 1; each < 20_000; each++) {
            empties.append(", a").append(each).append(": {}");
        }
        empties.append('}');
        StringBuilder empty = new StringBuilder("# {e: &e " + empties);
        StringBuilder holding = new StringBuilder("# {e: &e " + empties);
        for (int each = 0; each < 20_000; each++) {
            empty.append(", p").append(each).append("password: *e");
            holding.append(", p").append(each).append("password: {x: *e}");
        }
        StringBuilder merging = new StringBuilder("# {b: &b {k0: 1");
        for (int each = 1; each < 10_000; each++) {
            merging.append(", k").append(each).append(": 1");
        }
        merging.append('}');
        for (int each = 0; each < 10_000; each++) {
            merging.append(", m").append(each).append(": {<<: *b}");
        }
        // Many pairs, merges or keys sharing one map, list or key.
        StringBuilder wide = new StringBuilder("# {m: &m {k0: 1");
        StringBuilder list = new StringBuilder("# {s: &s [{k0: 1}");
        StringBuilder key = new StringBuilder("# {k: &k [password, x0");
        for (int each = 1; each < 8_000; each++) {
            wide.append(", k").append(each).append(": 1");
            list.append(", {k").append(each).append(": 1}");
            key.append(", x").append(each);
        }
        wide.append("}, y: !!pairs [*m").append(", *m".repeat(7_999)).append("]}");
        list.append(']');
        key.append(']');
        for (int each = 0; each < 8_000; each++) {
            list.append(", m").append(each).append(": {<<: *s}");
            key.append(", ? *k : {}");
        }
        List<Path> files = List.of(
                write("c/recursive.yml", "server:\n  port: 8080\n# &a [*a]\n"),
                write("c/pairs.yml", wide + "\n"),
                write("c/list.yml", list + "}\n"),
                write("c/key.yml", key + "}\n"),
                write("c/merging.yml", merging + "}\n"),
                write("c/unbound.yml", empty + "}\n"),
                write("c/holding.yml", holding + "}\n"),
                write("c/chain.yml", "server:\n  port: 8080\n" + chain + ", ? *a5000 : 1}\n"),
                write("c/values.yml", values + ", password: *a5000}\n"),
                write("c/shared.yml", shared + "}\n"),
                write("c/shared-named.yml", "server:\n  port: 8080\n" + sharedNamed + "}\n"),
                write("c/laughs.yml", "server:\n  port: 8080\n" + laughs + "\n"),
                write("c/long.yml", "motd: x" + " #a".repeat(40_000) + "\n"),
                write("c/colons.yml", "# //" + "h:1,".repeat(40_000) + "\n"));
        // Nor does a file a hint names .properties for, read as its name says.
        Path hinted = write("c/hinted.yml", laughs.substring(2) + "\n");
        assertTimeoutPreemptively(Duration.ofSeconds(10), () -> {
            for (Path file : files) {
                Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
                assertEquals(ManagedAgentPreflight.Status.PASS,
                        ManagedAgentPreflight.configFileCheck(file, null).status(), file.toString());
            }
            ManagedAgentPreflight.Prepared prepared = prepare(environment(Map.of()),
                    new ArrayList<>(), "--spring.config.location=file:" + hinted + "[.properties]");
            assertEquals(Map.of(hinted, Set.of(ServerEnvironment.Format.PROPERTIES)),
                    prepared.configurations());
            assertEquals(ManagedAgentPreflight.Status.PASS, rows(prepared).get(0).status());
        });
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
                url, null, "spring.datasource.url", Set.of()).status());
        assertEquals(ManagedAgentPreflight.Status.PASS, ManagedAgentPreflight.configFileCheck(
                port, null, "server.port", Set.of()).status());
        // In UTF-16 too, after its byte order mark.
        Path wide = directory.resolve("tree/spring.datasource.jdbc-url");
        Files.write(wide, "jdbc:mysql://app:s3cret@db/qwen".getBytes(StandardCharsets.UTF_16));
        Files.setPosixFilePermissions(wide, PosixFilePermissions.fromString("rw-r--r--"));
        assertEquals(ManagedAgentPreflight.Status.WARN, ManagedAgentPreflight.configFileCheck(
                wide, null, "spring.datasource.jdbc-url", Set.of()).status());
        // A file whose extension Spring is told, as file:app.conf[.properties].
        Path hinted = write("etc/app.conf", "spring.datasource.password=s3cret\n");
        Files.setPosixFilePermissions(hinted, PosixFilePermissions.fromString("rw-r--r--"));
        prepared = prepare(named("file:" + hinted + "[.properties]"), new ArrayList<>());
        assertEquals("s3cret", prepared.environment().getProperty("spring.datasource.password"));
        assertEquals(List.of(hinted), prepared.files());
        assertEquals(ManagedAgentPreflight.Status.WARN, rows(prepared).get(0).status());
        // Spring reads one whose lines are all comments too, though it
        // declares no key, and the variant of a profile beside it, which
        // Spring names after the hinted file as written.
        Path template = write("notes/notes.conf", "# spring.datasource.password=change-me\n");
        Path edge = write("notes/notes.conf-edge", "# spring.datasource.password=change-me\n");
        for (Path file : List.of(template, edge)) {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
        }
        prepared = prepare(named("file:" + template + "[.properties]"), new ArrayList<>(),
                "--spring.profiles.active=edge");
        assertEquals(List.of(template, edge), prepared.files());
        rows = rows(prepared);
        assertEquals(List.of(ManagedAgentPreflight.Status.WARN, ManagedAgentPreflight.Status.WARN),
                rows.stream().map(ManagedAgentPreflight.Check::status).toList(), rows.toString());
        assertEquals("chmod 600 " + template, rows.get(0).fix());
        // It is a value file too, of a property named app.conf, under a config
        // tree imported over its directory; its keys still tell.
        prepared = prepare(named("file:" + hinted + "[.properties]"), new ArrayList<>(),
                "--spring.config.import=optional:configtree:" + hinted.getParent() + "/");
        assertEquals("app.conf", prepared.values().get(hinted));
        assertEquals(Set.of(hinted), prepared.configurations().keySet());
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
        assertEquals(Set.of(), prepared.configurations().keySet());
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
        // does not hold: Spring looked up its variant alone.
        Files.writeString(config, "spring.profiles.active: zzz\n");
        assertEquals(zzz + problem,
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
        // Or as UTF-8 after one, which it drops, as before a commented-out key.
        Path marked = directory.resolve("config/marked.yml");
        Files.write(marked, ("\ufeff# spring.datasource.password: s3cret\n")
                .getBytes(StandardCharsets.UTF_8));
        for (Path file : List.of(properties, big, little, marked)) {
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
            // No datasource URL fails the database row, and a FAIL exits 1.
            assertEquals(1, process.exitValue(), report);
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
            assertEquals(List.of("FAIL no datasource URL"), rows.get("database"), report);
            // The only other FAIL could be server-port, should another process
            // take the port freePort() let go; the line above names it.
            assertEquals(List.of("database"), rows.entrySet().stream()
                    .filter(row -> !row.getKey().equals("server-port"))
                    .filter(row -> row.getValue().stream().anyMatch(line -> line.startsWith("FAIL ")))
                    .map(Map.Entry::getKey).toList(), report);
        } finally {
            Files.deleteIfExists(output);
        }
    }
}
