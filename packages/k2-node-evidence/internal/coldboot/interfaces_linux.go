//go:build linux

package coldboot

import (
	"errors"
	"io"
	"os"
)

type kernelInterface interface {
	io.Reader
	io.Writer
	io.Closer
	identity() (fdIdentity, error)
}
type fixedKernelInterface struct{ *os.File }

func (f fixedKernelInterface) identity() (fdIdentity, error) {
	id, err := fdObject(int(f.Fd()))
	id.flags = 0
	return id, err
}

// Only this package-private algorithm accepts an injected handle factory. Its
// production caller binds the literal kernel path, filesystem and object type.
func updateInterface(want string, open func(bool) (kernelInterface, error)) error {
	if want == "" || len(want) > 64 {
		return errors.New("a nonempty complete kernel write is required")
	}
	w, err := open(true)
	if err != nil {
		return err
	}
	before, idErr := w.identity()
	if idErr != nil {
		return errors.Join(idErr, w.Close())
	}
	n, writeErr := w.Write([]byte(want))
	after, afterErr := w.identity()
	closeErr := w.Close()
	if writeErr != nil || afterErr != nil || closeErr != nil || n != len(want) || before != after {
		return errors.New("kernel interface complete write failed")
	}
	r, err := open(false)
	if err != nil {
		return err
	}
	named, idErr := r.identity()
	if idErr != nil || named != before {
		return errors.Join(errors.New("kernel interface name changed"), r.Close())
	}
	raw, readErr := io.ReadAll(io.LimitReader(r, 65))
	closeErr = r.Close()
	if readErr != nil || closeErr != nil || string(raw) != want {
		return errors.New("kernel interface readback differs")
	}
	return nil
}
