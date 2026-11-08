package com.alibaba.qwen.code.managedagent.preflight;

import org.springframework.boot.DefaultBootstrapContext;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.context.config.ConfigDataLocation;
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
import org.springframework.boot.env.PropertiesPropertySourceLoader;
import org.springframework.boot.env.PropertySourceLoader;
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
import org.springframework.core.io.DefaultResourceLoader;
import org.springframework.core.io.FileUrlResource;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;
import org.springframework.util.ResourceUtils;
import org.springframework.util.StringUtils;
import org.yaml.snakeyaml.DumperOptions;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;
import org.yaml.snakeyaml.error.Mark;
import org.yaml.snakeyaml.error.MarkedYAMLException;
import org.yaml.snakeyaml.nodes.Tag;
import org.yaml.snakeyaml.reader.UnicodeReader;
import org.yaml.snakeyaml.representer.Representer;
import org.yaml.snakeyaml.resolver.Resolver;

import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
import java.nio.file.AccessDeniedException;
import java.nio.file.DirectoryStream;
import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Predicate;
import java.util.regex.Matcher;
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
    // The one of Spring Boot's default locations it lists rather than looks
    // a file up in, relative to the working directory.
    private static final String DEFAULT_WILDCARD = "config/*";
    // Those of the property source loaders Spring Boot registers.
    private static final List<String> EXTENSIONS = List.of("yml", "yaml", "properties", "xml");
    // A location Spring reads as written rather than beside the file that
    // imports it, as its StandardConfigDataLocationResolver tells one.
    private static final Pattern FIXED = Pattern.compile("^[a-zA-Z][a-zA-Z0-9*]*?:");
    // A file name with the extension it is read by, as Spring's
    // FileExtensionHint tells one: app.conf[.properties].
    private static final Pattern HINT = Pattern.compile("^(.*)\\[(\\.\\w+)](?!\\[)$");
    private static final String IMPORT = "spring.config.import";
    private static final String LOOKED_UP = "qwen-managed-agent-preflight-looked-up";

    private ServerEnvironment() {
    }

    /**
     * How Spring reads a configuration file: by the property source loader
     * its location names, by the file's extension or the one the location
     * hints, as YAML or as .properties, whose loader reads a file whose name
     * ends in .xml as XML.
     */
    enum Format {
        YAML, PROPERTIES, XML;

        static Format read(boolean yaml, String fileName) {
            return yaml ? YAML : fileName.endsWith(".xml") ? XML : PROPERTIES;
        }

        /** The format of a file by the loader that reads it, or null for another loader. */
        static Format read(Class<?> loader, String fileName) {
            boolean yaml = YamlPropertySourceLoader.class.isAssignableFrom(loader);
            return yaml || PropertiesPropertySourceLoader.class.isAssignableFrom(loader)
                    ? read(yaml, fileName) : null;
        }

        /**
         * The formats Spring reads a file of this name in at a location that
         * hints no extension: the one its extension names, in any case, or
         * either for a name with none, which a hint must have named.
         */
        static Set<Format> named(String fileName) {
            String lower = fileName.toLowerCase(Locale.ROOT);
            if (lower.endsWith(".yml") || lower.endsWith(".yaml")) {
                return EnumSet.of(YAML);
            }
            if (lower.endsWith(".properties") || lower.endsWith(".xml")) {
                return EnumSet.of(read(false, fileName));
            }
            return EnumSet.of(YAML, PROPERTIES);
        }
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
        // Kept before Spring reads a file, so a failure leaves what it looked for.
        LookedUp lookedUp = new LookedUp();
        environment.getPropertySources().addLast(lookedUp);
        application.setResourceLoader(lookedUp.loader());
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
     * The files Spring looked a configuration file up at while it prepared
     * an environment, whether one was there or not, as its own resolver
     * named them from a location's spelling: with the extension a location
     * hints, the variant of each profile it activated, and relative to the
     * working directory where the location is; each with the format of the
     * loader that read it, which the location names, none where Spring read
     * nothing there. It holds no property; it keeps them with the
     * environment for {@link #files} and the rest.
     */
    private static final class LookedUp extends EnumerablePropertySource<Map<Path, Set<Format>>> {
        LookedUp() {
            super(LOOKED_UP, new LinkedHashMap<>());
        }

        // Enumerable and empty, so a binder skips it for every name.
        @Override
        public String[] getPropertyNames() {
            return new String[0];
        }

        @Override
        public Object getProperty(String name) {
            return null;
        }

        ResourceLoader loader() {
            return new DefaultResourceLoader() {
                @Override
                public Resource getResource(String location) {
                    Resource resource = super.getResource(location);
                    // A directory is one Spring lists for a wildcard, or
                    // checks is there when it found no file in it.
                    Path file = location.endsWith("/") ? null : path(resource);
                    if (file == null) {
                        return resource;
                    }
                    Set<Format> formats = getSource().computeIfAbsent(file,
                            looked -> EnumSet.noneOf(Format.class));
                    if (!(resource instanceof FileUrlResource url)) {
                        return resource;
                    }
                    // The loader that reads it is the one opening it.
                    return new FileUrlResource(url.getURL()) {
                        @Override
                        public InputStream getInputStream() throws IOException {
                            Format format = reader(file);
                            if (format != null) {
                                formats.add(format);
                            }
                            return super.getInputStream();
                        }
                    };
                }
            };
        }
    }

    /** The format of the property source loader on the stack, or null for none. */
    private static Format reader(Path file) {
        String name = String.valueOf(file.getFileName());
        return StackWalker.getInstance(StackWalker.Option.RETAIN_CLASS_REFERENCE).walk(
                frames -> frames.map(StackWalker.StackFrame::getDeclaringClass)
                        .filter(PropertySourceLoader.class::isAssignableFrom)
                        .findFirst()
                        .map(loader -> Format.read(loader, name))
                        .orElse(null));
    }

    /**
     * The files Spring looked up for this environment, in the working
     * directory, each with the formats it read it in.
     */
    private static Map<Path, Set<Format>> lookedUp(ConfigurableEnvironment environment,
            Path workingDirectory) {
        Map<Path, Set<Format>> files = new LinkedHashMap<>();
        if (environment.getPropertySources().get(LOOKED_UP) instanceof LookedUp lookedUp) {
            lookedUp.getSource().forEach((file, formats) -> files.computeIfAbsent(
                    workingDirectory.resolve(file).normalize(),
                    looked -> EnumSet.noneOf(Format.class)).addAll(formats));
        }
        return files;
    }

    /** The file a resource names, as relative as its location, or null for none. */
    private static Path path(Resource resource) {
        if (resource instanceof ClassPathResource || !resource.isFile()) {
            return null;
        }
        try {
            return resource.getFile().toPath();
        } catch (IOException | RuntimeException error) {
            // Nor can Spring read a file there.
            return null;
        }
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
        return files(environment, workingDirectory, true);
    }

    /**
     * The files among {@link #files} that Spring reads as configuration
     * files: all but a config tree's value files, though a path can be both,
     * as application.yml is under a config tree imported over config/. Each
     * has the formats Spring reads it in, by the loader that read it, which
     * its location names; by its extension where no loader was seen to.
     */
    static Map<Path, Set<Format>> configurationFiles(ConfigurableEnvironment environment) {
        return configurationFiles(environment, Path.of(""));
    }

    /** As above, with the working directory the default locations are in. */
    static Map<Path, Set<Format>> configurationFiles(ConfigurableEnvironment environment,
            Path workingDirectory) {
        Map<Path, Set<Format>> read = new LinkedHashMap<>();
        locationFiles(environment, workingDirectory, profiles(environment), new LinkedHashSet<>())
                .forEach((file, found) -> read.computeIfAbsent(file.toAbsolutePath().normalize(),
                        each -> EnumSet.noneOf(Format.class)).addAll(found.formats()));
        Map<Path, Set<Format>> files = new LinkedHashMap<>();
        for (Path file : files(environment, workingDirectory, false)) {
            Set<Format> formats = read.getOrDefault(file, Set.of());
            files.put(file, formats.isEmpty()
                    ? Format.named(String.valueOf(file.getFileName())) : formats);
        }
        return files;
    }

    private static List<Path> files(ConfigurableEnvironment environment, Path workingDirectory,
            boolean values) {
        Set<Path> files = sources(environment, values);
        for (Path file : locationFiles(environment, workingDirectory, profiles(environment),
                new LinkedHashSet<>()).keySet()) {
            if (Files.isRegularFile(file)) {
                files.add(file.toAbsolutePath().normalize());
            }
        }
        return new ArrayList<>(files);
    }

    /** The files the property sources came from, each value file among them or not. */
    private static Set<Path> sources(ConfigurableEnvironment environment, boolean values) {
        Set<Path> files = new LinkedHashSet<>();
        for (PropertySource<?> source : environment.getPropertySources()) {
            if (!(source instanceof EnumerablePropertySource<?> enumerable)
                    || !values && source instanceof ConfigTreePropertySource) {
                continue;
            }
            for (String name : enumerable.getPropertyNames()) {
                Path file = file(resource(OriginLookup.getOrigin(source, name)));
                if (file != null) {
                    files.add(file);
                }
            }
        }
        return files;
    }

    /**
     * Those of {@link #files} this can tell without reading a location, as
     * where one cannot be read: the files the property sources came from,
     * each value file of a config tree among them, and those a loader was
     * seen to read.
     */
    static List<Path> sourceFiles(ConfigurableEnvironment environment) {
        Set<Path> files = sources(environment, true);
        files.addAll(read(environment).keySet());
        return new ArrayList<>(files);
    }

    /**
     * As {@link #configurationFiles}, of {@link #sourceFiles}; where no loader
     * was seen to read a file, in each format it may be read in, as a
     * wildcard's hint may name either.
     */
    static Map<Path, Set<Format>> sourceConfigurations(ConfigurableEnvironment environment) {
        Map<Path, Set<Format>> read = read(environment);
        Set<Path> configurations = sources(environment, false);
        configurations.addAll(read.keySet());
        Map<Path, Set<Format>> files = new LinkedHashMap<>();
        for (Path file : configurations) {
            Set<Format> formats = EnumSet.of(Format.YAML, Format.PROPERTIES);
            formats.addAll(Format.named(String.valueOf(file.getFileName())));
            files.put(file, read.getOrDefault(file, formats));
        }
        return files;
    }

    /** The files a loader was seen to read, absolute, with its formats. */
    private static Map<Path, Set<Format>> read(ConfigurableEnvironment environment) {
        Map<Path, Set<Format>> read = new LinkedHashMap<>();
        lookedUp(environment, Path.of("")).forEach((file, formats) -> {
            if (!formats.isEmpty()) {
                read.put(file.toAbsolutePath().normalize(), formats);
            }
        });
        return read;
    }

    /**
     * SnakeYAML as Spring's YAML loader sets it up: its safe constructor, no
     * timestamps, no duplicate keys and no limit on code points. Where
     * bounded, as for building what Spring did not, it keeps the limits on
     * aliases and recursive keys that Spring lifts; otherwise it lifts the
     * one on aliases too, for composing nodes, which share an alias rather
     * than expand it.
     */
    static Yaml yaml(boolean bounded) {
        LoaderOptions options = new LoaderOptions();
        options.setAllowDuplicateKeys(false);
        options.setCodePointLimit(Integer.MAX_VALUE);
        if (!bounded) {
            options.setMaxAliasesForCollections(Integer.MAX_VALUE);
        }
        DumperOptions dumper = new DumperOptions();
        return new Yaml(new SafeConstructor(options), new Representer(dumper), dumper, options,
                new Resolver() {
                    @Override
                    public void addImplicitResolver(Tag tag, Pattern regexp, String first,
                            int limit) {
                        if (tag != Tag.TIMESTAMP) {
                            super.addImplicitResolver(tag, regexp, first, limit);
                        }
                    }
                });
    }

    private static List<String> profiles(ConfigurableEnvironment environment) {
        String[] active = environment.getActiveProfiles();
        return List.of(active.length > 0 ? active : environment.getDefaultProfiles());
    }

    /**
     * A directory the server looks in for its configuration files that this
     * process cannot: Spring skips an optional file it cannot see, so it
     * would read none there, though the service account may. Listed when
     * Spring lists it rather than looks a name up in it, as it lists config/
     * for the wildcard location under it.
     */
    record Hidden(Path directory, boolean listed) {
    }

    /** The directories of {@link #files} this process cannot look in. */
    static List<Hidden> hidden(ConfigurableEnvironment environment) {
        return hidden(environment, Path.of(""));
    }

    /** As above, with the working directory the default locations are in. */
    static List<Hidden> hidden(ConfigurableEnvironment environment, Path workingDirectory) {
        Set<Path> unlisted = new LinkedHashSet<>();
        List<Path> paths = new ArrayList<>(locationFiles(environment, workingDirectory,
                profiles(environment), unlisted).keySet());
        // A config tree Spring cannot see is skipped as an optional file is.
        for (Location named : named(environment, workingDirectory)) {
            if (named.tree()) {
                paths.addAll(expand(named.path(), unlisted));
            }
        }
        // Each directory, with whether only listing it is denied.
        Map<Path, Boolean> hidden = new LinkedHashMap<>();
        for (Path path : paths) {
            Path barrier = barrier(path);
            if (barrier != null) {
                hidden.put(barrier, false);
            }
        }
        for (Path directory : unlisted) {
            Path barrier = barrier(directory);
            if (barrier != null) {
                hidden.put(barrier, false);
            } else {
                hidden.putIfAbsent(realPath(directory), true);
            }
        }
        List<Hidden> directories = new ArrayList<>();
        hidden.forEach((directory, listed) -> directories.add(new Hidden(directory, listed)));
        return directories;
    }

    // A directory it can reach, named as barrier names one, after its links.
    private static Path realPath(Path directory) {
        try {
            return directory.toRealPath();
        } catch (IOException error) {
            return directory.toAbsolutePath().normalize();
        }
    }

    /**
     * The directory this process cannot enter on the way to a path, or null
     * where it can look the path up, whether or not anything is there. It
     * looks each name up as the kernel does, in the directory a symbolic link
     * on the way leads to, as ServiceAccount does for the service account.
     */
    private static Path barrier(Path path) {
        Path absolute = path.toAbsolutePath();
        Path current = Objects.requireNonNull(absolute.getRoot(), "an absolute path has a root");
        Deque<Path> names = new ArrayDeque<>();
        absolute.forEach(names::addLast);
        int links = 0;
        while (!names.isEmpty()) {
            Path name = names.removeFirst();
            if (name.toString().equals(".")) {
                continue;
            }
            if (name.toString().equals("..")) {
                // The current directory is already resolved, so this is its real parent.
                current = current.getParent() == null ? current : current.getParent();
                continue;
            }
            Path next = current.resolve(name);
            BasicFileAttributes attributes;
            try {
                attributes = Files.readAttributes(next, BasicFileAttributes.class,
                        LinkOption.NOFOLLOW_LINKS);
            } catch (AccessDeniedException denied) {
                return current;
            } catch (IOException absent) {
                // Not there, or no directory on the way: Spring sees none either.
                return null;
            }
            if (!attributes.isSymbolicLink()) {
                current = next;
                continue;
            }
            Path target;
            try {
                target = ++links > ServiceAccount.MAX_SYMBOLIC_LINKS ? null
                        : Files.readSymbolicLink(next);
            } catch (IOException unreadable) {
                target = null;
            }
            if (target == null) {
                // A loop, which Spring cannot follow either.
                return null;
            }
            if (target.isAbsolute()) {
                current = Objects.requireNonNull(target.getRoot(), "an absolute path has a root");
            }
            List<Path> targetNames = new ArrayList<>();
            target.forEach(targetNames::add);
            for (int index = targetNames.size() - 1; index >= 0; index--) {
                names.addFirst(targetNames.get(index));
            }
        }
        return null;
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

    /**
     * A location Spring reads without looking a file up: a config tree's
     * directory, or a wildcard, whose last name is *, which Spring lists,
     * with the name of the file it looks for in each directory of it, or
     * null where it looks for each configuration file's.
     */
    private record Location(Path path, boolean tree, String file) {
    }

    /**
     * The config trees and wildcards named at the top level, by the
     * arguments or the process environment, and those imported, at the top
     * level or by a file Spring read. Spring looks up the files of every
     * other location, which prepare records.
     */
    private static List<Location> named(ConfigurableEnvironment environment,
            Path workingDirectory) {
        List<Location> named = new ArrayList<>();
        Binder binder = topLevel(environment);
        for (String property : List.of("spring.config.import",
                "spring.config.additional-location", "spring.config.location")) {
            for (String value : binder.bind(property, Bindable.listOf(String.class))
                    .orElse(List.of())) {
                locations(value, workingDirectory, null, named);
            }
        }
        // Spring honours an import a file declares, and no other location a
        // file sets; it reads a bare relative one beside that file's
        // location: the file's directory where Spring read the file through a
        // lookup, and the wildcard where it read it through one, as config/*/
        // for config/*/application.yml, which makes the import a wildcard too.
        // Another location may look a file up that a wildcard read first.
        Set<Path> looked = new HashSet<>();
        lookedUp(environment, Path.of("")).forEach((file, formats) -> {
            if (!formats.isEmpty()) {
                looked.add(file.toAbsolutePath().normalize());
            }
        });
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
                Path directory = declaring == null ? null : declaring.getParent();
                if (directory != null) {
                    String base = looked.contains(declaring) || directory.getParent() == null
                            ? directory.toUri().toString()
                            : directory.getParent().toUri() + "*/";
                    // Spring resolves a placeholder in it as in any value.
                    for (String value : environment.resolvePlaceholders(
                            String.valueOf(entry.getValue())).split(",")) {
                        locations(value, workingDirectory, base, named);
                    }
                }
            }
        }
        return named;
    }

    /**
     * Adds the config trees and wildcards of one location value, which
     * Spring splits at semicolons, read with Spring's own rules: a
     * configtree: location, in the working directory when relative; and one
     * whose last directory is named *, opened as Spring opens a location,
     * after base, the importing file's location, when Spring reads it there.
     */
    private static void locations(String value, Path workingDirectory, String base,
            List<Location> named) {
        for (String each : value.split(";")) {
            ConfigDataLocation location = ConfigDataLocation.of(each.strip());
            if (location == null) {
                continue;
            }
            if (location.hasPrefix("configtree:")) {
                named.add(new Location(workingDirectory.resolve(
                        location.getNonPrefixedValue("configtree:")), true, null));
                continue;
            }
            // Spring takes a wildcard as the last directory, of a directory
            // location or of a file's.
            String resource = location.getNonPrefixedValue("resource:");
            if (base != null && !resource.startsWith("/") && !FIXED.matcher(resource).lookingAt()) {
                resource = (base.endsWith("/") ? base : base + "/") + resource;
            }
            int slash = resource.lastIndexOf('/');
            if (!resource.substring(0, slash + 1).endsWith("*/")) {
                continue;
            }
            String file = resource.substring(slash + 1);
            String parent = resource.substring(0, slash + 1 - "*/".length());
            Path directory = path(open(parent));
            if (directory != null) {
                named.add(new Location(workingDirectory.resolve(directory).resolve("*"), false,
                        file.isEmpty() ? null : file));
            }
        }
    }

    // As Spring's LocationResourceLoader opens a location.
    private static Resource open(String location) {
        String cleaned = StringUtils.cleanPath(location);
        return new DefaultResourceLoader().getResource(ResourceUtils.isUrl(cleaned) ? cleaned
                : ResourceUtils.FILE_URL_PREFIX + cleaned);
    }

    /**
     * A binder over the sources Spring reads before any file, as it reads
     * the locations and spring.config.name: the arguments, the process
     * environment and the other sources no configuration file adds.
     */
    private static Binder topLevel(ConfigurableEnvironment environment) {
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
                new PropertySourcesPlaceholdersResolver(sources));
    }

    private static List<String> topLevel(ConfigurableEnvironment environment, String property) {
        return topLevel(environment).bind(property, Bindable.listOf(String.class))
                .orElse(List.of());
    }

    /**
     * The files Spring looks for: those prepare saw it look up, at a
     * location of any spelling and for each profile it activated; then, as
     * Spring lists a wildcard's directory itself, those in each directory a
     * wildcard names, the default config/* among them unless
     * spring.config.location is set: each name and extension, then its
     * variants for these profiles, or for any profile when profiles is null,
     * each with its profile. Adds to unlisted each directory a wildcard
     * names whose directories this process may not list.
     */
    private static Map<Path, Found> locationFiles(ConfigurableEnvironment environment,
            Path workingDirectory, List<String> profiles, Set<Path> unlisted) {
        Map<Path, Found> located = new LinkedHashMap<>();
        lookedUp(environment, workingDirectory).forEach((file, formats) ->
                located.put(file, new Found(null, formats)));
        Set<Path> read = new HashSet<>();
        located.forEach((file, found) -> {
            if (!found.formats().isEmpty()) {
                read.add(file.toAbsolutePath().normalize());
            }
        });
        List<Location> wildcards = new ArrayList<>();
        for (Location named : named(environment, workingDirectory)) {
            if (!named.tree()) {
                wildcards.add(named);
            }
        }
        Binder binder = topLevel(environment);
        // An empty spring.config.location replaces the defaults too.
        if (!binder.bind("spring.config.location", Bindable.listOf(String.class)).isBound()) {
            wildcards.add(new Location(workingDirectory.resolve(DEFAULT_WILDCARD), false, null));
        }
        String[] names = binder.bind("spring.config.name", String[].class)
                .orElse(new String[] {"application"});
        List<Named> files = new ArrayList<>();
        for (Location wildcard : wildcards) {
            for (Path directory : expand(wildcard.path(), unlisted)) {
                if (wildcard.file() == null) {
                    for (String name : names) {
                        for (String extension : EXTENSIONS) {
                            files.add(new Named(directory, name, "." + extension,
                                    extension.startsWith("y")));
                        }
                    }
                    continue;
                }
                // As Spring names it: by the first loader whose extension it
                // ends in, in any case, with that loader's extension, or with
                // none where a location hints it; with none, Spring reads
                // nothing. A name that is only an extension leaves Spring a
                // location that is no wildcard, which it refuses.
                Matcher hint = HINT.matcher(wildcard.file());
                String name = hint.matches() ? hint.group(1) + hint.group(2) : wildcard.file();
                for (String extension : EXTENSIONS) {
                    if (name.length() > extension.length()
                            && name.toLowerCase(Locale.ROOT).endsWith(extension)) {
                        files.add(new Named(directory,
                                name.substring(0, name.length() - extension.length() - 1),
                                hint.matches() ? "" : "." + extension, extension.startsWith("y")));
                        break;
                    }
                }
            }
        }
        for (Named file : files) {
            Path path = file.directory().resolve(file.root() + file.extension());
            if (!read.contains(path.toAbsolutePath().normalize())) {
                located.merge(path, new Found(null, file.formats(path)), Found::and);
            }
        }
        for (Named file : files) {
            variants(file, profiles).forEach((path, profile) -> {
                if (!read.contains(path.toAbsolutePath().normalize())) {
                    located.merge(path, new Found(profile, file.formats(path)), Found::and);
                }
            });
        }
        return located;
    }

    /**
     * A file Spring looks for: the profile it is the variant of, or null for
     * none, and the formats it reads it in, none where Spring read nothing.
     * What a loader was seen to read it in stands; otherwise each wildcard
     * that names the file adds the format Spring would read it in.
     */
    private record Found(String profile, Set<Format> formats) {
        Found and(Found other) {
            Set<Format> both = EnumSet.noneOf(Format.class);
            both.addAll(formats);
            both.addAll(other.formats());
            return new Found(profile, both);
        }
    }

    /**
     * The directory, or for a last name of *, each directory in its parent,
     * which goes to unlisted when this process may not list it.
     */
    private static List<Path> expand(Path location, Set<Path> unlisted) {
        Path name = location.getFileName();
        if (name == null || !name.toString().equals("*")) {
            return List.of(location);
        }
        List<Path> directories = new ArrayList<>();
        Path parent = location.getParent() == null ? Path.of("") : location.getParent();
        try (DirectoryStream<Path> nested =
                Files.newDirectoryStream(parent, ServerEnvironment::listedDirectory)) {
            nested.forEach(directories::add);
        } catch (AccessDeniedException denied) {
            unlisted.add(parent);
        } catch (IOException error) {
            // No such directory: Spring finds none either.
        }
        directories.sort(null);
        return directories;
    }

    /**
     * Whether Spring reads an entry of a wildcard's directory as a directory
     * to look in: one not named from "..", as Spring skips those. One this
     * process cannot look at, as in a directory it may list but not enter,
     * counts, since the service account may; hidden() then names the
     * directory.
     */
    private static boolean listedDirectory(Path entry) {
        if (entry.getFileName().toString().startsWith("..")) {
            return false;
        }
        try {
            return Files.readAttributes(entry, BasicFileAttributes.class).isDirectory();
        } catch (AccessDeniedException denied) {
            return true;
        } catch (IOException gone) {
            return false;
        }
    }

    /**
     * A file as Spring names it: its directory, its name without the
     * extension, which a variant's profile follows, the extension, empty
     * where a location hints it, and whether the YAML loader reads it.
     */
    private record Named(Path directory, String root, String extension, boolean yaml) {
        Set<Format> formats(Path file) {
            return EnumSet.of(Format.read(yaml, String.valueOf(file.getFileName())));
        }
    }

    /**
     * The profile variants of a file, as application-edge.yml is of
     * application.yml and app.conf-edge of app.conf[.properties], each with
     * its profile.
     */
    private static Map<Path, String> variants(Named file, List<String> profiles) {
        Path directory = file.directory();
        String stem = file.root() + "-";
        String extension = file.extension();
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
        Map<Path, Found> located;
        try {
            located = locationFiles(environment, workingDirectory, null, new LinkedHashSet<>());
        } catch (RuntimeException unlisted) {
            // Spring's own error stands, and the files it looked up; a
            // second throw would end the check.
            located = new LinkedHashMap<>();
            for (Map.Entry<Path, Set<Format>> looked
                    : lookedUp(environment, workingDirectory).entrySet()) {
                located.put(looked.getKey(), new Found(null, looked.getValue()));
            }
        }
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
            // The files with the same problem at the same place, each once:
            // those Spring reads for certain, one it looked up or a variant of
            // a profile the arguments or the environment activate, else every
            // one, since a file may activate a profile too.
            Set<String> active = new LinkedHashSet<>(topLevel(environment, "spring.profiles.active"));
            active.addAll(topLevel(environment, "spring.profiles.include"));
            Set<String> matches = new LinkedHashSet<>();
            Set<String> read = new LinkedHashSet<>();
            for (Map.Entry<Path, Found> candidate : located.entrySet()) {
                Path file = candidate.getKey();
                if (Files.isRegularFile(file)
                        && sameProblem(yamlError(file, candidate.getValue().formats()), marked)) {
                    String name = file.toAbsolutePath().normalize().toString();
                    matches.add(name);
                    String profile = candidate.getValue().profile();
                    if (profile == null || active.contains(profile)) {
                        read.add(name);
                    }
                }
            }
            if (matches.isEmpty()) {
                // In a file Spring found without a lookup, as an import beside
                // a file a wildcard found.
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

    /**
     * The YAML error a file holds, or null for a file that parses or that
     * Spring reads as no YAML: by the loader seen to read it, else by its name.
     */
    private static MarkedYAMLException yamlError(Path file, Set<Format> formats) {
        String name = file.getFileName().toString();
        if (formats.isEmpty() ? !name.endsWith(".yml") && !name.endsWith(".yaml")
                : !formats.contains(Format.YAML)) {
            return null;
        }
        // Read within bounds: a file Spring did not get to may hold an alias
        // that Spring's own loader would follow without end.
        try (Reader reader = new UnicodeReader(Files.newInputStream(file))) {
            // Each document is built as it is reached.
            Iterator<Object> documents = yaml(true).loadAll(reader).iterator();
            while (documents.hasNext()) {
                documents.next();
            }
            return null;
        } catch (RuntimeException error) {
            return cause(error, MarkedYAMLException.class);
        } catch (IOException | StackOverflowError error) {
            // A key that holds a deep chain of aliases overflows as it is hashed.
            return null;
        }
    }
}
