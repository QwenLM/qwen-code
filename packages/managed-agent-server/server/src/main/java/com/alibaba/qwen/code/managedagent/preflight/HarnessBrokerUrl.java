package com.alibaba.qwen.code.managedagent.preflight;

import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Validates canonical {@code http(s)://host[:port][/]} Broker URLs using the
 * same canonical rules as {@code managed-runtime-broker-url.ts}. Non-canonical
 * WHATWG spellings ({@code inet_aton} shorthand/octal/hex IPv4, missing or
 * extra scheme slashes, dot-segment paths, empty ports) are rejected directly.
 */
final class HarnessBrokerUrl {
    enum Verdict {
        ACCEPTED,
        INVALID,
        NOT_ORIGIN,
        PLAIN_OUTSIDE_LOOPBACK,
        UNCLASSIFIED
    }

    record Result(Verdict verdict, boolean https, String hostname, int port) {
        private Result(Verdict verdict) {
            this(verdict, false, null, -1);
        }
    }

    private static final Pattern READABLE =
            Pattern.compile("[A-Za-z0-9\\[\\]._:/+=-]*");
    private static final Pattern SCHEME =
            Pattern.compile("^([A-Za-z][A-Za-z0-9+.-]*):(.*)$", Pattern.DOTALL);
    private static final Pattern CANONICAL =
            Pattern.compile("^(https?)://(\\[[^\\]/?#@\\s]+\\]|[^:/?#@\\[\\]\\s]+)(?::(\\d+))?(/.*)?$",
                    Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern DECIMAL_OCTET = Pattern.compile("^(?:0|[1-9]\\d{0,2})$");
    private static final Pattern NUMERIC_OR_HEX_LABEL = Pattern.compile("^(?:\\d+|0x[0-9a-f]*)$");
    private static final Result INVALID = new Result(Verdict.INVALID);

    private HarnessBrokerUrl() {
    }

    static Result read(String raw) {
        if (!READABLE.matcher(raw).matches()) {
            return new Result(Verdict.UNCLASSIFIED);
        }
        Matcher scheme = SCHEME.matcher(raw);
        if (!scheme.matches()) {
            return INVALID;
        }
        String protocol = scheme.group(1).toLowerCase(Locale.ROOT);
        if (!protocol.equals("http") && !protocol.equals("https")) {
            return new Result(Verdict.NOT_ORIGIN);
        }
        Matcher match = CANONICAL.matcher(raw);
        if (!match.matches()) {
            return INVALID;
        }
        String rawHost = match.group(2);
        String portDigits = match.group(3);
        String path = match.group(4) == null ? "" : match.group(4);
        int port = protocol.equals("https") ? 443 : 80;
        if (portDigits != null) {
            int parsedPort;
            try {
                parsedPort = Integer.parseInt(portDigits);
            } catch (NumberFormatException overflow) {
                return INVALID;
            }
            if (parsedPort < 1 || parsedPort > 65535) {
                return INVALID;
            }
            port = parsedPort;
        }
        boolean hasNonRootPath = !path.isEmpty() && !path.equals("/");
        if (rawHost.startsWith("[")) {
            String inner = rawHost.substring(1, rawHost.length() - 1).toLowerCase(Locale.ROOT);
            String serialized = canonicalizeIpv6(inner);
            if (serialized == null) {
                return INVALID;
            }
            if (hasNonRootPath) {
                return new Result(Verdict.NOT_ORIGIN);
            }
            String hostname = "[" + serialized + "]";
            boolean loopback = hostname.equals("[::1]");
            if (protocol.equals("http") && !loopback) {
                return new Result(Verdict.PLAIN_OUTSIDE_LOOPBACK);
            }
            return new Result(Verdict.ACCEPTED, protocol.equals("https"), hostname, port);
        }

        String domain = rawHost.toLowerCase(Locale.ROOT);
        if (domain.isEmpty() || domain.endsWith(".")) {
            return INVALID;
        }
        String[] labels = domain.split("\\.", -1);
        for (String label : labels) {
            if (label.isEmpty()) {
                return INVALID;
            }
        }
        String last = labels[labels.length - 1];
        boolean numericTail = NUMERIC_OR_HEX_LABEL.matcher(last).matches();
        for (String label : labels) {
            if (label.startsWith("xn--")) {
                if (numericTail) {
                    return INVALID;
                }
                if (hasNonRootPath) {
                    return new Result(Verdict.NOT_ORIGIN);
                }
                return new Result(protocol.equals("http")
                        ? Verdict.PLAIN_OUTSIDE_LOOPBACK
                        : Verdict.UNCLASSIFIED);
            }
        }
        boolean loopback;
        if (numericTail) {
            if (labels.length != 4) {
                return INVALID;
            }
            int[] octets = new int[4];
            for (int i = 0; i < 4; i++) {
                if (!DECIMAL_OCTET.matcher(labels[i]).matches()) {
                    return INVALID;
                }
                octets[i] = Integer.parseInt(labels[i]);
                if (octets[i] > 255) {
                    return INVALID;
                }
            }
            loopback = octets[0] == 127;
        } else {
            loopback = domain.equals("localhost");
        }
        if (hasNonRootPath) {
            return new Result(Verdict.NOT_ORIGIN);
        }
        if (protocol.equals("http") && !loopback) {
            return new Result(Verdict.PLAIN_OUTSIDE_LOOPBACK);
        }
        return new Result(Verdict.ACCEPTED, protocol.equals("https"), domain, port);
    }

    private static String canonicalizeIpv6(String inner) {
        if (!inner.contains(":") || !inner.matches("[0-9a-f:.]+")) {
            return null;
        }
        // Reject leading zeros in embedded IPv4 octets (e.g. ::127.0.0.01) as WHATWG does.
        int dot = inner.indexOf('.');
        if (dot >= 0) {
            int lastColon = inner.lastIndexOf(':', dot);
            if (lastColon < 0) {
                return null;
            }
            String[] v4 = inner.substring(lastColon + 1).split("\\.", -1);
            if (v4.length != 4) {
                return null;
            }
            for (String part : v4) {
                if (!DECIMAL_OCTET.matcher(part).matches() || Integer.parseInt(part) > 255) {
                    return null;
                }
            }
        }
        byte[] bytes;
        try {
            InetAddress parsed = InetAddress.getByName("[" + inner + "]");
            if (parsed instanceof Inet6Address v6) {
                bytes = v6.getAddress();
            } else {
                // Java collapses ::ffff:a.b.c.d to Inet4Address; reconstruct the 16-byte IPv4-mapped form.
                byte[] v4 = parsed.getAddress();
                bytes = new byte[16];
                bytes[10] = (byte) 0xff;
                bytes[11] = (byte) 0xff;
                System.arraycopy(v4, 0, bytes, 12, 4);
            }
        } catch (UnknownHostException invalid) {
            return null;
        }
        int[] groups = new int[8];
        for (int i = 0; i < 8; i++) {
            groups[i] = ((bytes[2 * i] & 0xff) << 8) | (bytes[2 * i + 1] & 0xff);
        }
        int bestStart = -1;
        int bestLen = 1;
        for (int i = 0; i < 8; i++) {
            int len = 0;
            while (i + len < 8 && groups[i + len] == 0) {
                len++;
            }
            if (len > bestLen) {
                bestStart = i;
                bestLen = len;
            }
        }
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < 8; i++) {
            if (i == bestStart) {
                out.append(i == 0 ? "::" : ":");
                i += bestLen - 1;
                continue;
            }
            out.append(Integer.toHexString(groups[i]));
            if (i < 7) {
                out.append(':');
            }
        }
        return out.toString();
    }
}
