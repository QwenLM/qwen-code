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
	"time"
)

type sourceGateway struct {
	client   *http.Client
	url      string
	identity gatewayIdentity
	plugin   *backendPeer
	frontend *frontendPeers
	policy   *fixedWorkerPolicy
}

func gatewayClient(endpoint, certPath, keyPath, caPath, principal string) (*sourceGateway, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || principal == "" {
		return nil, errors.New("gateway endpoint must be a fixed HTTPS origin")
	}
	certificate, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, errors.New("source client certificate is unavailable")
	}
	ca, err := os.ReadFile(caPath)
	if err != nil {
		return nil, errors.New("gateway authority is unavailable")
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
	return &sourceGateway{url: endpoint, client: &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("gateway redirect refused") }}}, nil
}

func (g *sourceGateway) call(ctx context.Context, method, path string, body any, output any) error {
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
	if response.Header.Get("Cache-Control") != "no-store" {
		return errors.New("original gateway cache policy differs")
	}
	if output == nil {
		if response.StatusCode != http.StatusNoContent {
			return errors.New("original gateway registration refused")
		}
		return nil
	}
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "application/json" {
		return errors.New("original gateway observation refused")
	}
	return decodeClosed(response.Body, output)
}

func (g *sourceGateway) current(ctx context.Context) (gatewayIdentity, error) {
	var identity gatewayIdentity
	err := g.call(ctx, http.MethodGet, "/v1/runtime", nil, &identity)
	if err != nil || identity.Version != "qwen-k2-runtime-identity/1" || len(identity.Incarnation) != 32 || !hashString(identity.Incarnation+identity.Incarnation) || !bounded(identity.BootID) || identity.Peer.PID <= 0 || identity.Peer.StartTicks == 0 || !hashString(identity.Peer.Digest) {
		return gatewayIdentity{}, errors.New("original gateway identity unavailable")
	}
	return identity, nil
}

func (g *sourceGateway) verify(ctx context.Context) error {
	current, err := g.current(ctx)
	boot, bootErr := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || current != g.identity || bootErr != nil || strings.TrimSpace(string(boot)) != current.BootID || g.plugin == nil || g.plugin.verify() != nil || g.frontend == nil || g.frontend.verify() != nil || g.policy.verify() != nil {
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
	if err != nil || observation.Version != "qwen-k2-runtime-read/1" || observation.ArmID != arm {
		return runtimeObservation{}, errors.New("original runtime observation unavailable")
	}
	return observation, nil
}
