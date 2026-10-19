//go:build linux

package coldboot

import (
	"errors"
	"golang.org/x/sys/unix"
)

type capabilityState struct {
	permitted, effective, inheritable uint64
	ambient, bounding                 bool
}
type moduleCapabilityOps interface {
	read() (capabilityState, error)
	lowerAmbient() error
	lowerBounding() error
	set(capabilityState) error
}

type kernelCapabilities struct{}

func (kernelCapabilities) read() (capabilityState, error) {
	h := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3, Pid: 0}
	d := [2]unix.CapUserData{}
	if err := unix.Capget(&h, &d[0]); err != nil {
		return capabilityState{}, err
	}
	amb, ae := unix.PrctlRetInt(unix.PR_CAP_AMBIENT, unix.PR_CAP_AMBIENT_IS_SET, unix.CAP_SYS_MODULE, 0, 0)
	bound, be := unix.PrctlRetInt(unix.PR_CAPBSET_READ, unix.CAP_SYS_MODULE, 0, 0, 0)
	if ae != nil || be != nil {
		return capabilityState{}, errors.Join(ae, be)
	}
	return capabilityState{uint64(d[0].Permitted) | uint64(d[1].Permitted)<<32, uint64(d[0].Effective) | uint64(d[1].Effective)<<32, uint64(d[0].Inheritable) | uint64(d[1].Inheritable)<<32, amb != 0, bound != 0}, nil
}
func (kernelCapabilities) lowerAmbient() error {
	return unix.Prctl(unix.PR_CAP_AMBIENT, unix.PR_CAP_AMBIENT_LOWER, unix.CAP_SYS_MODULE, 0, 0)
}
func (kernelCapabilities) lowerBounding() error {
	return unix.Prctl(unix.PR_CAPBSET_DROP, unix.CAP_SYS_MODULE, 0, 0, 0)
}
func (kernelCapabilities) set(v capabilityState) error {
	h := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3, Pid: 0}
	d := [2]unix.CapUserData{}
	for i := range d {
		d[i].Permitted = uint32(v.permitted >> (32 * i))
		d[i].Effective = uint32(v.effective >> (32 * i))
		d[i].Inheritable = uint32(v.inheritable >> (32 * i))
	}
	return unix.Capset(&h, &d[0])
}

func verifyModuleAbsent(v capabilityState) error {
	mask := uint64(1) << unix.CAP_SYS_MODULE
	if (v.permitted|v.effective|v.inheritable)&mask != 0 || v.ambient || v.bounding {
		return errors.New("CAP_SYS_MODULE remains in an exec caller capability set")
	}
	return nil
}

func removeModule(ops moduleCapabilityOps) error {
	v, err := ops.read()
	if err != nil {
		return err
	}
	if err = ops.lowerAmbient(); err != nil {
		return err
	}
	if err = ops.lowerBounding(); err != nil {
		return err
	}
	mask := uint64(1) << unix.CAP_SYS_MODULE
	v.permitted &^= mask
	v.effective &^= mask
	v.inheritable &^= mask
	if err = ops.set(v); err != nil {
		return err
	}
	actual, err := ops.read()
	if err != nil {
		return err
	}
	return verifyModuleAbsent(actual)
}
