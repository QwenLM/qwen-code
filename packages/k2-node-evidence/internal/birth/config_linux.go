//go:build linux

package birth

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

const ShimConfiguration = "/etc/qwen-k2/shim.json"

type ShimConfig struct {
	Inputs           InputPolicy `json:"inputs"`
	SourceSocket     string      `json:"sourceSocket"`
	SourceSHA256     string      `json:"sourceSha256"`
	ShimPath         string      `json:"shimPath"`
	ShimSHA256       string      `json:"shimSha256"`
	SocketRoot       string      `json:"socketRoot"`
	ContainerdGRPC   string      `json:"containerdGrpc"`
	ContainerdTTRPC  string      `json:"containerdTtrpc"`
	CreationContract []byte      `json:"creationContract"`
	contract         *CreationContract
	file             *ProtectedFile
}

func LoadShimConfig() (_ *ShimConfig, err error) {
	f, err := OpenProtectedFile(ShimConfiguration)
	if err != nil {
		return nil, errors.New("fixed protected shim configuration is unavailable")
	}
	defer func() {
		if err != nil {
			f.Close()
		}
	}()
	raw, err := f.Bytes()
	var config ShimConfig
	if err != nil || Decode(raw, &config, MaxInputs) != nil || config.Inputs.Validate() != nil || !cleanAbsolute(config.SourceSocket) || len(config.SourceSocket) > 100 || !Hash(config.SourceSHA256) || !cleanAbsolute(config.ShimPath) || !Hash(config.ShimSHA256) || !cleanAbsolute(config.SocketRoot) || nested(config.Inputs.InputRoot, config.SocketRoot) || nested(config.SocketRoot, config.Inputs.InputRoot) || !cleanAbsolute(config.ContainerdGRPC) || !cleanAbsolute(config.ContainerdTTRPC) || config.ContainerdGRPC == config.ContainerdTTRPC {
		return nil, errors.New("fixed protected shim configuration is invalid")
	}
	config.file = f
	config.contract, err = ReadCreationContract(config.CreationContract)
	if err != nil {
		return nil, err
	}
	if err := config.Verify(); err != nil {
		return nil, err
	}
	return &config, nil
}

func (c *ShimConfig) Contract() *CreationContract { return c.contract }

func (c *ShimConfig) Verify() error {
	if c == nil || c.file == nil {
		return errors.New("original shim configuration is closed")
	}
	return c.file.Verify()
}

func (c *ShimConfig) Close() error {
	if c == nil || c.file == nil {
		return nil
	}
	return c.file.Close()
}

func VerifyExecutable(path, expected string) error {
	if !cleanAbsolute(path) || !Hash(expected) {
		return errors.New("fixed executable identity is required")
	}
	fd, err := unix.Openat2(unix.AT_FDCWD, path, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	actual, err := object(f, true)
	if err != nil || actual.SHA256 != expected {
		return errors.New("actual protected executable differs from the fixed configuration")
	}
	return nil
}
