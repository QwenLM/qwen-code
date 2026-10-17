//go:build linux

package main

import (
	"errors"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

type gatewaySecurity struct {
	mu         sync.Mutex
	process    int
	namespaces *hostNamespaces
	failed     bool
}

func openGatewaySecurity() (_ *gatewaySecurity, err error) {
	p := &gatewaySecurity{process: -1}
	defer func() {
		if err != nil {
			p.close()
		}
	}()
	p.process, err = openHostProcess(strconv.Itoa(os.Getpid()))
	if err != nil {
		return nil, err
	}
	p.namespaces, err = openHostNamespaces(p.process)
	if err != nil {
		return nil, err
	}
	if err = p.verify(); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *gatewaySecurity) verify() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if p.failed || p.process < 0 {
		return errors.New("original gateway security is unavailable")
	}
	thread, err := openHostProcess(strconv.Itoa(os.Getpid()) + "/task/" + strconv.Itoa(unix.Gettid()))
	if err != nil {
		p.failed = true
		return err
	}
	defer unix.Close(thread)
	if gatewayConfinement() != nil || p.namespaces.verify(p.process) != nil || p.namespaces.verify(thread) != nil || gatewayConfinement() != nil {
		p.failed = true
		return errors.New("original gateway process or thread confinement changed")
	}
	return nil
}

func (p *gatewaySecurity) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.failed = true
	_ = p.namespaces.close()
	if p.process >= 0 {
		_ = unix.Close(p.process)
		p.process = -1
	}
}

func gatewayConfinement() error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	proc, err := unix.Open("/proc", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return errors.New("gateway process security is unavailable")
	}
	defer unix.Close(proc)
	var fs unix.Statfs_t
	if unix.Fstatfs(proc, &fs) != nil || fs.Type != unix.PROC_SUPER_MAGIC {
		return errors.New("gateway requires the actual proc filesystem")
	}
	thread := strconv.Itoa(os.Getpid()) + "/task/" + strconv.Itoa(unix.Gettid()) + "/"
	raw, statusErr := procFile(proc, thread+"status")
	security, securityErr := parseProcessSecurity(raw)
	uidMap, uidErr := procFile(proc, thread+"uid_map")
	label, labelErr := procFile(proc, thread+"attr/apparmor/current")
	if statusErr != nil || securityErr != nil || !security.source() || uidErr != nil ||
		strings.Join(strings.Fields(string(uidMap)), " ") != "0 0 4294967295" ||
		labelErr != nil || string(label) != "qwen-k2-gateway-v1 (enforce)\n" {
		return errors.New("gateway requires its original root credentials and dedicated enforced profile")
	}
	return nil
}
