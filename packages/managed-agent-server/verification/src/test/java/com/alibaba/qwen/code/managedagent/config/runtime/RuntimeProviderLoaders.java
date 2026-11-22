package com.alibaba.qwen.code.managedagent.config.runtime;

import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;

import java.io.File;
import java.io.IOException;
import java.net.MalformedURLException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.regex.Pattern;

/**
 * Models provider absence at the loaders discovery actually consults: application classes are
 * defined by the isolated loader itself, and the factory service descriptors are hidden from it,
 * so it must serve as both the defining loader and the thread context loader.
 */
public final class RuntimeProviderLoaders {
    private static final String FACTORY_SERVICES =
            "META-INF/services/" + RuntimeProviderFactory.class.getName();

    private RuntimeProviderLoaders() {
    }

    public static URL[] testClasspath() throws MalformedURLException {
        var urls = new ArrayList<URL>();
        for (String entry : System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"))
                .split(Pattern.quote(File.pathSeparator))) {
            urls.add(Path.of(entry).toAbsolutePath().normalize().toUri().toURL());
        }
        return urls.toArray(URL[]::new);
    }

    public static URLClassLoader withoutFactoryServices() throws MalformedURLException {
        return new URLClassLoader(testClasspath(), ClassLoader.getPlatformClassLoader()) {
            @Override
            public Enumeration<URL> getResources(String name) throws IOException {
                return name.equals(FACTORY_SERVICES) ? Collections.emptyEnumeration() : super.getResources(name);
            }
        };
    }

    public static void withContextLoader(ClassLoader loader, CheckedAction action) throws Exception {
        Thread thread = Thread.currentThread();
        ClassLoader previous = thread.getContextClassLoader();
        thread.setContextClassLoader(loader);
        try {
            action.run();
        } finally {
            thread.setContextClassLoader(previous);
        }
    }

    public interface CheckedAction {
        void run() throws Exception;
    }
}
