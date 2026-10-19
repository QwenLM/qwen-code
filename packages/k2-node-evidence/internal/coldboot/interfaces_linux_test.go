//go:build linux

package coldboot

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"

	"golang.org/x/sys/unix"
)

type fakeInterface struct {
	raw                    *bytes.Reader
	written                []byte
	id                     fdIdentity
	short, changed, closed bool
	closeError             error
}

func (f *fakeInterface) Read(p []byte) (int, error) { return f.raw.Read(p) }
func (f *fakeInterface) Write(p []byte) (int, error) {
	f.written = append(f.written, p...)
	if f.short {
		return len(p) - 1, nil
	}
	return len(p), nil
}
func (f *fakeInterface) Close() error { f.closed = true; return f.closeError }
func (f *fakeInterface) identity() (fdIdentity, error) {
	id := f.id
	if f.changed && len(f.written) > 0 {
		id.inode++
	}
	return id, nil
}

func TestKernelDisableUsesOneRealLFWriteAndIndependentReadback(t *testing.T) {
	for _, fault := range []string{"", "zero", "short", "changed", "differentName", "readback", "close"} {
		t.Run(fault, func(t *testing.T) {
			writer := &fakeInterface{id: fdIdentity{device: 1, inode: 2, mount: 3}, short: fault == "short", changed: fault == "changed"}
			reader := &fakeInterface{id: writer.id, raw: bytes.NewReader([]byte("\n"))}
			if fault == "differentName" {
				reader.id.mount++
			}
			if fault == "readback" {
				reader.raw = bytes.NewReader([]byte("/sbin/modprobe\n"))
			}
			if fault == "close" {
				writer.closeError = errors.New("close failed")
			}
			want := "\n"
			if fault == "zero" {
				want = ""
			}
			opens := 0
			err := updateInterface(want, func(write bool) (kernelInterface, error) {
				opens++
				if write {
					return writer, nil
				}
				return reader, nil
			})
			if (err == nil) != (fault == "") {
				t.Fatal("incorrect interface outcome", fault, err)
			}
			if fault == "zero" {
				if opens != 0 {
					t.Fatal("zero write opened a kernel interface")
				}
				return
			}
			if !writer.closed || !bytes.Equal(writer.written, []byte("\n")) {
				t.Fatal("writer was not joined/closed after one LF write", writer)
			}
			if opens == 2 && !reader.closed {
				t.Fatal("reader leaked on failure")
			}
		})
	}
}

type fakeCapabilities struct {
	state capabilityState
	calls []string
	stuck string
	fail  string
}

func (f *fakeCapabilities) read() (capabilityState, error) {
	f.calls = append(f.calls, "read")
	if f.fail == "read" {
		return capabilityState{}, io.ErrUnexpectedEOF
	}
	return f.state, nil
}
func (f *fakeCapabilities) lowerAmbient() error {
	f.calls = append(f.calls, "ambient")
	if f.fail == "ambient" {
		return unix.EPERM
	}
	if f.stuck != "ambient" {
		f.state.ambient = false
	}
	return nil
}
func (f *fakeCapabilities) lowerBounding() error {
	f.calls = append(f.calls, "bounding")
	if f.fail == "bounding" {
		return unix.EPERM
	}
	if f.stuck != "bounding" {
		f.state.bounding = false
	}
	return nil
}
func (f *fakeCapabilities) set(v capabilityState) error {
	f.calls = append(f.calls, "set")
	if f.fail == "set" {
		return unix.EPERM
	}
	mask := uint64(1) << unix.CAP_SYS_MODULE
	f.state.permitted = v.permitted
	f.state.effective = v.effective
	f.state.inheritable = v.inheritable
	switch f.stuck {
	case "permitted":
		f.state.permitted |= mask
	case "effective":
		f.state.effective |= mask
	case "inheritable":
		f.state.inheritable |= mask
	}
	return nil
}

func TestAllFiveModuleCapabilityReadbacksMustActuallyClear(t *testing.T) {
	mask := uint64(1) << unix.CAP_SYS_MODULE
	other := uint64(1) << unix.CAP_SYS_RESOURCE
	for _, fault := range []string{"", "permitted", "effective", "inheritable", "ambient", "bounding"} {
		t.Run(fault, func(t *testing.T) {
			f := &fakeCapabilities{state: capabilityState{mask | other, mask | other, mask | other, true, true}, stuck: fault}
			err := removeModule(f)
			if (err == nil) != (fault == "") {
				t.Fatal("incorrect capability readback", fault, err)
			}
			if f.state.permitted&other == 0 || f.state.effective&other == 0 || f.state.inheritable&other == 0 {
				t.Fatal("unrelated capability was falsely removed")
			}
			if len(f.calls) != 5 || f.calls[4] != "read" {
				t.Fatal("capability readback was not independent", f.calls)
			}
		})
	}
	for _, fault := range []string{"read", "ambient", "bounding", "set"} {
		f := &fakeCapabilities{fail: fault}
		if removeModule(f) == nil {
			t.Fatal("capability syscall failure was ignored", fault)
		}
	}
}

func TestFinalDescriptorGateRejectsInheritedWritersAndUnknownRuntimeObjects(t *testing.T) {
	id := fdIdentity{device: 1, inode: 2, mount: 3}
	known := map[int]fdIdentity{4: id}
	for _, fault := range []string{"", "inheritedWriter", "unknownCloexec", "writableUnknown", "changed", "missing"} {
		t.Run(fault, func(t *testing.T) {
			actual := map[int]descriptorState{4: {id, true}}
			switch fault {
			case "inheritedWriter":
				actual[4] = descriptorState{id, false}
			case "unknownCloexec":
				actual[5] = descriptorState{id, true}
			case "writableUnknown":
				v := id
				v.flags = unix.O_RDWR
				actual[5] = descriptorState{v, true}
			case "changed":
				v := id
				v.inode++
				actual[4] = descriptorState{v, true}
			case "missing":
				delete(actual, 4)
			}
			if (checkFinalDescriptors(known, actual) == nil) != (fault == "") {
				t.Fatal("incorrect descriptor boundary", fault)
			}
		})
	}
}

func TestColdLoaderRejectsInterpreterOrDynamicProgramHeaders(t *testing.T) {
	raw := make([]byte, 120)
	binary.LittleEndian.PutUint64(raw[32:40], 64)
	binary.LittleEndian.PutUint16(raw[54:56], 56)
	binary.LittleEndian.PutUint16(raw[56:58], 1)
	for _, kind := range []uint32{1, 2, 3} {
		binary.LittleEndian.PutUint32(raw[64:68], kind)
		if staticELF(raw) != (kind == 1) {
			t.Fatal("incorrect static ELF gate", kind)
		}
	}
	if staticELF(raw[:100]) {
		t.Fatal("truncated program headers accepted")
	}
}
