//go:build linux

package main

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
	"golang.org/x/sys/unix"
)

type birthListener struct {
	listener *net.UnixListener
	path     string
	identity syscall.Stat_t
}

func openBirthListener(config *birth.ShimConfig) (*birthListener, error) {
	parent := filepath.Dir(config.SourceSocket)
	fd, err := unix.Openat2(unix.AT_FDCWD, parent, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return nil, errors.New("pre-exec source socket directory is unavailable")
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if unix.Fstat(fd, &st) != nil || st.Uid != 0 || st.Gid != 0 || st.Mode&0777 != 0700 {
		return nil, errors.New("pre-exec source socket directory must be private and root owned")
	}
	if _, err := os.Lstat(config.SourceSocket); !os.IsNotExist(err) {
		return nil, errors.New("pre-exec source socket already exists or is unknown")
	}
	listener, err := net.ListenUnix("unixpacket", &net.UnixAddr{Name: config.SourceSocket, Net: "unixpacket"})
	if err != nil {
		return nil, err
	}
	listener.SetUnlinkOnClose(false)
	if err := os.Chmod(config.SourceSocket, 0600); err != nil {
		listener.Close()
		return nil, err
	}
	info, err := os.Lstat(config.SourceSocket)
	if err != nil {
		listener.Close()
		return nil, err
	}
	identity, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		listener.Close()
		return nil, errors.New("actual pre-exec source socket identity is unavailable")
	}
	return &birthListener{listener, config.SourceSocket, *identity}, nil
}

func (l *birthListener) close() error {
	result := l.listener.Close()
	info, err := os.Lstat(l.path)
	if err != nil {
		return errors.Join(result, err)
	}
	actual, ok := info.Sys().(*syscall.Stat_t)
	if !ok || actual.Dev != l.identity.Dev || actual.Ino != l.identity.Ino || actual.Uid != 0 || actual.Gid != 0 || info.Mode()&os.ModeSocket == 0 {
		return errors.Join(result, errors.New("pre-exec source refuses cleanup of a changed socket"))
	}
	return errors.Join(result, os.Remove(l.path))
}

func (l *birthListener) run(ctx context.Context, config *birth.ShimConfig, source *nodeSource, sandboxImage string) error {
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(ctx, func() { _ = l.listener.Close() })
	defer stop()
	var running sync.WaitGroup
	defer func() { cancel(); running.Wait() }()
	slots := make(chan struct{}, 16)
	for {
		connection, err := l.listener.AcceptUnix()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return errors.New("actual pre-exec source listener stopped unexpectedly")
		}
		select {
		case slots <- struct{}{}:
		default:
			_ = connection.Close()
			continue
		}
		running.Add(1)
		go func() {
			defer running.Done()
			defer func() { <-slots }()
			handler := &birthHandler{source, config.Inputs, sandboxImage, config.Contract()}
			_ = birth.ServeConnection(ctx, connection, config.ShimSHA256, "qwen-k2-shim-v1", digest([]byte(source.journal.incarnation)), handler)
		}()
	}
}
