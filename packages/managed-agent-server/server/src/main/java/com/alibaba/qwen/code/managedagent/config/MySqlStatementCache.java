package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.druid.pool.DruidDataSource;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;

/**
 * Turns on Connector/J's per-connection cache of parsed SQL for a MySQL pool.
 * Without it the driver parses a statement's SQL again on every
 * {@code prepareStatement}, which was the largest single share of the control
 * plane's Java CPU under load.
 *
 * <p>Each setting is added only when neither the URL nor the pool's connection
 * properties name it, because Connector/J lets a connection property override
 * the URL. When either names {@code useServerPrepStmts}, or {@code useCursorFetch},
 * which turns server-side statements on, nothing is added: with server-side
 * statements the cache would keep statements open on the server, counted
 * against its global {@code max_prepared_stmt_count}.
 */
public final class MySqlStatementCache {
    /**
     * In a Hosted Shell run the control plane prepared 270 distinct statements,
     * 184 to 265 on each connection; apart from one metadata query of the
     * driver's own, the longest was 2,023 characters. Connector/J's own sizes
     * would hold 25 per connection and skip the 104 longer than 256 characters.
     */
    static final Map<String, String> DEFAULTS = defaults();

    private static final List<String> SERVER_STATEMENTS = List.of("useServerPrepStmts", "useCursorFetch");

    private MySqlStatementCache() {
    }

    /** Adds the settings this pool leaves unset; call it before the pool opens. */
    public static void fillDefaults(DruidDataSource source) {
        String url = source.getUrl();
        if (url == null || !(url.startsWith("jdbc:mysql:") || url.startsWith("jdbc:mysql+srv:"))) {
            return;
        }
        Properties properties = source.getConnectProperties();
        if (SERVER_STATEMENTS.stream().anyMatch(key -> named(url, properties, key))) {
            return;
        }
        DEFAULTS.forEach((key, value) -> {
            if (!named(url, properties, key)) {
                source.addConnectionProperty(key, value);
            }
        });
    }

    /**
     * Whether the URL or the properties name the key, ignoring case as
     * Connector/J does. Any mention in the URL counts, percent-encoded or not,
     * in its query or in a host's own properties, so a setting is never added
     * over one the URL holds. Druid keeps the spaces around a name in
     * {@code connection-properties}, so they are ignored here too.
     */
    private static boolean named(String url, Properties properties, String key) {
        String lower = key.toLowerCase(Locale.ROOT);
        return url.toLowerCase(Locale.ROOT).contains(lower)
                || decoded(url).toLowerCase(Locale.ROOT).contains(lower)
                || properties.stringPropertyNames().stream()
                        .anyMatch(name -> name.strip().toLowerCase(Locale.ROOT).equals(lower));
    }

    /**
     * The URL with its percent escapes decoded, up to a fragment, which
     * Connector/J neither decodes nor reads; as it is when an escape is
     * malformed, which Connector/J refuses anyway.
     */
    private static String decoded(String url) {
        int fragment = url.indexOf('#');
        String read = fragment < 0 ? url : url.substring(0, fragment);
        try {
            return URLDecoder.decode(read.replace("+", "%2B"), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException malformed) {
            return url;
        }
    }

    private static Map<String, String> defaults() {
        var defaults = new LinkedHashMap<String, String>();
        defaults.put("cachePrepStmts", "true");
        defaults.put("prepStmtCacheSize", "512");
        defaults.put("prepStmtCacheSqlLimit", "8192");
        return Collections.unmodifiableMap(defaults);
    }
}
