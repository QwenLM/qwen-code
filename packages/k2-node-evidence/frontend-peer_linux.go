//go:build linux

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"sync"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/artifactset"
	"golang.org/x/sys/unix"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
)

type frontendAuth struct {
	credentials.CommonAuthInfo
	role     string
	identity runtimePeer
}

func (frontendAuth) AuthType() string { return "k2-unix-peer" }

type frontendPeers struct {
	mu        sync.Mutex
	kubelet   artifactset.HostExecutable
	registrar artifactset.HostExecutable
	peers     map[string]*backendPeer
}

func retainPeer(identity runtimePeer, expected artifactset.HostExecutable) (*backendPeer, error) {
	if identity.PID <= 0 || identity.StartTicks == 0 || !hashString(identity.Digest) || identity.Digest != expected.SHA || expected.Label == "" {
		return nil, errors.New("original installed host identity is required")
	}
	p := &backendPeer{identity: identity, expected: expected, pidfd: -1, process: -1}
	var err error
	p.process, err = openHostProcess(strconv.FormatInt(int64(identity.PID), 10))
	if err == nil {
		p.procID, err = policyObject(p.process)
	}
	if err == nil {
		p.pidfd, err = unix.PidfdOpen(int(identity.PID), 0)
	}
	if err == nil {
		var fd int
		fd, err = unix.Openat(p.process, "exe", unix.O_RDONLY|unix.O_CLOEXEC, 0)
		if err == nil {
			p.executable = os.NewFile(uintptr(fd), "original-host-executable")
		}
	}
	if err == nil {
		err = unix.Fstat(int(p.executable.Fd()), &p.stat)
	}
	if err == nil {
		h := sha256.New()
		var n int64
		n, err = io.Copy(h, io.LimitReader(p.executable, 128<<20+1))
		if err == nil && (n == 0 || n > 128<<20 || hex.EncodeToString(h.Sum(nil)) != identity.Digest) {
			err = errors.New("original executable changed")
		}
	}
	if err == nil {
		err = p.verifyProcess()
	}
	if err == nil {
		p.namespaces, err = openHostNamespaces(p.process)
	}
	if err != nil || p.verify() != nil {
		p.close()
		return nil, errors.New("original process could not be retained")
	}
	return p, nil
}

func (f *frontendPeers) ServerHandshake(conn net.Conn) (net.Conn, credentials.AuthInfo, error) {
	identity, err := unixPeer(conn)
	if err != nil {
		return nil, nil, err
	}
	role := ""
	expected := artifactset.HostExecutable{}
	if identity.Digest == f.kubelet.SHA {
		role = "kubelet"
		expected = f.kubelet
	} else if identity.Digest == f.registrar.SHA {
		role = "registrar"
		expected = f.registrar
	}
	if role == "" {
		return nil, nil, errors.New("CSI frontend peer is unsupported")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.peers == nil {
		f.peers = make(map[string]*backendPeer)
	}
	previous := f.peers[role]
	if previous != nil {
		if previous.identity != identity || previous.verify() != nil {
			return nil, nil, errors.New("original CSI frontend peer changed")
		}
	} else {
		previous, err = retainPeer(identity, expected)
		if err != nil {
			return nil, nil, err
		}
		f.peers[role] = previous
	}
	return conn, frontendAuth{CommonAuthInfo: credentials.CommonAuthInfo{SecurityLevel: credentials.IntegrityOnly}, role: role, identity: identity}, nil
}

func (*frontendPeers) ClientHandshake(context.Context, string, net.Conn) (net.Conn, credentials.AuthInfo, error) {
	return nil, nil, errors.New("frontend credentials are server-only")
}
func (*frontendPeers) Info() credentials.ProtocolInfo {
	return credentials.ProtocolInfo{SecurityProtocol: "k2-unix-peer", SecurityVersion: "1"}
}
func (f *frontendPeers) Clone() credentials.TransportCredentials { return f }
func (*frontendPeers) OverrideServerName(string) error {
	return errors.New("frontend server-name override refused")
}

func (f *frontendPeers) verify() error {
	_, err := f.snapshot()
	return err
}

func (f *frontendPeers) snapshot() (frontendIdentity, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.peers) != 2 || f.peers["kubelet"] == nil || f.peers["registrar"] == nil {
		return frontendIdentity{}, errors.New("original kubelet and registrar are not ready")
	}
	for _, p := range f.peers {
		if p.verify() != nil {
			return frontendIdentity{}, errors.New("original CSI frontend process changed")
		}
	}
	return frontendIdentity{Kubelet: f.peers["kubelet"].identity, Registrar: f.peers["registrar"].identity}, nil
}

func (f *frontendPeers) close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.peers {
		p.close()
	}
}

func frontendCaller(ctx context.Context) (runtimePeer, error) {
	p, ok := peer.FromContext(ctx)
	if !ok {
		return runtimePeer{}, errors.New("original CSI caller unavailable")
	}
	auth, ok := p.AuthInfo.(frontendAuth)
	if !ok || auth.role != "kubelet" {
		return runtimePeer{}, errors.New("original kubelet caller required")
	}
	return auth.identity, nil
}
