package com.alibaba.qwen.code.managedagent.preflight;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Reads a Broker URL the way the Hosted Harness does when it starts: Node's
 * WHATWG URL parser, then the origin and loopback rules of
 * managed-runtime-broker-url.ts. Only the http and https part of the parser
 * is here, and only for the characters the credentials file admits, which
 * leave out percent-encoding, user information, a query, a fragment, a
 * backslash, whitespace and non-ASCII text. Each step follows the URL
 * Standard (https://url.spec.whatwg.org/), with two exceptions that never
 * turn a refusal into an acceptance: a scheme other than http or https is
 * refused before the rest is parsed, and a host with an xn-- label is not run
 * through IDNA. Either may name a different reason for a URL the Harness
 * finds invalid. managed-runtime-broker-url.fixtures.json holds both readers
 * to the same verdicts.
 */
final class HarnessBrokerUrl {
    enum Verdict {
        ACCEPTED,
        INVALID,
        NOT_ORIGIN,
        PLAIN_OUTSIDE_LOOPBACK,
        // Text outside the file's characters, or an https host with a label
        // the parser would run through IDNA, which is not here.
        UNCLASSIFIED
    }

    /**
     * The verdict and, for an accepted URL, its scheme, the host as Node
     * serializes it and the port the Harness dials.
     */
    record Result(Verdict verdict, boolean https, String hostname, int port) {
        private Result(Verdict verdict) {
            this(verdict, false, null, -1);
        }
    }

    private static final Pattern READABLE =
            Pattern.compile("[A-Za-z0-9\\[\\]._:/+=-]*");
    private static final Pattern SCHEME =
            Pattern.compile("([A-Za-z][A-Za-z0-9+.-]*):(.*)", Pattern.DOTALL);
    private static final Result INVALID = new Result(Verdict.INVALID);

    private HarnessBrokerUrl() {
    }

    static Result read(String raw) {
        if (!READABLE.matcher(raw).matches()) {
            return new Result(Verdict.UNCLASSIFIED);
        }
        var scheme = SCHEME.matcher(raw);
        if (!scheme.matches()) {
            // No scheme and no base URL to resolve against.
            return INVALID;
        }
        String protocol = scheme.group(1).toLowerCase(Locale.ROOT);
        if (!protocol.equals("http") && !protocol.equals("https")) {
            return new Result(Verdict.NOT_ORIGIN);
        }
        // A special scheme skips any run of slashes before its authority.
        String rest = scheme.group(2).replaceFirst("^/+", "");
        int slash = rest.indexOf('/');
        String authority = slash < 0 ? rest : rest.substring(0, slash);
        String path = slash < 0 ? "" : rest.substring(slash);
        // The host ends at the first colon outside brackets.
        int colon = -1;
        boolean bracketed = false;
        for (int i = 0; i < authority.length() && colon < 0; i++) {
            char c = authority.charAt(i);
            if (c == ':' && !bracketed) {
                colon = i;
            } else if (c == '[') {
                bracketed = true;
            } else if (c == ']') {
                bracketed = false;
            }
        }
        String hostText = colon < 0 ? authority : authority.substring(0, colon);
        if (hostText.isEmpty()) {
            return INVALID;
        }
        int port = protocol.equals("https") ? 443 : 80;
        if (colon >= 0) {
            String digits = authority.substring(colon + 1);
            if (!digits.chars().allMatch(c -> c >= '0' && c <= '9')) {
                return INVALID;
            }
            if (!digits.isEmpty()) {
                BigInteger value = new BigInteger(digits);
                if (value.compareTo(BigInteger.valueOf(65535)) > 0) {
                    return INVALID;
                }
                port = value.intValue();
            }
        }
        String hostname;
        boolean loopback;
        if (hostText.startsWith("[")) {
            if (!hostText.endsWith("]")) {
                return INVALID;
            }
            int[] pieces = ipv6(hostText.substring(1, hostText.length() - 1));
            if (pieces == null) {
                return INVALID;
            }
            hostname = "[" + serializeIpv6(pieces) + "]";
            loopback = hostname.equals("[::1]");
        } else {
            String domain = hostText.toLowerCase(Locale.ROOT);
            if (domain.indexOf('[') >= 0 || domain.indexOf(']') >= 0) {
                return INVALID;
            }
            // Without an xn-- label, IDNA only lowercases an ASCII domain.
            // With one, it keeps the label or refuses the URL, so the host is
            // never loopback or an IPv4 address, and only whether the Harness
            // accepts an https URL is left to IDNA.
            for (String label : domain.split("\\.", -1)) {
                if (label.startsWith("xn--")) {
                    if (endsInANumber(domain)) {
                        return INVALID;
                    }
                    if (!isRootPath(path)) {
                        return new Result(Verdict.NOT_ORIGIN);
                    }
                    return new Result(protocol.equals("http")
                            ? Verdict.PLAIN_OUTSIDE_LOOPBACK
                            : Verdict.UNCLASSIFIED);
                }
            }
            if (endsInANumber(domain)) {
                Long address = ipv4(domain);
                if (address == null) {
                    return INVALID;
                }
                hostname = (address >> 24) + "." + (address >> 16 & 255) + "."
                        + (address >> 8 & 255) + "." + (address & 255);
                loopback = address >> 24 == 127;
            } else {
                hostname = domain;
                loopback = domain.equals("localhost");
            }
        }
        if (!isRootPath(path)) {
            return new Result(Verdict.NOT_ORIGIN);
        }
        if (protocol.equals("http") && !loopback) {
            return new Result(Verdict.PLAIN_OUTSIDE_LOOPBACK);
        }
        return new Result(Verdict.ACCEPTED, protocol.equals("https"), hostname,
                port);
    }

    // Path state for a special scheme: a "." segment drops out, a ".."
    // segment removes the one before it, and either leaves an empty
    // segment when it ends the path.
    private static boolean isRootPath(String path) {
        List<String> segments = new ArrayList<>();
        String[] parts = (path.isEmpty() ? "" : path.substring(1))
                .split("/", -1);
        for (int i = 0; i < parts.length; i++) {
            boolean last = i == parts.length - 1;
            if (parts[i].equals("..")) {
                if (!segments.isEmpty()) {
                    segments.remove(segments.size() - 1);
                }
                if (last) {
                    segments.add("");
                }
            } else if (parts[i].equals(".")) {
                if (last) {
                    segments.add("");
                }
            } else {
                segments.add(parts[i]);
            }
        }
        return segments.size() == 1 && segments.get(0).isEmpty();
    }

    private static boolean endsInANumber(String domain) {
        List<String> parts = new ArrayList<>(List.of(domain.split("\\.", -1)));
        if (parts.get(parts.size() - 1).isEmpty()) {
            if (parts.size() == 1) {
                return false;
            }
            parts.remove(parts.size() - 1);
        }
        String last = parts.get(parts.size() - 1);
        return (!last.isEmpty() && last.chars().allMatch(c -> c >= '0' && c <= '9'))
                || ipv4Number(last) != null;
    }

    // The IPv4 parser, which takes inet_aton forms: one to four parts, each
    // decimal, octal after a leading 0, or hexadecimal after 0x.
    private static Long ipv4(String domain) {
        List<String> parts = new ArrayList<>(List.of(domain.split("\\.", -1)));
        if (parts.get(parts.size() - 1).isEmpty() && parts.size() > 1) {
            parts.remove(parts.size() - 1);
        }
        if (parts.size() > 4) {
            return null;
        }
        List<BigInteger> numbers = new ArrayList<>();
        for (String part : parts) {
            BigInteger number = ipv4Number(part);
            if (number == null) {
                return null;
            }
            numbers.add(number);
        }
        BigInteger octet = BigInteger.valueOf(255);
        for (int i = 0; i < numbers.size() - 1; i++) {
            if (numbers.get(i).compareTo(octet) > 0) {
                return null;
            }
        }
        BigInteger last = numbers.get(numbers.size() - 1);
        if (last.compareTo(BigInteger.valueOf(256).pow(5 - numbers.size())) >= 0) {
            return null;
        }
        long address = last.longValue();
        for (int i = 0; i < numbers.size() - 1; i++) {
            address += numbers.get(i).longValue() << (8 * (3 - i));
        }
        return address;
    }

    private static BigInteger ipv4Number(String part) {
        if (part.isEmpty()) {
            return null;
        }
        int radix = 10;
        String digits = part;
        if (part.length() >= 2 && (part.startsWith("0x") || part.startsWith("0X"))) {
            radix = 16;
            digits = part.substring(2);
        } else if (part.length() >= 2 && part.charAt(0) == '0') {
            radix = 8;
            digits = part.substring(1);
        }
        if (digits.isEmpty()) {
            return BigInteger.ZERO;
        }
        for (int i = 0; i < digits.length(); i++) {
            if (Character.digit(digits.charAt(i), radix) < 0
                    || digits.charAt(i) > 'f') {
                return null;
            }
        }
        return new BigInteger(digits, radix);
    }

    // The IPv6 parser: up to eight groups of one to four hex digits, one
    // "::", and an optional dotted IPv4 tail without leading zeros.
    private static int[] ipv6(String input) {
        int[] address = new int[8];
        int pieceIndex = 0;
        Integer compress = null;
        int pointer = 0;
        int length = input.length();
        if (pointer < length && input.charAt(pointer) == ':') {
            if (pointer + 1 >= length || input.charAt(pointer + 1) != ':') {
                return null;
            }
            pointer += 2;
            pieceIndex++;
            compress = pieceIndex;
        }
        while (pointer < length) {
            if (pieceIndex == 8) {
                return null;
            }
            if (input.charAt(pointer) == ':') {
                if (compress != null) {
                    return null;
                }
                pointer++;
                pieceIndex++;
                compress = pieceIndex;
                continue;
            }
            int value = 0;
            int digits = 0;
            while (digits < 4 && pointer < length
                    && hexDigit(input.charAt(pointer)) >= 0) {
                value = value * 16 + hexDigit(input.charAt(pointer));
                pointer++;
                digits++;
            }
            if (pointer < length && input.charAt(pointer) == '.') {
                if (digits == 0) {
                    return null;
                }
                pointer -= digits;
                if (pieceIndex > 6) {
                    return null;
                }
                int numbersSeen = 0;
                while (pointer < length) {
                    Integer ipv4Piece = null;
                    if (numbersSeen > 0) {
                        if (input.charAt(pointer) == '.' && numbersSeen < 4) {
                            pointer++;
                        } else {
                            return null;
                        }
                    }
                    if (pointer >= length || !isDigit(input.charAt(pointer))) {
                        return null;
                    }
                    while (pointer < length && isDigit(input.charAt(pointer))) {
                        int number = input.charAt(pointer) - '0';
                        if (ipv4Piece == null) {
                            ipv4Piece = number;
                        } else if (ipv4Piece == 0) {
                            return null;
                        } else {
                            ipv4Piece = ipv4Piece * 10 + number;
                        }
                        if (ipv4Piece > 255) {
                            return null;
                        }
                        pointer++;
                    }
                    address[pieceIndex] = address[pieceIndex] * 0x100 + ipv4Piece;
                    numbersSeen++;
                    if (numbersSeen == 2 || numbersSeen == 4) {
                        pieceIndex++;
                    }
                }
                if (numbersSeen != 4) {
                    return null;
                }
                break;
            } else if (pointer < length && input.charAt(pointer) == ':') {
                pointer++;
                if (pointer >= length) {
                    return null;
                }
            } else if (pointer < length) {
                return null;
            }
            address[pieceIndex] = value;
            pieceIndex++;
        }
        if (compress != null) {
            int swaps = pieceIndex - compress;
            pieceIndex = 7;
            while (pieceIndex != 0 && swaps > 0) {
                int swapped = address[pieceIndex];
                address[pieceIndex] = address[compress + swaps - 1];
                address[compress + swaps - 1] = swapped;
                pieceIndex--;
                swaps--;
            }
        } else if (pieceIndex != 8) {
            return null;
        }
        return address;
    }

    // Lowercase hex groups with the first longest run of two or more zero
    // groups written as "::".
    private static String serializeIpv6(int[] address) {
        int start = -1;
        int longest = 1;
        for (int i = 0; i < 8; i++) {
            int run = 0;
            while (i + run < 8 && address[i + run] == 0) {
                run++;
            }
            if (run > longest) {
                start = i;
                longest = run;
            }
        }
        StringBuilder output = new StringBuilder();
        boolean ignore0 = false;
        for (int i = 0; i < 8; i++) {
            if (ignore0 && address[i] == 0) {
                continue;
            }
            ignore0 = false;
            if (i == start) {
                output.append(i == 0 ? "::" : ":");
                ignore0 = true;
                continue;
            }
            output.append(Integer.toHexString(address[i]));
            if (i != 7) {
                output.append(':');
            }
        }
        return output.toString();
    }

    private static int hexDigit(char c) {
        return c > 'f' ? -1 : Character.digit(c, 16);
    }

    private static boolean isDigit(char c) {
        return c >= '0' && c <= '9';
    }
}
