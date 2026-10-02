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
    private static final Pattern LOOPBACK_IPV4 = Pattern.compile(
            "^127(\\.(0|[1-9][0-9]{0,2})){3}$");
    private final Mode mode;
    private final byte[] signingKey;
    private final Duration allowedDrift;
    private final boolean allowInsecureBind;

    public BrokerSecurity(ManagedAgentProperties properties,
            ServerProperties server) {
        ManagedAgentProperties.Auth auth = properties.getAuth();
        String configured = auth.getMode() == null
                ? "auto" : auth.getMode().trim().toLowerCase(Locale.ROOT);
        this.allowInsecureBind = auth.isAllowInsecureBind();
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
        if (mode == Mode.OPEN && !publicLoopback && !allowInsecureBind) {
            throw new IllegalStateException(
                    "qwen.managed-agent.auth.mode=open requires a loopback"
                            + " server.address; set auth.allow-insecure-bind"
                            + "=true to override.");
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
        ManagedAgentProperties.InternalServer internal =
                properties.getInternalServer();
        String bindingKey = properties.getSessionStore().getBindingKey();
        byte[] bindingKeyBytes = bindingKey == null || bindingKey.isBlank()
                ? null : bindingKey.getBytes(StandardCharsets.UTF_8);
        // The routing filter classifies by local port; equal port numbers on
        // different addresses would let the public address serve /internal/**.
        Integer publicPort = server.getPort();
        if (internal.getPort() > 0 && publicPort != null && publicPort > 0
                && internal.getPort() == publicPort.intValue()) {
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
        if (internalExposed && !allowInsecureBind
                && bindingKeyBytes == null
                && !(internal.getPort() > 0 ? internalLoopback
                        : publicLoopback)) {
            throw new IllegalStateException(
                    "The internal surface requires a configured"
                            + " qwen.managed-agent.session-store.binding-key"
                            + " before it can leave a loopback address; set"
                            + " auth.allow-insecure-bind=true to override.");
        }
        LOG.info(
                "Managed Agent Broker security: mode={} internalPort={}"
                        + " writerBinding={} allowInsecureBind={}",
                mode, internal.getPort() > 0 ? internal.getPort() : "shared",
                bindingKeyBytes != null ? "bound" : "unbound",
                allowInsecureBind);
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
