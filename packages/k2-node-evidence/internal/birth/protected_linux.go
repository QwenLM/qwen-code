//go:build linux

package birth

import (
	"errors"
	"io"
	"os"
	"sync"

	"golang.org/x/sys/unix"
)

// ProtectedFile retains an installed configuration or PEM object; Close never
// clears its immutable flag or removes a deployment-owned file.
type ProtectedFile struct {
	mu       sync.Mutex
	path     string
	file     *os.File
	identity Object
}

func OpenProtectedFile(path string) (*ProtectedFile, error) {
	if !cleanAbsolute(path) {
		return nil, errors.New("fixed protected file path is required")
	}
	fd, err := unix.Openat2(unix.AT_FDCWD, path, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return nil, errors.New("fixed protected file is unavailable")
	}
	f := os.NewFile(uintptr(fd), path)
	identity, err := object(f, false)
	if err != nil {
		f.Close()
		return nil, err
	}
	return &ProtectedFile{path: path, file: f, identity: identity}, nil
}

func (p *ProtectedFile) verify() error {
	if p.file == nil {
		return errors.New("original protected file is closed")
	}
	current, err := object(p.file, false)
	if err != nil || current != p.identity {
		return errors.New("original protected file changed")
	}
	fd, err := unix.Openat2(unix.AT_FDCWD, p.path, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return errors.New("original protected file name is unavailable")
	}
	f := os.NewFile(uintptr(fd), p.path)
	named, readErr := object(f, false)
	closeErr := f.Close()
	if readErr != nil || closeErr != nil || named != p.identity {
		return errors.New("original protected file name changed")
	}
	return nil
}

func (p *ProtectedFile) Verify() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.verify()
}

func (p *ProtectedFile) RequirePrivate() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.identity.Mode&07777 != 0400 || p.verify() != nil {
		return errors.New("original private key must remain root private and read only")
	}
	return nil
}

func (p *ProtectedFile) Bytes() ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.verify(); err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(io.NewSectionReader(p.file, 0, MaxInputs+1))
	if err != nil || int64(len(raw)) != p.identity.Bytes || SHA256(raw) != p.identity.SHA256 || p.verify() != nil {
		return nil, errors.New("actual protected file bytes changed")
	}
	return raw, nil
}

func (p *ProtectedFile) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.file == nil {
		return nil
	}
	err := p.file.Close()
	p.file = nil
	return err
}
