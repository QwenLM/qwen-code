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
import org.springframework.boot.env.OriginTrackedMapPropertySource;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.boot.origin.Origin;
import org.springframework.boot.origin.OriginTrackedResource;
import org.springframework.boot.origin.TextResourceOrigin;
import org.springframework.core.env.ConfigurableEnvironment;
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
    private static final List<String> DEFAULT_DIRECTORIES = List.of("", "config");
    private static final List<String> CONFIG_FILES = List.of("application.yml",
            "application.yaml", "application.properties");

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
     * precedence first, each once, absolute and normalized. The packaged
     * defaults and other class path resources are left out. A file that holds
     * no setting adds no property source, so one named outright, such as a
     * copy of the example with every line commented out, follows the others.
     */
    static List<Path> files(ConfigurableEnvironment environment) {
        Set<Path> files = new LinkedHashSet<>();
        for (PropertySource<?> source : environment.getPropertySources()) {
            if (!(source instanceof OriginTrackedMapPropertySource tracked)
                    || tracked.getSource().isEmpty()) {
                continue;
            }
            Path file = file(resource(tracked.getOrigin(
                    tracked.getSource().keySet().iterator().next())));
            if (file != null) {
                files.add(file);
            }
        }
        for (Location named : named(environment)) {
            if (!named.directory() && Files.isRegularFile(named.path())) {
                files.add(named.path().toAbsolutePath().normalize());
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
     * classpath:, are left out.
     */
    private static List<Location> named(ConfigurableEnvironment environment) {
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
                    named.add(new Location(Path.of(path), path.endsWith("/")));
                }
            }
        }
        return named;
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

    /** What a config row says of a failure of {@link #prepare}, and its fix. */
    record Failure(String detail, String fix) {
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
        return failure(error, environment, Files::isReadable, Path.of(""));
    }

    /**
     * As above, with whether this process reads a file and the working
     * directory the default locations are in, which a test may decide.
     */
    static Failure failure(RuntimeException error, ConfigurableEnvironment environment,
            Predicate<Path> readable, Path workingDirectory) {
        if (error instanceof ConfigDataNotFoundException missing) {
            Path file = missing instanceof ConfigDataResourceNotFoundException resource
                    && resource.getResource() instanceof StandardConfigDataResource standard
                    ? file(standard.getResource()) : null;
            return new Failure((file == null ? missing.getReferenceDescription() : file)
                    + " does not exist", "create it, or correct the location that names it");
        }
        String user = System.getProperty("user.name", "");
        for (Path candidate : candidates(environment, workingDirectory)) {
            if (!Files.isRegularFile(candidate)) {
                continue;
            }
            Path file = candidate.toAbsolutePath().normalize();
            if (!readable.test(candidate)) {
                return new Failure(file + " is not readable by " + user,
                        "chown " + user + " " + file + ", chmod 600 " + file
                                + ", and let " + user + " enter every directory on its path");
            }
            if (yamlError(candidate) instanceof MarkedYAMLException marked) {
                return yamlFailure(file.toString(), marked);
            }
        }
        if (error instanceof MarkedYAMLException marked) {
            // In a file an import names from inside another.
            return yamlFailure("a configuration file", marked);
        }
        String message = oneLine(error.getMessage());
        String cause = oneLine(ManagedAgentPreflight.rootMessage(error));
        // A wrapper's message often repeats its cause.
        return new Failure(message.isEmpty() || message.contains(cause) ? cause
                : message + ": " + cause, "correct the configuration Spring names");
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
    private static RuntimeException yamlError(Path file) {
        String name = file.getFileName().toString();
        if (!name.endsWith(".yml") && !name.endsWith(".yaml")) {
            return null;
        }
        try {
            new YamlPropertySourceLoader().load("candidate", new FileSystemResource(file));
            return null;
        } catch (RuntimeException error) {
            return error;
        } catch (IOException error) {
            return null;
        }
    }

    /**
     * The files Spring may have failed on, in the order it reads them: those
     * named at the top level, by the arguments or the process environment,
     * then those at Spring Boot's default locations in the working directory.
     * A file an import names from inside another is not among them.
     */
    private static Set<Path> candidates(ConfigurableEnvironment environment,
            Path workingDirectory) {
        Set<Path> candidates = new LinkedHashSet<>();
        for (Location named : named(environment)) {
            if (named.directory()) {
                filesIn(named.path(), candidates);
            } else {
                candidates.add(named.path());
            }
        }
        for (String directory : DEFAULT_DIRECTORIES) {
            filesIn(workingDirectory.resolve(directory), candidates);
        }
        try (DirectoryStream<Path> nested = Files.newDirectoryStream(
                workingDirectory.resolve("config"), Files::isDirectory)) {
            for (Path directory : nested) {
                filesIn(directory, candidates);
            }
        } catch (IOException error) {
            // No config/ directory, or none to read.
        }
        return candidates;
    }

    private static void filesIn(Path directory, Set<Path> candidates) {
        for (String name : CONFIG_FILES) {
            candidates.add(directory.resolve(name));
        }
    }
}
