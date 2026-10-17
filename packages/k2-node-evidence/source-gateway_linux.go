//go:build linux

package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
)

type sourceGateway struct {
	verification sync.Mutex
	shimConfig   *birth.ShimConfig
	files        *roleFiles
	client       *http.Client
	url          string
	identity     gatewayIdentity
	plugin       *backendPeer
	frontend     *frontendPeers
	policy       *fixedWorkerPolicy
}

func gatewayClient(endpoint, certPath, keyPath, caPath, principal string, files *roleFiles) (*sourceGateway, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || principal == "" {
		return nil, errors.New("gateway endpoint must be a fixed HTTPS origin")
	}
	cert, certErr := files.bytes(certPath)
	key, keyErr := files.bytes(keyPath)
	ca, caErr := files.bytes(caPath)
	if errors.Join(certErr, keyErr, caErr) != nil {
		return nil, errors.New("original gateway TLS inputs are unavailable")
	}
	certificate, err := tls.X509KeyPair(cert, key)
	if err != nil {
		return nil, errors.New("source client certificate is unavailable")
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("gateway authority is invalid")
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, Certificates: []tls.Certificate{certificate}, VerifyConnection: func(state tls.ConnectionState) error {
		if len(state.VerifiedChains) == 0 || len(state.PeerCertificates) == 0 || len(state.PeerCertificates[0].URIs) != 1 || state.PeerCertificates[0].URIs[0].String() != principal {
			return errors.New("gateway principal differs")
		}
		return nil
	}}}
	return &sourceGateway{files: files, url: endpoint, client: &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("gateway redirect refused") }}}, nil
}

func (g *sourceGateway) call(ctx context.Context, method, path string, body any, output any) error {
	if g.files == nil || g.files.verify() != nil {
		return errors.New("original gateway TLS inputs changed")
	}
	var raw []byte
	var err error
	if body != nil {
		raw, err = json.Marshal(body)
	}
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, method, g.url+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := g.client.Do(request)
	if err != nil {
		return errors.New("original gateway channel unavailable")
	}
	defer response.Body.Close()
	if g.files.verify() != nil {
		return errors.New("original gateway TLS inputs changed")
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		return errors.New("original gateway cache policy differs")
	}
	if output == nil {
		if response.StatusCode != http.StatusNoContent {
			return errors.New("original gateway registration refused")
		}
		return nil
	}
	if response.StatusCode == http.StatusAccepted && method == http.MethodGet && strings.HasPrefix(path, "/v1/original/") && !strings.Contains(strings.TrimPrefix(path, "/v1/original/"), "/") {
		return errRuntimeTransition
	}
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "application/json" {
		return errors.New("original gateway observation refused")
	}
	if err := decodeClosed(response.Body, output); err != nil {
		return err
	}
	return g.files.verify()
}

func (g *sourceGateway) current(ctx context.Context) (gatewayIdentity, error) {
	var identity gatewayIdentity
	err := g.call(ctx, http.MethodGet, "/v1/runtime", nil, &identity)
	if err != nil || identity.Version != "qwen-k2-runtime-identity/2" || len(identity.Incarnation) != 32 || !hashString(identity.Incarnation+identity.Incarnation) || !bounded(identity.BootID) || identity.Peer.PID <= 0 || identity.Peer.StartTicks == 0 || !hashString(identity.Peer.Digest) {
		return gatewayIdentity{}, errors.New("original gateway identity unavailable")
	}
	return identity, nil
}

func (g *sourceGateway) verify(ctx context.Context) error {
	g.verification.Lock()
	defer g.verification.Unlock()
	current, err := g.current(ctx)
	boot, bootErr := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || current != g.identity || bootErr != nil || strings.TrimSpace(string(boot)) != current.BootID || g.plugin == nil || g.plugin.verify() != nil || g.frontend == nil || g.frontend.verify() != nil || g.policy == nil || g.policy.verify() != nil || g.shimConfig == nil || g.shimConfig.Verify() != nil {
		return errors.New("original source incarnation changed")
	}
	return nil
}

func (g *sourceGateway) observe(ctx context.Context, arm string) (runtimeObservation, error) {
	if !safeID(arm) {
		return runtimeObservation{}, errors.New("invalid original ARM")
	}
	var observation runtimeObservation
	err := g.call(ctx, http.MethodGet, "/v1/original/"+arm, nil, &observation)
	if errors.Is(err, errRuntimeTransition) {
		return runtimeObservation{}, err
	}
	if err != nil || observation.Version != "qwen-k2-runtime-read/1" || observation.ArmID != arm {
		return runtimeObservation{}, errors.New("original runtime observation unavailable")
	}
	return observation, nil
}
