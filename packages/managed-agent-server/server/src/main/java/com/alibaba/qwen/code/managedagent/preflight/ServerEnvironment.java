package com.alibaba.qwen.code.managedagent.preflight;

import org.springframework.boot.ApplicationContextFactory;
import org.springframework.boot.DefaultBootstrapContext;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.context.config.ConfigDataNotFoundException;
import org.springframework.boot.context.config.ConfigDataResourceNotFoundException;
import org.springframework.boot.context.config.StandardConfigDataResource;
import org.springframework.boot.context.event.ApplicationEnvironmentPreparedEvent;
import org.springframework.boot.context.properties.source.ConfigurationPropertySources;
import org.springframework.boot.convert.ApplicationConversionService;
import org.springframework.boot.env.EnvironmentPostProcessorApplicationListener;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.boot.origin.Origin;
import org.springframework.boot.origin.OriginLookup;
import org.springframework.boot.origin.OriginTrackedResource;
import org.springframework.boot.origin.TextResourceOrigin;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.EnumerablePropertySource;
import org.springframework.core.env.PropertySource;
import org.springframework.core.env.SimpleCommandLinePropertySource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.yaml.snakeyaml.error.Mark;
import org.yaml.snakeyaml.error.MarkedYAMLException;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.function.Predicate;

/**
 * The environment the server runs with, prepared the way
 * {@link SpringApplication} prepares it before it creates a context: the
 * arguments, the process environment, every environment post-processor on the
 * class path (configuration files at Spring Boot's default locations and at
 * the ones named, imports, profiles, {@code SPRING_APPLICATION_JSON}) and
 * relaxed binding. It starts no context, logs nothing and opens no
 * connection. Relative locations, such as the default {@code ./config/}, are
 * read in the working directory, as the server reads them, so the result is
 * the server's only when it runs with the unit's working directory.
 */
final class ServerEnvironment {
    // Where Spring Boot looks without being told, relative to the working
    // directory; config/*/ is a wildcard.
    private static final List<String> DEFAULT_DIRECTORIES = List.of("", "config", "config/*");
    private static final List<String> EXTENSIONS = List.of("yml", "yaml", "properties");

    private ServerEnvironment() {
    }

    /** Prepares a fresh servlet environment, as the server's own. */
    static ConfigurableEnvironment prepare(String[] args) {
        return prepare(args, ApplicationContextFactory.DEFAULT
                .createEnvironment(WebApplicationType.SERVLET));
    }

    /**
     * Prepares {@code environment}, whose process variables and system
     * properties a test may replace. Throws what Spring would throw at start:
     * for a named location that does not exist, or a file it cannot read.
     */
    static ConfigurableEnvironment prepare(String[] args,
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
        return environment;
    }

    /**
     * The configuration files the server reads from the file system, highest
     * precedence first, each once, absolute and normalized: those that hold
     * a setting, each value file of a config tree among them, then those
     * Spring reads at a location without finding a setting, such as a copy
     * of the example with every line commented out. The packaged defaults
     * and other class path resources are left out, and so is a file without
     * a setting that an import names from inside another.
     */
    static List<Path> files(ConfigurableEnvironment environment) {
        return files(environment, Path.of(""));
    }

    /** As above, with the working directory the default locations are in. */
    static List<Path> files(ConfigurableEnvironment environment, Path workingDirectory) {
        Set<Path> files = new LinkedHashSet<>();
        for (PropertySource<?> source : environment.getPropertySources()) {
            if (!(source instanceof EnumerablePropertySource<?> enumerable)) {
                continue;
            }
            for (String name : enumerable.getPropertyNames()) {
                Path file = file(resource(OriginLookup.getOrigin(source, name)));
                if (file != null) {
                    files.add(file);
                }
            }
        }
        String[] active = environment.getActiveProfiles();
        List<String> profiles = List.of(active.length > 0 ? active
                : environment.getDefaultProfiles());
        for (Path file : locationFiles(environment, workingDirectory, profiles)) {
            if (Files.isRegularFile(file)) {
                files.add(file.toAbsolutePath().normalize());
            }
        }
        return new ArrayList<>(files);
    }

    /** A file system location, which names a directory when it ends in a slash. */
    private record Location(Path path, boolean directory) {
    }

    /**
     * The file system locations named at the top level, by the arguments or
     * the process environment. Locations of another kind, such as
     * classpath: or configtree:, are left out.
     */
    private static List<Location> named(ConfigurableEnvironment environment,
            Path workingDirectory) {
        List<Location> named = new ArrayList<>();
        for (String property : List.of("spring.config.import",
                "spring.config.additional-location", "spring.config.location")) {
            String value = environment.getProperty(property);
            if (value == null) {
                continue;
            }
            for (String location : value.split("[,;]")) {
                String path = location.strip().replaceFirst("^optional:", "")
                        .replaceFirst("^file:", "");
                if (!path.isEmpty() && !path.contains(":")) {
                    named.add(new Location(workingDirectory.resolve(path),
                            path.endsWith("/")));
                }
            }
        }
        return named;
    }

    /**
     * The files Spring looks for at the locations named at the top level
     * and, unless spring.config.location replaces them, at its default ones
     * in the working directory: each location's files, then their variants
     * for these profiles, or for any profile when profiles is null. A file
     * an import names from inside another is not among them.
     */
    private static Set<Path> locationFiles(ConfigurableEnvironment environment,
            Path workingDirectory, List<String> profiles) {
        List<String> names = new ArrayList<>();
        for (String name : environment.getProperty("spring.config.name",
                "application").split(",")) {
            if (!name.isBlank()) {
                names.add(name.strip());
            }
        }
        List<Path> directories = new ArrayList<>();
        Set<Path> files = new LinkedHashSet<>();
        for (Location named : named(environment, workingDirectory)) {
            if (named.directory()) {
                directories.add(named.path());
            } else {
                files.add(named.path());
            }
        }
        if (environment.getProperty("spring.config.location") == null) {
            for (String directory : DEFAULT_DIRECTORIES) {
                directories.add(workingDirectory.resolve(directory));
            }
        }
        for (Path location : directories) {
            for (Path directory : expand(location)) {
                for (String name : names) {
                    for (String extension : EXTENSIONS) {
                        files.add(directory.resolve(name + "." + extension));
                    }
                }
            }
        }
        Set<Path> variants = new LinkedHashSet<>();
        for (Path file : files) {
            variants.addAll(variants(file, profiles));
        }
        files.addAll(variants);
        return files;
    }

    /** The directory, or for a last name of *, each directory in its parent. */
    private static List<Path> expand(Path location) {
        Path name = location.getFileName();
        if (name == null || !name.toString().equals("*")) {
            return List.of(location);
        }
        List<Path> directories = new ArrayList<>();
        Path parent = location.getParent() == null ? Path.of("") : location.getParent();
        try (DirectoryStream<Path> nested = Files.newDirectoryStream(parent, Files::isDirectory)) {
            nested.forEach(directories::add);
        } catch (IOException error) {
            // No such directory, or none to read.
        }
        directories.sort(null);
        return directories;
    }

    /** The profile variants of a file, as application-edge.yml is of application.yml. */
    private static List<Path> variants(Path file, List<String> profiles) {
        String name = file.getFileName().toString();
        int dot = name.lastIndexOf('.');
        if (dot <= 0) {
            return List.of();
        }
        String stem = name.substring(0, dot) + "-";
        String extension = name.substring(dot);
        Path directory = file.getParent() == null ? Path.of("") : file.getParent();
        List<Path> variants = new ArrayList<>();
        if (profiles != null) {
            for (String profile : profiles) {
                variants.add(directory.resolve(stem + profile + extension));
            }
            return variants;
        }
        try (DirectoryStream<Path> each = Files.newDirectoryStream(directory, path -> {
            String other = path.getFileName().toString();
            return other.startsWith(stem) && other.endsWith(extension)
                    && other.length() > stem.length() + extension.length();
        })) {
            each.forEach(variants::add);
        } catch (IOException error) {
            // No such directory, or none to read.
        }
        variants.sort(null);
        return variants;
    }

    private static Resource resource(Origin origin) {
        for (Origin each = origin; each != null; each = each.getParent()) {
            if (each instanceof TextResourceOrigin text) {
                return text.getResource();
            }
        }
        return null;
    }

    /** The file a resource reads, or null for one on the class path. */
    private static Path file(Resource resource) {
        Resource each = resource;
        // Spring wraps each loaded resource with the origin of its location.
        while (each instanceof OriginTrackedResource tracked) {
            each = tracked.getResource();
        }
        if (each == null || each instanceof ClassPathResource || !each.isFile()) {
            return null;
        }
        try {
            return each.getFile().toPath().toAbsolutePath().normalize();
        } catch (IOException error) {
            return null;
        }
    }

    /**
     * What a config row says of a failure of {@link #prepare}, and its fix;
     * the file this process cannot read when that is the failure, which the
     * server may read as another account.
     */
    record Failure(String detail, String fix, Path unreadable) {
        Failure(String detail, String fix) {
            this(detail, fix, null);
        }
    }

    /**
     * A failure of {@link #prepare} in an operator's words: the file or
     * location that does not exist; the file this process cannot read, or
     * the file and line of a YAML error, neither of which Spring's message
     * names; or Spring's own message with the cause that explains it.
     * {@code environment} is the one prepare was given, which still holds
     * the arguments and the process environment.
     */
    static Failure failure(RuntimeException error, ConfigurableEnvironment environment) {
        return failure(error, environment, Files::isReadable, Files::notExists, Path.of(""));
    }

    /**
     * As above, with whether this process reads a file, whether it can tell
     * that a file does not exist, and the working directory the default
     * locations are in, which a test may decide.
     */
    static Failure failure(RuntimeException error, ConfigurableEnvironment environment,
            Predicate<Path> readable, Predicate<Path> missing, Path workingDirectory) {
        String user = System.getProperty("user.name", "");
        if (error instanceof ConfigDataNotFoundException notFound) {
            Path file = notFound instanceof ConfigDataResourceNotFoundException resource
                    && resource.getResource() instanceof StandardConfigDataResource standard
                    ? file(standard.getResource()) : null;
            // Spring cannot tell a file from none behind a directory it may not enter.
            if (file != null && !missing.test(file)) {
                return unreadable(file, user);
            }
            return new Failure((file == null ? notFound.getReferenceDescription() : file)
                    + " does not exist", "create it, or correct the location that names it");
        }
        Set<Path> candidates = locationFiles(environment, workingDirectory, null);
        if (cause(error, IOException.class) != null) {
            for (Path candidate : candidates) {
                if (Files.isRegularFile(candidate) && !readable.test(candidate)) {
                    return unreadable(candidate.toAbsolutePath().normalize(), user);
                }
            }
        }
        MarkedYAMLException marked = cause(error, MarkedYAMLException.class);
        if (marked != null) {
            for (Path candidate : candidates) {
                // The same problem at the same place, as a profile variant
                // no profile activates may hold another error.
                if (Files.isRegularFile(candidate)
                        && sameProblem(yamlError(candidate), marked)) {
                    return yamlFailure(candidate.toAbsolutePath().normalize().toString(),
                            marked);
                }
            }
            // In a file an import names from inside another.
            return yamlFailure("a configuration file", marked);
        }
        String message = oneLine(error.getMessage());
        String cause = oneLine(ManagedAgentPreflight.rootMessage(error));
        // A wrapper's message often repeats its cause.
        return new Failure(message.isEmpty() || message.contains(cause) ? cause
                : message + ": " + cause, "correct the configuration Spring names");
    }

    private static Failure unreadable(Path file, String user) {
        return new Failure(file + " is not readable by " + user,
                ManagedAgentPreflight.unreadableFix(user, file.toString()), file);
    }

    private static <T extends Throwable> T cause(Throwable error, Class<T> type) {
        Throwable each = error;
        // A cause chain may loop.
        for (int depth = 0; each != null && depth < 32; depth++, each = each.getCause()) {
            if (type.isInstance(each)) {
                return type.cast(each);
            }
        }
        return null;
    }

    private static boolean sameProblem(MarkedYAMLException candidate, MarkedYAMLException thrown) {
        if (candidate == null || !Objects.equals(candidate.getProblem(), thrown.getProblem())) {
            return false;
        }
        Mark one = candidate.getProblemMark();
        Mark other = thrown.getProblemMark();
        return one == null ? other == null : other != null
                && one.getLine() == other.getLine() && one.getColumn() == other.getColumn();
    }

    private static Failure yamlFailure(String where, MarkedYAMLException error) {
        Mark mark = error.getProblemMark();
        return new Failure(where + (mark == null ? "" : ", line " + (mark.getLine() + 1)
                + ", column " + (mark.getColumn() + 1)) + ": " + oneLine(error.getProblem()),
                "fix the YAML syntax");
    }

    private static String oneLine(String text) {
        return text == null ? "" : text.strip().replaceAll("\\s+", " ");
    }

    /** The YAML error a file holds, or null for a file that parses or is no YAML. */
    private static MarkedYAMLException yamlError(Path file) {
        String name = file.getFileName().toString();
        if (!name.endsWith(".yml") && !name.endsWith(".yaml")) {
            return null;
        }
        try {
            new YamlPropertySourceLoader().load("candidate", new FileSystemResource(file));
            return null;
        } catch (RuntimeException error) {
            return cause(error, MarkedYAMLException.class);
        } catch (IOException error) {
            return null;
        }
    }
}
