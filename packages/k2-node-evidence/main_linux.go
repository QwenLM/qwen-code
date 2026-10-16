//go:build linux

package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/roleboundary"
	"github.com/container-storage-interface/spec/lib/go/csi"
	containers "github.com/containerd/containerd/api/services/containers/v1"
	content "github.com/containerd/containerd/api/services/content/v1"
	images "github.com/containerd/containerd/api/services/images/v1"
	snapshots "github.com/containerd/containerd/api/services/snapshots/v1"
	tasks "github.com/containerd/containerd/api/services/tasks/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
	cri "k8s.io/cri-api/pkg/apis/runtime/v1"
)

type listenerConfig struct {
	Listen               string `json:"listen"`
	Certificate          string `json:"certificate"`
	Key                  string `json:"key"`
	Authority            string `json:"authority"`
	CoordinatorPrincipal string `json:"coordinatorPrincipal"`
}
type gatewayConfig struct {
	listenerConfig
	SourcePrincipal string `json:"sourcePrincipal"`
	RuntimeSocket   string `json:"runtimeSocket"`
	RuntimeDigest   string `json:"runtimeDigest"`
}
type sourceConfig struct {
	listenerConfig
	NodeUID                  string `json:"nodeUid"`
	Driver                   string `json:"driver"`
	JournalRoot              string `json:"journalRoot"`
	PluginSocket             string `json:"pluginSocket"`
	PluginDigest             string `json:"pluginDigest"`
	FrontendSocket           string `json:"frontendSocket"`
	KubeletDigest            string `json:"kubeletDigest"`
	RegistrarDigest          string `json:"registrarDigest"`
	GatewayURL               string `json:"gatewayUrl"`
	GatewayPrincipal         string `json:"gatewayPrincipal"`
	RuntimeDigest            string `json:"runtimeDigest"`
	GatewayClientCertificate string `json:"gatewayClientCertificate"`
	GatewayClientKey         string `json:"gatewayClientKey"`
	WorkerPolicySHA256       string `json:"workerPolicySha256"`
	SandboxImageSHA256       string `json:"sandboxImageSha256"`
}

func main() {
	if len(os.Args) != 3 || os.Args[1] != "gateway" && os.Args[1] != "source" {
		fmt.Fprintln(os.Stderr, "usage: k2-node-evidence <gateway|source> <configuration.json>")
		os.Exit(2)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	var err error
	if os.Args[1] == "gateway" {
		err = runGateway(ctx, os.Args[2])
	} else {
		err = runSource(ctx, os.Args[2])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "K2 node source failed:", err)
		os.Exit(1)
	}
}

func bootID() (string, error) {
	raw, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || len(raw) > 128 {
		return "", errors.New("node boot identity unavailable")
	}
	id := strings.TrimSpace(string(raw))
	if !safeID(id) {
		return "", errors.New("invalid node boot identity")
	}
	return id, nil
}

func serveControl(ctx context.Context, cfg listenerConfig, tlsConfig *tls.Config, handler http.Handler) error {
	host, port, err := net.SplitHostPort(cfg.Listen)
	n, portErr := strconv.Atoi(port)
	if err != nil || net.ParseIP(host) == nil || portErr != nil || n < 1024 || n > 65535 || cfg.CoordinatorPrincipal == "" {
		return errors.New("invalid source control listener")
	}
	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return errors.New("source control listener unavailable")
	}
	server := &http.Server{Handler: handler, TLSConfig: tlsConfig, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: maxRecordBytes}
	completed := make(chan error, 1)
	go func() { completed <- server.Serve(tls.NewListener(listener, tlsConfig)) }()
	select {
	case err := <-completed:
		_ = server.Close()
		if err != http.ErrServerClosed {
			return errors.New("source control server stopped unexpectedly")
		}
	case <-ctx.Done():
		stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if server.Shutdown(stop) != nil {
			_ = server.Close()
		}
		<-completed
	}
	return nil
}

func runGateway(ctx context.Context, path string) error {
	var cfg gatewayConfig
	files, err := loadRoleConfiguration(path, &cfg)
	if err != nil {
		return err
	}
	defer files.close()
	if err := files.add(cfg.Certificate, cfg.Key, cfg.Authority); err != nil {
		return err
	}
	if err := files.private(cfg.Key); err != nil {
		return err
	}
	tlsConfig, err := files.serverTLS(cfg.listenerConfig)
	if err != nil {
		return err
	}
	if cfg.SourcePrincipal == "" || cfg.SourcePrincipal == cfg.CoordinatorPrincipal {
		return errors.New("gateway source and coordinator principals must differ")
	}
	shimConfiguration, err := birth.LoadShimConfig()
	if err != nil {
		return err
	}
	defer shimConfiguration.Close()
	self, err := os.Executable()
	if err != nil || birth.VerifyExecutable(self, shimConfiguration.SourceSHA256) != nil || gatewayConfinement() != nil {
		return errors.New("actual gateway executable or confinement differs from the protected installation")
	}
	conn, process, err := connectBackend(cfg.RuntimeSocket, cfg.RuntimeDigest)
	if err != nil {
		return err
	}
	defer conn.Close()
	defer process.close()
	boot, err := bootID()
	if err != nil {
		return err
	}
	var incarnation [16]byte
	if _, err = rand.Read(incarnation[:]); err != nil {
		return errors.New("gateway incarnation unavailable")
	}
	gateway := &runtimeReadGateway{tasks: tasks.NewTasksClient(conn), containers: containers.NewContainersClient(conn), content: content.NewContentClient(conn), images: images.NewImagesClient(conn), snapshots: snapshots.NewSnapshotsClient(conn), cri: cri.NewRuntimeServiceClient(conn), lifetime: ctx, connection: conn, coordinator: cfg.CoordinatorPrincipal, source: cfg.SourcePrincipal, identity: &gatewayIdentity{Version: "qwen-k2-runtime-identity/1", Incarnation: hex.EncodeToString(incarnation[:]), BootID: boot, Peer: process.identity}}
	err = serveControl(ctx, cfg.listenerConfig, tlsConfig, roleboundary.Handler(func() error {
		current, err := bootID()
		if err != nil || current != boot || process.verify() != nil || files.verify() != nil || shimConfiguration.Verify() != nil || gatewayConfinement() != nil {
			return errors.New("original gateway installation or runtime incarnation changed")
		}
		return nil
	}, gateway))
	if closeErr := gateway.close(); closeErr != nil {
		return closeErr
	}
	return err
}

func runSource(ctx context.Context, path string) error {
	var cfg sourceConfig
	files, err := loadRoleConfiguration(path, &cfg)
	if err != nil {
		return err
	}
	defer files.close()
	if err := files.add(cfg.Certificate, cfg.Key, cfg.Authority, cfg.GatewayClientCertificate, cfg.GatewayClientKey); err != nil {
		return err
	}
	if err := files.private(cfg.Key, cfg.GatewayClientKey); err != nil {
		return err
	}
	tlsConfig, err := files.serverTLS(cfg.listenerConfig)
	if err != nil {
		return err
	}
	if !bounded(cfg.NodeUID) || !bounded(cfg.Driver) || !hashString(cfg.KubeletDigest) || !hashString(cfg.RegistrarDigest) || cfg.KubeletDigest == cfg.RegistrarDigest || !hashString(cfg.RuntimeDigest) || !hashString(cfg.SandboxImageSHA256) {
		return errors.New("invalid original source identities")
	}
	shimConfiguration, err := birth.LoadShimConfig()
	if err != nil {
		return err
	}
	defer shimConfiguration.Close()
	self, err := os.Executable()
	if err != nil || birth.VerifyExecutable(self, shimConfiguration.SourceSHA256) != nil || birth.VerifyExecutable(shimConfiguration.ShimPath, shimConfiguration.ShimSHA256) != nil {
		return errors.New("actual source and shim executables differ from the protected handler configuration")
	}
	policy, err := openFixedWorkerPolicy(cfg.WorkerPolicySHA256)
	if err != nil {
		return err
	}
	defer policy.close()
	conn, plugin, err := connectBackend(cfg.PluginSocket, cfg.PluginDigest)
	if err != nil {
		return err
	}
	defer conn.Close()
	defer plugin.close()
	identity := csi.NewIdentityClient(conn)
	probe, cancel := context.WithTimeout(ctx, 5*time.Second)
	info, err := identity.GetPluginInfo(probe, &csi.GetPluginInfoRequest{})
	cancel()
	if err != nil || info.GetName() != cfg.Driver {
		return errors.New("original CSI driver identity differs")
	}
	gateway, err := gatewayClient(cfg.GatewayURL, cfg.GatewayClientCertificate, cfg.GatewayClientKey, cfg.Authority, cfg.GatewayPrincipal, files)
	if err != nil {
		return err
	}
	defer gateway.client.CloseIdleConnections()
	runtime, err := gateway.current(ctx)
	boot, bootErr := bootID()
	if err != nil || bootErr != nil || runtime.BootID != boot || runtime.Peer.Digest != cfg.RuntimeDigest {
		return errors.New("original runtime and source nodes differ")
	}
	frontend := &frontendPeers{kubeletDigest: cfg.KubeletDigest, registrarDigest: cfg.RegistrarDigest}
	defer frontend.close()
	gateway.identity, gateway.plugin, gateway.frontend, gateway.policy = runtime, plugin, frontend, policy
	gateway.shimConfig = shimConfiguration
	sourceIdentity := sourceIdentity{NodeUID: cfg.NodeUID, BootID: boot, RuntimeDigest: runtime.Peer.Digest, RuntimeStart: runtime.Peer.StartTicks, RuntimePID: runtime.Peer.PID, GatewayIncarnation: runtime.Incarnation, PluginDigest: plugin.identity.Digest, PluginStart: plugin.identity.StartTicks, PluginPID: plugin.identity.PID}
	journal, journalPath, err := createJournal(cfg.JournalRoot, sourceIdentity)
	if err != nil {
		return err
	}
	defer journal.close()
	source := &nodeSource{journal: journal, journalPath: journalPath, gateway: gateway, coordinator: cfg.CoordinatorPrincipal, driver: cfg.Driver}
	birthSocket, err := openBirthListener(shimConfiguration)
	if err != nil {
		return err
	}
	defer birthSocket.close()
	if !filepath.IsAbs(cfg.FrontendSocket) || filepath.Clean(cfg.FrontendSocket) != cfg.FrontendSocket {
		return errors.New("invalid CSI frontend socket path")
	}
	directory, err := os.Lstat(filepath.Dir(cfg.FrontendSocket))
	if err != nil || !directory.IsDir() || directory.Mode().Perm() != 0700 {
		return errors.New("CSI frontend directory must be private")
	}
	if _, err = os.Lstat(cfg.FrontendSocket); !errors.Is(err, os.ErrNotExist) {
		return errors.New("CSI frontend socket already exists or is unknown")
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: cfg.FrontendSocket, Net: "unix"})
	if err != nil {
		return errors.New("CSI frontend listener unavailable")
	}
	defer listener.Close()
	if err = os.Chmod(cfg.FrontendSocket, 0600); err != nil {
		return errors.New("CSI frontend permissions unavailable")
	}
	server := grpc.NewServer(grpc.Creds(frontend), grpc.UnaryInterceptor(func(ctx context.Context, request any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		p, ok := peer.FromContext(ctx)
		if !ok {
			return nil, status.Error(codes.PermissionDenied, "CSI frontend peer unavailable")
		}
		auth, ok := p.AuthInfo.(frontendAuth)
		if !ok || strings.HasPrefix(info.FullMethod, "/csi.v1.Node/") && auth.role != "kubelet" {
			return nil, status.Error(codes.PermissionDenied, "CSI frontend role differs")
		}
		if files.verify() != nil {
			return nil, status.Error(codes.FailedPrecondition, "original source role files changed")
		}
		response, err := handler(ctx, request)
		if files.verify() != nil {
			return nil, status.Error(codes.FailedPrecondition, "original source role files changed")
		}
		return response, err
	}))
	proxy := &csiProxy{node: csi.NewNodeClient(conn), identity: identity, source: source}
	csi.RegisterIdentityServer(server, proxy)
	csi.RegisterNodeServer(server, proxy)
	defer server.Stop()
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	runCtx, stop := context.WithCancel(ctx)
	defer stop()
	birthDone := make(chan error, 1)
	go func() { birthDone <- birthSocket.run(runCtx, shimConfiguration, source, cfg.SandboxImageSHA256) }()
	observeDone := make(chan struct{})
	go func() { defer close(observeDone); source.run(runCtx) }()
	defer func() {
		stop()
		server.Stop()
		<-observeDone
		<-birthDone
		source.mu.Lock()
		defer source.mu.Unlock()
		for _, original := range source.originals {
			if original.unpublish == nil {
				_ = source.block(original)
			} else {
				_ = original.closePins()
			}
		}
	}()
	controlDone := make(chan error, 1)
	go func() { controlDone <- serveControl(runCtx, cfg.listenerConfig, tlsConfig, files.handler(source)) }()
	select {
	case err := <-controlDone:
		return err
	case err := <-birthDone:
		stop()
		<-controlDone
		birthDone <- err
		return errors.New("pre-exec source listener stopped unexpectedly")
	case <-serveDone:
		stop()
		<-controlDone
		return errors.New("CSI frontend stopped unexpectedly")
	}
}
