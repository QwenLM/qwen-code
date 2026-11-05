package com.alibaba.qwen.code.managedagent.preflight;

import org.springframework.boot.ApplicationContextFactory;
import org.springframework.boot.DefaultBootstrapContext;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.context.config.ConfigDataNotFoundException;
import org.springframework.boot.context.config.ConfigDataResourceNotFoundException;
import org.springframework.boot.context.config.StandardConfigDataResource;
import org.springframework.boot.context.event.ApplicationEnvironmentPreparedEvent;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.bind.PropertySourcesPlaceholdersResolver;
import org.springframework.boot.context.properties.source.ConfigurationPropertySources;
import org.springframework.boot.convert.ApplicationConversionService;
import org.springframework.boot.env.ConfigTreePropertySource;
import org.springframework.boot.env.EnvironmentPostProcessorApplicationListener;
import org.springframework.boot.env.OriginTrackedMapPropertySource;
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

import java.io.FileNotFoundException;
import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Predicate;
import java.util.regex.Pattern;

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
    // Those of the property source loaders Spring Boot registers.
    private static final List<String> EXTENSIONS = List.of("yml", "yaml", "properties", "xml");
    // A location such as classpath: or configtree:, as Spring tells one from a path.
    private static final Pattern SCHEME = Pattern.compile("^[a-zA-Z][a-zA-Z0-9*]*?:");
    private static final String IMPORT = "spring.config.import";

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
     * and other class path resources are left out.
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
        for (Path file : locationFiles(environment, workingDirectory, profiles).keySet()) {
            if (Files.isRegularFile(file)) {
                files.add(file.toAbsolutePath().normalize());
            }
        }
        return new ArrayList<>(files);
    }

    /**
     * The config tree value files among {@link #files}, each with the
     * property it holds the value of, as its name is all that says whether
     * the value is a secret.
     */
    static Map<Path, String> valueFiles(ConfigurableEnvironment environment) {
        Map<Path, String> values = new LinkedHashMap<>();
        for (PropertySource<?> source : environment.getPropertySources()) {
            if (source instanceof ConfigTreePropertySource tree) {
                for (String name : tree.getPropertyNames()) {
                    Path file = file(resource(tree.getOrigin(name)));
                    if (file != null) {
                        values.put(file, name);
                    }
                }
            }
        }
        return values;
    }

    /** A file system location, which names a directory when it ends in a slash. */
    private record Location(Path path, boolean directory) {
    }

    /**
     * The file system locations named at the top level, by the arguments or
     * the process environment, and those imported, at the top level or by a
     * file Spring read. Locations of another kind, such as classpath: or
     * configtree:, are left out.
     */
    private static List<Location> named(ConfigurableEnvironment environment,
            Path workingDirectory) {
        List<Location> named = new ArrayList<>();
        for (String property : List.of("spring.config.import",
                "spring.config.additional-location", "spring.config.location")) {
            locations(String.join(",", topLevel(environment, property)), workingDirectory,
                    workingDirectory, named);
        }
        // Spring honours an import a file declares, and no other location a
        // file sets; it reads a bare relative one beside that file.
        for (PropertySource<?> source : environment.getPropertySources()) {
            if (!(source instanceof OriginTrackedMapPropertySource tracked)) {
                continue;
            }
            for (Map.Entry<String, Object> entry : tracked.getSource().entrySet()) {
                String key = entry.getKey();
                if (!key.equals(IMPORT) && !key.startsWith(IMPORT + "[")) {
                    continue;
                }
                Path declaring = file(resource(tracked.getOrigin(key)));
                if (declaring != null) {
                    locations(String.valueOf(entry.getValue()), workingDirectory,
                            declaring.getParent(), named);
                }
            }
        }
        return named;
    }

    /**
     * Adds the file system locations of a value: a file: one, read in the
     * working directory when relative, and a bare one, read in base.
     */
    private static void locations(String value, Path workingDirectory, Path base,
            List<Location> named) {
        if (value == null) {
            return;
        }
        for (String location : value.split("[,;]")) {
            String path = location.strip().replaceFirst("^optional:", "");
            Path relativeTo = base;
            if (path.startsWith("file:")) {
                // A colon after it is part of the path.
                path = path.substring("file:".length());
                relativeTo = workingDirectory;
            } else if (SCHEME.matcher(path).lookingAt()) {
                continue;
            }
            if (!path.isEmpty()) {
                named.add(new Location(relativeTo.resolve(path), path.endsWith("/")));
            }
        }
    }

    /**
     * A property as Spring reads it before any file, as it reads the
     * locations and spring.config.name: from the arguments, the process
     * environment and the other sources no configuration file adds.
     */
    private static List<String> topLevel(ConfigurableEnvironment environment, String property) {
        List<PropertySource<?>> sources = new ArrayList<>();
        for (PropertySource<?> source : environment.getPropertySources()) {
            if (!(source instanceof OriginTrackedMapPropertySource)
                    && !(source instanceof ConfigTreePropertySource)) {
                sources.add(source);
            }
        }
        // from() skips the attached view of every source, files' included;
        // a placeholder resolves against the same sources, as Spring's.
        return new Binder(ConfigurationPropertySources.from(sources),
                new PropertySourcesPlaceholdersResolver(sources))
                .bind(property, Bindable.listOf(String.class)).orElse(List.of());
    }

    /**
     * The files Spring looks for at the locations {@link #named} finds and,
     * unless spring.config.location replaces them, at its default ones in
     * the working directory: each location's files, then their variants for
     * these profiles, or for any profile when profiles is null. Where Spring
     * refused to start, the files it read are not known, so neither is a
     * location one of them imports.
     */
    private static Map<Path, String> locationFiles(ConfigurableEnvironment environment,
            Path workingDirectory, List<String> profiles) {
        List<String> names = new ArrayList<>();
        for (String name : topLevel(environment, "spring.config.name")) {
            if (!name.isBlank()) {
                names.add(name.strip());
            }
        }
        if (names.isEmpty()) {
            names.add("application");
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
        if (topLevel(environment, "spring.config.location").isEmpty()) {
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
        // Each file, then its variants, each with the profile it is for.
        Map<Path, String> located = new LinkedHashMap<>();
        for (Path file : files) {
            located.put(file, null);
        }
        for (Path file : files) {
            variants(file, profiles).forEach(located::putIfAbsent);
        }
        return located;
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

    /**
     * The profile variants of a file, as application-edge.yml is of
     * application.yml, each with its profile.
     */
    private static Map<Path, String> variants(Path file, List<String> profiles) {
        String name = file.getFileName().toString();
        int dot = name.lastIndexOf('.');
        if (dot <= 0) {
            return Map.of();
        }
        String stem = name.substring(0, dot) + "-";
        String extension = name.substring(dot);
        Path directory = file.getParent() == null ? Path.of("") : file.getParent();
        Map<Path, String> variants = new LinkedHashMap<>();
        if (profiles != null) {
            for (String profile : profiles) {
                variants.put(directory.resolve(stem + profile + extension), profile);
            }
            return variants;
        }
        List<Path> found = new ArrayList<>();
        try (DirectoryStream<Path> each = Files.newDirectoryStream(directory, path -> {
            String other = path.getFileName().toString();
            return other.startsWith(stem) && other.endsWith(extension)
                    && other.length() > stem.length() + extension.length();
        })) {
            each.forEach(found::add);
        } catch (IOException error) {
            // No such directory, or none to read.
        }
        found.sort(null);
        for (Path variant : found) {
            String other = variant.getFileName().toString();
            variants.put(variant, other.substring(stem.length(), other.length() - extension.length()));
        }
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
        Map<Path, String> located = locationFiles(environment, workingDirectory, null);
        Set<Path> candidates = located.keySet();
        IOException io = cause(error, IOException.class);
        if (io != null) {
            // The file the error names, which an import inside another file
            // may have led to; else the first of those Spring reads that
            // this process cannot.
            Path named = ioFile(io, workingDirectory);
            if (named != null && Files.isRegularFile(named) && !readable.test(named)) {
                return unreadable(named.toAbsolutePath().normalize(), user);
            }
            for (Path candidate : candidates) {
                if (Files.isRegularFile(candidate) && !readable.test(candidate)) {
                    return unreadable(candidate.toAbsolutePath().normalize(), user);
                }
            }
        }
        MarkedYAMLException marked = cause(error, MarkedYAMLException.class);
        if (marked != null) {
            // The files with the same problem at the same place: those Spring
            // reads for certain, a base file or a variant of a profile the
            // arguments or the environment activate, else every one, since a
            // file may activate a profile too.
            Set<String> active = new LinkedHashSet<>(topLevel(environment, "spring.profiles.active"));
            active.addAll(topLevel(environment, "spring.profiles.include"));
            List<String> matches = new ArrayList<>();
            List<String> read = new ArrayList<>();
            for (Map.Entry<Path, String> candidate : located.entrySet()) {
                Path file = candidate.getKey();
                if (Files.isRegularFile(file) && sameProblem(yamlError(file), marked)) {
                    String name = file.toAbsolutePath().normalize().toString();
                    matches.add(name);
                    if (candidate.getValue() == null || active.contains(candidate.getValue())) {
                        read.add(name);
                    }
                }
            }
            if (matches.isEmpty()) {
                // In a file an import names from inside another.
                return yamlFailure("a configuration file", marked);
            }
            return yamlFailure(String.join(" or ", read.isEmpty() ? matches : read), marked);
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

    /** The file an I/O error is about, as the process opened it, or null. */
    private static Path ioFile(IOException error, Path workingDirectory) {
        String name = null;
        if (error instanceof FileSystemException system) {
            name = system.getFile();
        } else if (error instanceof FileNotFoundException && error.getMessage() != null) {
            // "<path> (<reason>)", as FileInputStream words it.
            String message = error.getMessage();
            int reason = message.lastIndexOf(" (");
            name = reason > 0 && message.endsWith(")") ? message.substring(0, reason) : message;
        }
        if (name == null || name.isEmpty()) {
            return null;
        }
        try {
            return workingDirectory.resolve(name);
        } catch (InvalidPathException invalid) {
            return null;
        }
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
