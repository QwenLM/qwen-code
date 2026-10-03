package com.alibaba.qwen.code.managedagent.config;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Locale;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.web.ServerProperties;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcProperties;
import org.springframework.stereotype.Component;

/**
 * Resolves the broker authentication mode and refuses unsafe listen-address
 * combinations at startup. The public surface (/v1/agents/** and the
 * WebShell adapter) requires SIGNED mode on any non-loopback address; the
 * internal surface (/internal/**) requires a configured writer binding key
 * before it may leave the loopback interface.
 */
@Component
public class BrokerSecurity {
    public enum Mode {
        OPEN,
        SIGNED
    }

    private static final Logger LOG = LoggerFactory.getLogger(
            BrokerSecurity.class);
    private static final int MIN_SIGNING_KEY_BYTES = 32;
    private static final int DEFAULT_PUBLIC_PORT = 8080;
    private static final Pattern LOOPBACK_IPV4 = Pattern.compile(
            "^127(\\.(0|[1-9][0-9]{0,2})){3}$");
    private final Mode mode;
    private final byte[] signingKey;
    private final Duration allowedDrift;
    private final boolean allowInsecureBind;
    private final long maxSignedBodyBytes;

    public BrokerSecurity(ManagedAgentProperties properties,
            ServerProperties server, WebMvcProperties mvc) {
        ManagedAgentProperties.Auth auth = properties.getAuth();
        String configured = auth.getMode() == null
                ? "auto" : auth.getMode().trim().toLowerCase(Locale.ROOT);
        this.allowInsecureBind = auth.isAllowInsecureBind();
        java.util.List<String> skippedGuards = new java.util.ArrayList<>();
        InetAddress publicAddress = server.getAddress();
        boolean publicLoopback = publicAddress != null
                && publicAddress.isLoopbackAddress();
        String contextPath = server.getServlet().getContextPath();
        if (contextPath != null && !contextPath.isBlank()
                && !"/".equals(contextPath)) {
            // The auth and routing filters match path prefixes, which a
            // context path would silently bypass.
            throw new IllegalStateException(
                    "server.servlet.context-path is not supported by the"
                            + " Managed Agent Broker; mount the service at"
                            + " the root.");
        }
        String servletPath = mvc.getServlet().getPath();
        if (servletPath != null && !servletPath.isBlank()
                && !"/".equals(servletPath)) {
            // Same bypass as a context path: the filters must see the same
            // paths the dispatcher routes.
            throw new IllegalStateException(
                    "spring.mvc.servlet.path is not supported by the"
                            + " Managed Agent Broker; mount the service at"
                            + " the root.");
        }
        switch (configured) {
            case "open" -> mode = Mode.OPEN;
            case "signed" -> mode = Mode.SIGNED;
            case "auto" -> {
                if (!publicLoopback && !allowInsecureBind) {
                    throw new IllegalStateException(
                            "qwen.managed-agent.auth.mode=auto refuses a"
                                    + " non-loopback server.address;"
                                    + " configure signed mode"
                                    + " (qwen.managed-agent.auth.signing-key)"
                                    + " or set auth.allow-insecure-bind=true"
                                    + " to override.");
                }
                mode = Mode.OPEN;
            }
            default -> throw new IllegalStateException(
                    "qwen.managed-agent.auth.mode must be auto, open or"
                            + " signed.");
        }
        if (mode == Mode.OPEN && !publicLoopback) {
            if (!allowInsecureBind) {
                throw new IllegalStateException(
                        "qwen.managed-agent.auth.mode=open requires a"
                                + " loopback server.address; set"
                                + " auth.allow-insecure-bind"
                                + "=true to override.");
            }
            skippedGuards.add("public-bind");
        }
        if (mode == Mode.SIGNED) {
            byte[] key = auth.getSigningKey() == null
                    ? new byte[0]
                    : auth.getSigningKey().getBytes(StandardCharsets.UTF_8);
            if (key.length < MIN_SIGNING_KEY_BYTES) {
                throw new IllegalStateException(
                        "qwen.managed-agent.auth.signing-key must contain"
                                + " at least " + MIN_SIGNING_KEY_BYTES
                                + " bytes in signed mode.");
            }
            if (properties.getTrustedActorHeader() != null
                    && !properties.getTrustedActorHeader().isBlank()) {
                throw new IllegalStateException(
                        "qwen.managed-agent.trusted-actor-header cannot be"
                                + " combined with signed mode; the signature"
                                + " filter already authenticates the actor"
                                + " header.");
            }
            this.signingKey = key;
        } else {
            this.signingKey = null;
        }
        this.allowedDrift = auth.getAllowedDrift() == null
                ? Duration.ofMinutes(5) : auth.getAllowedDrift();
        // Sub-second windows truncate to zero at the SignatureAuthFilter
        // comparison and reject every request; refuse them here instead.
        if (this.allowedDrift.getSeconds() < 1) {
            throw new IllegalStateException(
                    "qwen.managed-agent.auth.allowed-drift must be at least"
                            + " 1 second.");
        }
        ManagedAgentProperties.InternalServer internal =
                properties.getInternalServer();
        String bindingKey = properties.getSessionStore().getBindingKey();
        byte[] bindingKeyBytes = bindingKey == null || bindingKey.isBlank()
                ? null : bindingKey.getBytes(StandardCharsets.UTF_8);
        // The routing filter classifies by local port; equal port numbers on
        // different addresses would let the public address serve /internal/**.
        // An unset server.port means the Spring Boot default 8080; 0 stays
        // exempt (the random port cannot be compared at startup).
        int publicPort = server.getPort() != null ? server.getPort()
                : DEFAULT_PUBLIC_PORT;
        if (internal.getPort() > 0 && publicPort > 0
                && internal.getPort() == publicPort) {
            throw new IllegalStateException(
                    "qwen.managed-agent.internal-server.port must differ"
                            + " from server.port; the surface routing is"
                            + " port-based.");
        }
        // The two keys protect different domains; reusing one key hands a
        // signing-key holder the journal write credential.
        if (mode == Mode.SIGNED && bindingKeyBytes != null
                && MessageDigest.isEqual(signingKey, bindingKeyBytes)) {
            throw new IllegalStateException(
                    "qwen.managed-agent.auth.signing-key and"
                            + " session-store.binding-key must differ.");
        }
        boolean internalExposed = internal.getPort() > 0
                || properties.getSessionStore().isEnabled()
                || properties.getToolPublication().isEnabled();
        boolean internalLoopback = internal.getPort() > 0
                && isLoopback(internal.getAddress());
        if (internalExposed && bindingKeyBytes == null
                && !(internal.getPort() > 0 ? internalLoopback
                        : publicLoopback)) {
            if (!allowInsecureBind) {
                throw new IllegalStateException(
                        "The internal surface requires a configured"
                                + " qwen.managed-agent.session-store.binding-key"
                                + " before it can leave a loopback address; set"
                                + " auth.allow-insecure-bind=true to override.");
            }
            skippedGuards.add("internal-binding-key");
        }
        if (internal.getPort() > 0
                && properties.getSessionStore().isEnabled()) {
            checkStoreBaseUrlPort(properties.getSessionStore().getBaseUrl(),
                    internal.getPort());
        }
        checkStoreBaseUrlTransport(properties.getSessionStore());
        checkHarnessTransport(properties, skippedGuards);
        checkPublicationTransport(properties, skippedGuards);
        this.maxSignedBodyBytes = auth.getMaxSignedBodyBytes();
        if (mode == Mode.SIGNED && maxSignedBodyBytes < 1) {
            throw new IllegalStateException(
                    "qwen.managed-agent.auth.max-signed-body-bytes must be"
                            + " positive.");
        }
        LOG.info(
                "Managed Agent Broker security: mode={} internalPort={}"
                        + " writerBinding={} allowInsecureBind={}"
                        + " allowedDrift={}" + (skippedGuards.isEmpty() ? ""
                                : " skipped=" + skippedGuards),
                mode, internal.getPort() > 0 ? internal.getPort() : "shared",
                bindingKeyBytes != null ? "bound" : "unbound",
                allowInsecureBind, allowedDrift);
    }

    // The attach payload sends harnesses to session-store.base-url; with a
    // dedicated internal listener a loopback URL naming another port 404s
    // every store call.
    private void checkStoreBaseUrlPort(String baseUrl, int internalPort) {
        if (baseUrl == null || baseUrl.isBlank()) {
            return;
        }
        java.net.URI uri;
        try {
            uri = java.net.URI.create(baseUrl);
        } catch (IllegalArgumentException error) {
            return;
        }
        int advertised = uri.getPort() > 0 ? uri.getPort()
                : "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
        if (advertised == internalPort) {
            return;
        }
        if (isLoopback(hostOf(uri))) {
            throw new IllegalStateException(
                    "qwen.managed-agent.session-store.base-url port "
                            + advertised + " does not reach the internal"
                            + " listener on " + internalPort
                            + "; point it at the internal port.");
        }
        LOG.warn("session-store.base-url port {} differs from the internal"
                + " listener port {}; the harness store calls must reach"
                + " the internal listener.", advertised, internalPort);
    }

    // The advertised store URL must satisfy the same literal-only loopback
    // rule the TypeScript client enforces, or every harness refuses it.
    private void checkStoreBaseUrlTransport(
            ManagedAgentProperties.SessionStore store) {
        if (!store.isEnabled()) {
            return;
        }
        String baseUrl = store.getBaseUrl();
        if (baseUrl == null || baseUrl.isBlank()) {
            return;
        }
        java.net.URI uri;
        try {
            uri = java.net.URI.create(baseUrl);
        } catch (IllegalArgumentException error) {
            return;
        }
        if ("http".equalsIgnoreCase(uri.getScheme())
                && !isLiteralLoopbackHost(hostOf(uri))
                && !store.isAllowInsecureHttp()) {
            throw new IllegalStateException(
                    "qwen.managed-agent.session-store.base-url uses plaintext"
                            + " http on a non-loopback host; every harness"
                            + " refuses it. Use https, a loopback address, or"
                            + " set session-store.allow-insecure-http=true.");
        }
    }

    // The broker→harness attach leg carries the issued writer credential.
    private void checkHarnessTransport(ManagedAgentProperties properties,
            java.util.List<String> skippedGuards) {
        if (!properties.getHarness().isEnabled()) {
            return;
        }
        String baseUrl = properties.getHarness().getBaseUrl();
        if (baseUrl == null || baseUrl.isBlank()) {
            return;
        }
        java.net.URI uri;
        try {
            uri = java.net.URI.create(baseUrl);
        } catch (IllegalArgumentException error) {
            return;
        }
        if ("http".equalsIgnoreCase(uri.getScheme())
                && !isLoopback(hostOf(uri))) {
            if (!allowInsecureBind) {
                throw new IllegalStateException(
                        "qwen.managed-agent.harness.base-url uses plaintext"
                                + " http on a non-loopback host, exposing"
                                + " provisioned writer credentials; use https"
                                + " or set auth.allow-insecure-bind=true to"
                                + " override.");
            }
            skippedGuards.add("harness-transport");
        }
    }

    // The publication surface is handed to remote runtimes; the consumer
    // (the runtime-side endpoint()) requires an absolute URL with no path
    // prefix and a literal loopback host for plaintext http.
    private static final java.util.Set<String> PUBLICATION_LOOPBACK_HOSTS =
            java.util.Set.of("127.0.0.1", "localhost", "[::1]");

    private void checkPublicationTransport(ManagedAgentProperties properties,
            java.util.List<String> skippedGuards) {
        ManagedAgentProperties.ToolPublication publication =
                properties.getToolPublication();
        if (!publication.isEnabled()) {
            return;
        }
        String baseUrl = publication.getServiceBaseUrl();
        if (baseUrl == null || baseUrl.isBlank()) {
            return;
        }
        java.net.URI uri;
        try {
            uri = java.net.URI.create(baseUrl);
        } catch (IllegalArgumentException error) {
            uri = null;
        }
        if (uri == null || !uri.isAbsolute()
                || !("http".equalsIgnoreCase(uri.getScheme())
                        || "https".equalsIgnoreCase(uri.getScheme()))
                || uri.getUserInfo() != null || uri.getQuery() != null
                || uri.getFragment() != null
                || !(uri.getPath() == null || uri.getPath().isEmpty()
                        || "/".equals(uri.getPath()))) {
            throw new IllegalStateException(
                    "qwen.managed-agent.tool-publication.service-base-url"
                            + " must be an absolute http(s) URL without a"
                            + " path prefix, query, or fragment; runtimes"
                            + " resolve /internal/managed-tool-publications"
                            + " against it.");
        }
        if ("http".equalsIgnoreCase(uri.getScheme())
                && !PUBLICATION_LOOPBACK_HOSTS.contains(hostOf(uri))) {
            if (!allowInsecureBind) {
                throw new IllegalStateException(
                        "qwen.managed-agent.tool-publication.service-base-url"
                                + " uses plaintext http on a non-loopback"
                                + " host, exposing writer credentials; use"
                                + " https or set auth.allow-insecure-bind=true"
                                + " to override.");
            }
            skippedGuards.add("publication-transport");
        }
    }

    // URI.getHost() is null for spellings the WHATWG parser accepts
    // (127.1); fall back to the authority so both sides classify them the
    // same.
    private static String hostOf(java.net.URI uri) {
        String host = uri.getHost();
        if (host != null) {
            return host;
        }
        String authority = uri.getAuthority();
        if (authority == null) {
            return null;
        }
        int at = authority.lastIndexOf('@');
        if (at >= 0) {
            authority = authority.substring(at + 1);
        }
        if (authority.startsWith("[")) {
            int end = authority.indexOf(']');
            return end >= 0 ? authority.substring(0, end + 1) : authority;
        }
        int colon = authority.lastIndexOf(':');
        return colon > 0 ? authority.substring(0, colon) : authority;
    }

    // The practical literal-only loopback set the client enforces:
    // localhost, *.localhost, dotted 127.0.0.0/8 forms, [::1]. A bare "127"
    // is excluded — WHATWG URL parsing maps it to 0.0.0.127, which the
    // client rejects. The resolver is never consulted here.
    private static boolean isLiteralLoopbackHost(String host) {
        if (host == null || host.isBlank()) {
            return false;
        }
        String value = host.trim().toLowerCase(Locale.ROOT);
        if (value.startsWith("[") && value.endsWith("]")) {
            return "[::1]".equals(value);
        }
        if ("localhost".equals(value) || value.endsWith(".localhost")
                || "::1".equals(value)) {
            return true;
        }
        return value.matches("^127(\\.[0-9]{1,3}){1,3}$");
    }

    public Mode getMode() {
        return mode;
    }

    public byte[] getSigningKey() {
        return signingKey == null ? null : signingKey.clone();
    }

    public Duration getAllowedDrift() {
        return allowedDrift;
    }

    public long getMaxSignedBodyBytes() {
        return maxSignedBodyBytes;
    }

    public boolean isAllowInsecureBind() {
        return allowInsecureBind;
    }

    static boolean isLoopback(String address) {
        if (address == null || address.isBlank()) {
            return false;
        }
        String value = address.trim();
        if (value.startsWith("[") && value.endsWith("]")) {
            value = value.substring(1, value.length() - 1);
        }
        // Literal shortcuts keep the common cases off the resolver.
        if (LOOPBACK_IPV4.matcher(value).matches() || "::1".equals(value)
                || "0:0:0:0:0:0:0:1".equals(value)
                || "localhost".equalsIgnoreCase(value)) {
            return true;
        }
        try {
            return InetAddress.getByName(value).isLoopbackAddress();
        } catch (UnknownHostException error) {
            return false;
        }
    }
}
