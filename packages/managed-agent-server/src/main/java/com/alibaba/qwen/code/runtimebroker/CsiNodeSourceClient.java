package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.require;

import java.io.IOException;
import java.net.URI;
import java.net.Socket;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509ExtendedTrustManager;

/** Fixed authenticated node-source operations; no worker or public Workspace route uses this client. */
public final class CsiNodeSourceClient implements AutoCloseable {
    private final URI origin;
    private final String principal;
    private final HttpClient client;

    public CsiNodeSourceClient(URI origin, String sourcePrincipal, String coordinatorPrincipal,
            Path clientStore, Path passwordFile, Path caFile) {
        require(origin != null && "https".equals(origin.getScheme()) && origin.getHost() != null
                && origin.getRawUserInfo() == null && origin.getRawQuery() == null && origin.getRawFragment() == null
                && (origin.getRawPath().isEmpty() || "/".equals(origin.getRawPath()))
                && !origin.toString().contains("\\"));
        this.origin = origin;
        this.principal = identity(sourcePrincipal);
        identity(coordinatorPrincipal);
        char[] password = null;
        try {
            byte[] passwordBytes = read(passwordFile, 4096);
            try {
                require(passwordBytes.length > 0);
                for (byte b : passwordBytes) {
                    require(b >= 32 && b <= 126 || b == '\n' || b == '\r');
                }
                password = new String(passwordBytes, StandardCharsets.US_ASCII).stripTrailing().toCharArray();
                require(password.length > 0);
            } finally {
                Arrays.fill(passwordBytes, (byte) 0);
            }
            KeyStore keys = KeyStore.getInstance("PKCS12");
            byte[] encodedKeys = read(clientStore, 2 * 1024 * 1024);
            try {
                keys.load(new java.io.ByteArrayInputStream(encodedKeys), password);
            } finally {
                Arrays.fill(encodedKeys, (byte) 0);
            }
            require(keys.size() == 1);
            String alias = Collections.list(keys.aliases()).getFirst();
            require(keys.isKeyEntry(alias) && keys.getCertificate(alias) instanceof X509Certificate);
            var leaf = (X509Certificate) keys.getCertificate(alias);
            leaf.checkValidity();
            requirePrincipal(leaf, coordinatorPrincipal);
            var km = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            km.init(keys, password);
            KeyStore roots = KeyStore.getInstance(KeyStore.getDefaultType());
            roots.load(null, null);
            var certificates = CertificateFactory.getInstance("X.509").generateCertificates(
                    new java.io.ByteArrayInputStream(read(caFile, 1024 * 1024)));
            require(!certificates.isEmpty());
            int index = 0;
            for (var certificate : certificates) {
                require(certificate instanceof X509Certificate && ((X509Certificate) certificate).getBasicConstraints() >= 0);
                roots.setCertificateEntry("ca-" + index++, certificate);
            }
            var tm = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tm.init(roots);
            require(tm.getTrustManagers().length == 1 && tm.getTrustManagers()[0] instanceof X509ExtendedTrustManager);
            var trust = principalTrust((X509ExtendedTrustManager) tm.getTrustManagers()[0], this.principal);
            var tls = SSLContext.getInstance("TLSv1.3");
            tls.init(km.getKeyManagers(), new TrustManager[] {trust}, null);
            var parameters = new SSLParameters();
            parameters.setProtocols(new String[] {"TLSv1.3"});
            parameters.setEndpointIdentificationAlgorithm("HTTPS");
            this.client = HttpClient.newBuilder().sslContext(tls).sslParameters(parameters)
                    .followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofSeconds(5)).build();
        } catch (IOException | GeneralSecurityException invalid) {
            throw new IllegalArgumentException("CSI node source client identity is unavailable", invalid);
        } finally {
            if (password != null) {
                Arrays.fill(password, '\0');
            }
        }
    }

    public CsiNodeSourceJournal.Stream observe() {
        return observeEvidence().stream();
    }

    public CsiNodeSourceJournal.Evidence observeEvidence() {
        var envelope = CsiNodeSourceJournal.object(call("/v1/journal", null, CsiNodeSourceJournal.RESPONSE_LIMIT, 200),
                CsiNodeSourceJournal.RESPONSE_LIMIT);
        CsiNodeSourceJournal.fields(envelope, List.of("head", "bytesBase64"));
        var head = CsiNodeSourceJournal.cursor(envelope.path("head"));
        String encoded = CsiNodeSourceJournal.text(envelope, "bytesBase64");
        require(encoded.length() <= ((long) CsiNodeSourceJournal.MAX_BYTES + 2) / 3 * 4);
        byte[] bytes = Base64.getDecoder().decode(encoded);
        require(bytes.length <= CsiNodeSourceJournal.MAX_BYTES && Base64.getEncoder().encodeToString(bytes).equals(encoded));
        return CsiNodeSourceJournal.verify(bytes, head);
    }

    public record Control(CsiNodeSourceJournal.Evidence evidence, CsiNodeSourceJournal.Cursor cursor) { }

    public Control arm(CsiNodeSourceJournal.Scope scope, String imageDigest) {
        require(scope != null);
        safeId(scope.armId());
        safeId(scope.namespace());
        safeId(scope.podName());
        hash(imageDigest);
        require("".equals(scope.podUid()) && "".equals(scope.containerId()) && "".equals(scope.target())
                && "".equals(scope.retirementId()));
        var fields = scopeMap(scope);
        var result = control("/v1/source:arm", "ARM", Map.of("scope", fields, "imageDigest", imageDigest));
        require(result.evidence().record(result.cursor()).path("scope").equals(CsiNodeSourceJournal.object(JsonCodec.encode(fields), 64 * 1024)));
        require(imageDigest.equals(CsiNodeSourceJournal.text(result.evidence().record(result.cursor()), "imageDigest")));
        return result;
    }

    public void register(String armId, String namespace, String podName, String podUid, String imageDigest) {
        for (String id : List.of(armId, namespace, podName, podUid)) {
            safeId(id);
        }
        hash(imageDigest);
        call("/v1/original:register", Map.of("armId", armId, "namespace", namespace, "podName", podName,
                "podUid", podUid, "imageDigest", imageDigest), 64 * 1024, 204);
    }

    public Control bind(String armId, String podUid, String pvName, String gatedSpecSha256, String podResourceVersion) {
        safeId(armId);
        safeId(podUid);
        safeId(pvName);
        hash(gatedSpecSha256);
        require(podResourceVersion != null && !podResourceVersion.isBlank() && podResourceVersion.length() <= 2048
                && podResourceVersion.indexOf('\0') < 0);
        String target = "/var/lib/kubelet/pods/" + podUid + "/volumes/kubernetes.io~csi/" + pvName + "/mount";
        var result = control("/v1/source:bind", "BIND", Map.of("armId", armId, "podUid", podUid, "target", target,
                "gatedSpecSha256", gatedSpecSha256, "podResourceVersion", podResourceVersion));
        var scope = result.evidence().record(result.cursor()).path("scope");
        require(armId.equals(CsiNodeSourceJournal.text(scope, "armId"))
                && podUid.equals(CsiNodeSourceJournal.text(scope, "podUid")) && target.equals(CsiNodeSourceJournal.text(scope, "target")));
        var record = result.evidence().record(result.cursor());
        require(gatedSpecSha256.equals(CsiNodeSourceJournal.text(record, "gatedSpecSha256"))
                && podResourceVersion.equals(CsiNodeSourceJournal.text(record, "podResourceVersion")));
        return result;
    }

    public Control requestStop(String armId, String retirementId, String intentHash) {
        safeId(armId);
        require(retirementId != null && !retirementId.isBlank() && retirementId.length() <= 2048 && retirementId.indexOf('\0') < 0);
        hash(intentHash);
        var result = control("/v1/source:stop-intent", "STOP_INTENT",
                Map.of("armId", armId, "retirementId", retirementId, "intentHash", intentHash));
        var record = result.evidence().record(result.cursor());
        require(armId.equals(CsiNodeSourceJournal.text(record.path("scope"), "armId"))
                && retirementId.equals(CsiNodeSourceJournal.text(record.path("scope"), "retirementId"))
                && intentHash.equals(CsiNodeSourceJournal.text(record, "intentHash")));
        return result;
    }

    private Control control(String path, String kind, Map<String, Object> body) {
        var record = CsiNodeSourceJournal.object(call(path, body, 64 * 1024, 200), 64 * 1024);
        var cursor = new CsiNodeSourceJournal.Cursor(CsiNodeSourceJournal.integer(record, "sequence", 65536),
                CsiNodeSourceJournal.text(record, "hash"));
        var evidence = observeEvidence();
        require(kind.equals(CsiNodeSourceJournal.text(record, "kind")) && record.equals(evidence.record(cursor)));
        return new Control(evidence, cursor);
    }

    private byte[] call(String path, Object body, int limit, int expectedStatus) {
        var builder = HttpRequest.newBuilder(origin.resolve(path)).timeout(Duration.ofSeconds(10))
                .header("Accept", "application/json");
        if (body != null) {
            byte[] encoded = JsonCodec.encode(body);
            require(encoded.length <= 64 * 1024);
            builder.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofByteArray(encoded));
        }
        var request = builder.build();
        var exchange = client.sendAsync(request,
                ignored -> new HttpRuntimeTransport.BoundedBodySubscriber(limit));
        try {
            var response = exchange.thenApply(value -> value).orTimeout(10, TimeUnit.SECONDS).join();
            require(response.statusCode() == expectedStatus && !response.body().overflow()
                    && response.headers().allValues("Cache-Control").equals(List.of("no-store"))
                    && (expectedStatus == 204 ? response.body().bytes().length == 0 && response.headers().allValues("Content-Type").isEmpty()
                            : response.headers().allValues("Content-Type").equals(List.of("application/json"))));
            var session = response.sslSession().orElseThrow();
            require("TLSv1.3".equals(session.getProtocol()));
            requirePrincipal((X509Certificate) session.getPeerCertificates()[0], principal);
            return response.body().bytes();
        } catch (IOException | GeneralSecurityException | RuntimeException failure) {
            exchange.cancel(true);
            throw new IllegalArgumentException("Authenticated CSI node source observation is unavailable", failure);
        }
    }

    private static void safeId(String value) {
        require(value != null && value.matches("[a-z0-9-]{1,128}"));
    }

    private static void hash(String value) {
        require(value != null && value.matches("[0-9a-f]{64}"));
    }

    private static Map<String, Object> scopeMap(CsiNodeSourceJournal.Scope scope) {
        var fields = new LinkedHashMap<String, Object>();
        fields.put("armId", scope.armId());
        fields.put("namespace", scope.namespace());
        fields.put("podName", scope.podName());
        fields.put("podUid", scope.podUid());
        fields.put("containerId", scope.containerId());
        fields.put("driver", scope.driver());
        fields.put("volumeId", scope.volumeId());
        fields.put("pvUid", scope.pvUid());
        fields.put("pvcUid", scope.pvcUid());
        fields.put("target", scope.target());
        fields.put("bindingId", scope.bindingId());
        fields.put("retirementId", scope.retirementId());
        return fields;
    }

    private static String identity(String principal) {
        require(principal != null && principal.length() <= 2048);
        URI uri = URI.create(principal);
        require(uri.isAbsolute() && uri.getRawFragment() == null && uri.getRawQuery() == null
                && uri.getRawUserInfo() == null);
        return principal;
    }

    private static void requirePrincipal(X509Certificate certificate, String principal) throws CertificateException {
        var names = certificate.getSubjectAlternativeNames();
        if (names == null) {
            throw new CertificateException("CSI node source principal is absent");
        }
        var uris = names.stream().filter(name -> Integer.valueOf(6).equals(name.getFirst())).toList();
        if (uris.size() != 1 || !principal.equals(uris.getFirst().get(1))) {
            throw new CertificateException("CSI node source principal differs");
        }
    }

    private static X509ExtendedTrustManager principalTrust(X509ExtendedTrustManager delegate, String principal) {
        return new X509ExtendedTrustManager() {
            @Override
            public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                delegate.checkServerTrusted(chain, auth);
                requirePrincipal(chain[0], principal);
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String auth, Socket socket) throws CertificateException {
                delegate.checkServerTrusted(chain, auth, socket);
                requirePrincipal(chain[0], principal);
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String auth, SSLEngine engine) throws CertificateException {
                delegate.checkServerTrusted(chain, auth, engine);
                requirePrincipal(chain[0], principal);
            }

            @Override
            public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                delegate.checkClientTrusted(chain, auth);
            }

            @Override
            public void checkClientTrusted(X509Certificate[] chain, String auth, Socket socket) throws CertificateException {
                delegate.checkClientTrusted(chain, auth, socket);
            }

            @Override
            public void checkClientTrusted(X509Certificate[] chain, String auth, SSLEngine engine) throws CertificateException {
                delegate.checkClientTrusted(chain, auth, engine);
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return delegate.getAcceptedIssuers();
            }
        };
    }

    private static byte[] read(Path path, int limit) throws IOException {
        require(path != null && path.isAbsolute());
        try (var input = Files.newInputStream(path)) {
            byte[] result = input.readNBytes(limit + 1);
            require(result.length > 0 && result.length <= limit);
            return result;
        }
    }

    @Override
    public void close() {
        client.shutdownNow();
    }
}
