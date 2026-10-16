//go:build linux

package main

import (
	"errors"
	"os"
	"runtime"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

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
