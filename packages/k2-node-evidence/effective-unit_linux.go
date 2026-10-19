//go:build linux

package main

import (
	"context"
	"errors"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/artifactset"
	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/unitstate"
	"github.com/godbus/dbus/v5"
)

type effectiveUnit struct {
	mu            sync.Mutex
	connection    *dbus.Conn
	socket        net.Conn
	peer          *backendPeer
	object        dbus.BusObject
	role          string
	configuration string
	identity      unitstate.Identity
	failed        bool
}

func openEffectiveUnit(ctx context.Context, role, configuration string, expected artifactset.HostExecutable) (_ *effectiveUnit, err error) {
	name, err := unitstate.Name(role)
	if err != nil {
		return nil, err
	}
	p := &effectiveUnit{role: role, configuration: configuration}
	defer func() {
		if err != nil {
			p.close()
		}
	}()
	connect, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	p.socket, err = (&net.Dialer{}).DialContext(connect, "unix", "/run/systemd/private")
	if err != nil {
		return nil, errors.New("original systemd connection is unavailable")
	}
	identity, err := unixPeer(p.socket)
	if err != nil || identity.PID != 1 || identity.Digest != expected.SHA {
		return nil, errors.New("original systemd peer differs")
	}
	p.peer, err = retainPeer(identity, expected)
	if err != nil {
		return nil, err
	}
	if err = p.socket.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, err
	}
	p.connection, err = dbus.NewConn(&guardedBackendConnection{Conn: p.socket, peer: p.peer}, dbus.WithContext(ctx))
	if err != nil {
		return nil, err
	}
	if err = p.connection.Auth([]dbus.Auth{dbus.AuthExternal("0")}); err != nil {
		return nil, errors.New("original systemd external authentication failed")
	}
	object := "/org/freedesktop/systemd1/unit/" + strings.NewReplacer("-", "_2d", ".", "_2e").Replace(name)
	p.object = p.connection.Object("org.freedesktop.systemd1", dbus.ObjectPath(object))
	if err = p.verify(); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *effectiveUnit) properties(ctx context.Context, interfaceName string) (map[string]any, error) {
	var values map[string]dbus.Variant
	if err := p.object.CallWithContext(ctx, "org.freedesktop.DBus.Properties.GetAll", dbus.FlagNoAutoStart, "org.freedesktop.systemd1."+interfaceName).Store(&values); err != nil || len(values) == 0 || len(values) > 1024 {
		return nil, errors.New("original effective service properties are unavailable")
	}
	result := make(map[string]any, len(values))
	for key, value := range values {
		result[key] = value.Value()
	}
	return result, nil
}

func (p *effectiveUnit) verify() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.failed || p.connection == nil || !p.connection.Connected() || p.peer == nil || p.peer.verify() != nil {
		p.failed = true
		return errors.New("original effective service connection was lost")
	}
	if err := p.socket.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		p.failed = true
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	before, beforeErr := p.properties(ctx, "Unit")
	service, serviceErr := p.properties(ctx, "Service")
	after, afterErr := p.properties(ctx, "Unit")
	first, firstErr := unitstate.Check(p.role, p.configuration, uint32(os.Getpid()), before, service)
	last, lastErr := unitstate.Check(p.role, p.configuration, uint32(os.Getpid()), after, service)
	if errors.Join(beforeErr, serviceErr, afterErr, firstErr, lastErr) != nil || first != last ||
		p.identity != (unitstate.Identity{}) && p.identity != first || p.peer.verify() != nil ||
		p.socket.SetDeadline(time.Time{}) != nil {
		p.failed = true
		return errors.New("original effective service identity or settings changed")
	}
	p.identity = first
	return nil
}

func (p *effectiveUnit) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.failed = true
	if p.connection != nil {
		_ = p.connection.Close()
		p.connection = nil
	} else if p.socket != nil {
		_ = p.socket.Close()
	}
	if p.peer != nil {
		p.peer.close()
		p.peer = nil
	}
}
