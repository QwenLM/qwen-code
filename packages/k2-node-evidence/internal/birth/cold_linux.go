//go:build linux

package birth

import (
	"errors"
	"io"
	"path/filepath"
)

// OpenColdObject retains the actual cold-plan object and every protected path
// ancestor. It does not execute a file or relax the existing configuration bound.
func OpenColdObject(path string, limit int, executable bool) (_ *ProtectedFile, err error) {
	if limit < 1 || limit > 128<<20 {
		return nil, errors.New("cold object exceeds its role bound")
	}
	p, err := openProtectedFile(path, int64(limit))
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			_ = p.Close()
		}
	}()
	p.executable = executable
	if _, err = boundedObject(p.file, executable, int64(limit)); err != nil {
		return nil, err
	}
	for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
		ancestor, openErr := directory(parent, false)
		if openErr != nil {
			return nil, openErr
		}
		p.ancestors = append(p.ancestors, ancestor)
		id, identityErr := ancestorObject(ancestor)
		if identityErr != nil {
			return nil, identityErr
		}
		p.ancestorIdentities = append(p.ancestorIdentities, id)
		if parent == "/" {
			break
		}
	}
	return p, p.Verify()
}

// Descriptor is only for the final cold-init CLOEXEC census. It conveys no
// ownership transfer and must not be used to execute via a pathname alias.
func (p *ProtectedFile) Descriptors() []uintptr {
	r := []uintptr{p.file.Fd()}
	for _, f := range p.ancestors {
		r = append(r, f.Fd())
	}
	return r
}

func (p *ProtectedDirectory) Descriptors() []uintptr {
	r := []uintptr{p.file.Fd()}
	for _, f := range p.ancestors {
		r = append(r, f.Fd())
	}
	return r
}

// Names opens a separate directory description so enumeration never reuses a
// retained descriptor's mutable directory offset.
func (p *ProtectedDirectory) Names(limit int) ([]string, error) {
	if limit < 1 || limit > 4096 || p.Verify() != nil {
		return nil, errors.New("cold directory unavailable")
	}
	f, err := directory(p.path, true)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	identity, err := directoryObject(f)
	if err != nil || identity != p.identity {
		return nil, errors.New("cold directory enumeration lost its retained object")
	}
	names, err := f.Readdirnames(limit + 1)
	if err != nil && err != io.EOF {
		return nil, err
	}
	if len(names) > limit || p.Verify() != nil {
		return nil, errors.New("cold directory exceeds its exact set")
	}
	return names, nil
}
