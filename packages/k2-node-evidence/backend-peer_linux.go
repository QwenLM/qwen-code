//go:build linux

package main

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sys/unix"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

type backendPeer struct {
	mu         sync.Mutex
	identity   runtimePeer
	pidfd      int
	executable *os.File
	stat       unix.Stat_t
	attempted  bool
	failed     bool
}

func sameExecutable(a, b unix.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}

func (p *backendPeer) verify() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.failed || p.executable == nil {
		return errors.New("original backend connection was lost")
	}
	poll := []unix.PollFd{{Fd: int32(p.pidfd), Events: unix.POLLIN}}
	ticks, tickErr := startTicks(uint32(p.identity.PID))
	var current, retained unix.Stat_t
	if _, err := unix.Poll(poll, 0); err != nil || poll[0].Revents != 0 || tickErr != nil || ticks != p.identity.StartTicks || unix.Stat("/proc/"+strconv.FormatInt(int64(p.identity.PID), 10)+"/exe", &current) != nil || unix.Fstat(int(p.executable.Fd()), &retained) != nil || !sameExecutable(p.stat, current) || !sameExecutable(p.stat, retained) {
		p.failed = true
		return errors.New("original backend process changed")
	}
	return nil
}

type guardedBackendConnection struct {
	net.Conn
	peer *backendPeer
}

func (c *guardedBackendConnection) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if err != nil {
		c.peer.lose()
	}
	return n, err
}
func (c *guardedBackendConnection) Write(b []byte) (int, error) {
	n, err := c.Conn.Write(b)
	if err != nil {
		c.peer.lose()
	}
	return n, err
}
func (p *backendPeer) lose() { p.mu.Lock(); p.failed = true; p.mu.Unlock() }
func (p *backendPeer) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.failed = true
	if p.executable != nil {
		_ = p.executable.Close()
		p.executable = nil
	}
	if p.pidfd >= 0 {
		_ = unix.Close(p.pidfd)
		p.pidfd = -1
	}
}

func connectBackend(path, expectedDigest string) (*grpc.ClientConn, *backendPeer, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || !hashString(expectedDigest) {
		return nil, nil, errors.New("invalid original backend configuration")
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode()&os.ModeSymlink != 0 {
		return nil, nil, errors.New("original backend socket unavailable")
	}
	p := &backendPeer{pidfd: -1}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := grpc.DialContext(ctx, "passthrough:///original-backend", grpc.WithBlock(), grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.attempted {
			p.failed = true
			return nil, errors.New("original backend reconnect refused")
		}
		p.attempted = true
		c, err := (&net.Dialer{}).DialContext(ctx, "unix", path)
		if err != nil {
			p.failed = true
			return nil, errors.New("original backend connection unavailable")
		}
		identity, err := unixPeer(c)
		if err != nil || identity.Digest != expectedDigest {
			_ = c.Close()
			p.failed = true
			return nil, errors.New("original backend peer differs")
		}
		retained, err := retainPeer(identity)
		if err != nil {
			_ = c.Close()
			p.failed = true
			return nil, errors.New("original backend could not be retained")
		}
		p.identity, p.pidfd, p.executable, p.stat = retained.identity, retained.pidfd, retained.executable, retained.stat
		return &guardedBackendConnection{Conn: c, peer: p}, nil
	}), grpc.WithUnaryInterceptor(func(ctx context.Context, method string, request, response any, cc *grpc.ClientConn, invoke grpc.UnaryInvoker, options ...grpc.CallOption) error {
		if p.verify() != nil {
			return errors.New("original backend incarnation unavailable")
		}
		err := invoke(ctx, method, request, response, cc, options...)
		if p.verify() != nil {
			return errors.New("original backend incarnation changed")
		}
		return err
	}))
	if err != nil || p.verify() != nil {
		if conn != nil {
			_ = conn.Close()
		}
		p.close()
		return nil, nil, errors.New("original backend could not be connected")
	}
	return conn, p, nil
}
