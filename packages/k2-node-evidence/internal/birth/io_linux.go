//go:build linux

package birth

import (
	"errors"
	"os"
	"path/filepath"

	task "github.com/containerd/containerd/api/runtime/task/v3"
	"golang.org/x/sys/unix"
)

type outputObject struct {
	device uint64
	inode  uint64
	mount  uint64
	mode   uint32
}

type outputPins struct {
	directory *os.File
	files     [2]*os.File
	names     [2]string
	objects   [2]outputObject
	path      string
}

func fifoObject(file *os.File) (outputObject, error) {
	var stat unix.Stat_t
	var mount unix.Statx_t
	if unix.Fstat(int(file.Fd()), &stat) != nil || stat.Mode&unix.S_IFMT != unix.S_IFIFO || stat.Uid != 0 || stat.Gid != 0 || stat.Mode&0077 != 0 || stat.Nlink != 1 || unix.Statx(int(file.Fd()), "", unix.AT_EMPTY_PATH, unix.STATX_MNT_ID, &mount) != nil || mount.Mask&unix.STATX_MNT_ID == 0 || mount.Mnt_id == 0 {
		return outputObject{}, errors.New("actual original output must be a private root-owned FIFO")
	}
	return outputObject{uint64(stat.Dev), stat.Ino, mount.Mnt_id, stat.Mode}, nil
}

func openOutputs(p InputPolicy, request *task.CreateTaskRequest) (_ *outputPins, err error) {
	if ValidateIO(p, request) != nil {
		return nil, errors.New("actual original output paths differ")
	}
	if request.Stdout == "" {
		return nil, nil
	}
	outputs := &outputPins{path: filepath.Dir(request.Stdout), names: [2]string{filepath.Base(request.Stdout), filepath.Base(request.Stderr)}}
	defer func() {
		if err != nil {
			err = errors.Join(err, outputs.close())
		}
	}()
	outputs.directory, err = directory(outputs.path, false)
	if err != nil {
		return nil, err
	}
	var stat unix.Stat_t
	if unix.Fstat(int(outputs.directory.Fd()), &stat) != nil || stat.Mode&0077 != 0 {
		return nil, errors.New("actual original FIFO directory is not private")
	}
	for index, name := range outputs.names {
		fd, err := unix.Openat2(int(outputs.directory.Fd()), name, &unix.OpenHow{Flags: unix.O_PATH | unix.O_CLOEXEC, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV})
		if err != nil {
			return nil, err
		}
		outputs.files[index] = os.NewFile(uintptr(fd), name)
		outputs.objects[index], err = fifoObject(outputs.files[index])
		if err != nil {
			return nil, err
		}
	}
	if err := outputs.verify(); err != nil {
		return nil, err
	}
	return outputs, nil
}

func (p *outputPins) verify() error {
	actual, err := directory(p.path, false)
	if err != nil {
		return err
	}
	defer actual.Close()
	var held, named unix.Stat_t
	if unix.Fstat(int(p.directory.Fd()), &held) != nil || unix.Fstat(int(actual.Fd()), &named) != nil || held.Dev != named.Dev || held.Ino != named.Ino || held.Mode != named.Mode || named.Mode&0077 != 0 {
		return errors.New("original FIFO directory changed")
	}
	for index, name := range p.names {
		object, err := fifoObject(p.files[index])
		if err != nil || object != p.objects[index] {
			return errors.New("retained original FIFO changed")
		}
		fd, err := unix.Openat2(int(actual.Fd()), name, &unix.OpenHow{Flags: unix.O_PATH | unix.O_CLOEXEC, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV})
		if err != nil {
			return err
		}
		file := os.NewFile(uintptr(fd), name)
		current, readErr := fifoObject(file)
		closeErr := file.Close()
		if readErr != nil || closeErr != nil || current != p.objects[index] {
			return errors.New("actual original FIFO name changed")
		}
	}
	return nil
}

func (p *outputPins) close() error {
	var result error
	for _, file := range p.files {
		if file != nil {
			result = errors.Join(result, file.Close())
		}
	}
	if p.directory != nil {
		result = errors.Join(result, p.directory.Close())
	}
	return result
}
