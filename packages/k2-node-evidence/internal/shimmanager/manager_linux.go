//go:build linux

package shimmanager

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
	bootapi "github.com/containerd/containerd/api/runtime/bootstrap/v1"
	"github.com/containerd/containerd/api/types"
	"github.com/containerd/containerd/api/types/runc/options"
	"github.com/containerd/containerd/v2/cmd/containerd-shim-runc-v2/manager"
	"github.com/containerd/containerd/v2/cmd/containerd-shim-runc-v2/process"
	"github.com/containerd/containerd/v2/core/mount"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	"github.com/containerd/containerd/v2/pkg/shim"
	runc "github.com/containerd/go-runc"
	"golang.org/x/sys/unix"
	"google.golang.org/protobuf/proto"
)

const RuntimeType = "io.containerd.qwen-k2.v1"

type Manager struct {
	base shim.Shim
}

var _ shim.Shim = (*Manager)(nil)

func New() *Manager           { return &Manager{base: manager.NewShimManager(RuntimeType)} }
func (*Manager) Name() string { return RuntimeType }

func fixed(ctx context.Context) (*birth.ShimConfig, error) {
	namespace, err := namespaces.NamespaceRequired(ctx)
	if err != nil || namespace != "k8s.io" {
		return nil, errors.New("K2 manager requires the original Kubernetes namespace")
	}
	return fixedExecutables()
}

func fixedExecutables() (*birth.ShimConfig, error) {
	config, err := birth.LoadShimConfig()
	if err != nil {
		return nil, err
	}
	self, err := os.Executable()
	if err != nil || self != config.ShimPath || birth.VerifyExecutable(self, config.ShimSHA256) != nil || birth.VerifyExecutable(config.Inputs.RuncPath, config.Inputs.RuncSHA256) != nil {
		config.Close()
		return nil, errors.New("actual K2 manager executables differ")
	}
	return config, nil
}

func peer(address string, config *birth.ShimConfig) error {
	if !strings.HasPrefix(address, "unix://"+config.SocketRoot+"/") {
		return errors.New("K2 manager socket domain differs")
	}
	connection, err := shim.AnonDialer(address, 5*time.Second)
	if err != nil {
		return err
	}
	defer connection.Close()
	conn, ok := connection.(*net.UnixConn)
	if !ok {
		return errors.New("K2 manager requires the actual Unix shim peer")
	}
	identity, err := birth.OpenPeer(conn, config.ShimSHA256, "qwen-k2-shim-v1")
	if err != nil {
		return err
	}
	return identity.Close()
}

func (m *Manager) Start(ctx context.Context, parameters *bootapi.BootstrapParams) (*bootapi.BootstrapResult, error) {
	config, err := fixed(ctx)
	if err != nil {
		return nil, err
	}
	defer config.Close()
	if birth.ValidateBootstrap(parameters, config.Inputs, config.ContainerdGRPC, config.ContainerdTTRPC, config.SocketRoot) != nil {
		return nil, errors.New("actual original K2 bootstrap parameters are required")
	}
	cwd, err := os.Getwd()
	if err != nil || cwd != filepath.Join(config.Inputs.BundleRoot, parameters.GetInstanceID()) {
		return nil, errors.New("actual K2 bootstrap bundle differs")
	}
	f, err := os.Open(filepath.Join(cwd, "config.json"))
	if err != nil {
		return nil, err
	}
	raw, readErr := io.ReadAll(io.LimitReader(f, birth.MaxInputs+1))
	closeErr := f.Close()
	_, spec, specErr := birth.ConsumedSpec(raw)
	if readErr != nil || closeErr != nil || specErr != nil {
		return nil, errors.New("actual K2 bootstrap spec is unavailable")
	}
	group := spec.Annotations["io.kubernetes.cri.sandbox-id"]
	if !birth.Hash(group) || spec.Annotations["io.kubernetes.cri.container-type"] == "sandbox" && group != parameters.GetInstanceID() {
		return nil, errors.New("K2 bootstrap group differs from its original Pod")
	}
	var opts options.Options
	found, err := parameters.FindExtension(&opts)
	if err != nil || !found || birth.ValidateOptions(config.Inputs, &opts) != nil {
		return nil, errors.New("actual K2 bootstrap runc options differ")
	}
	address, err := shim.CreateSocketAddress(ctx, config.SocketRoot, parameters.GetContainerdGrpcAddress(), group, false)
	if err != nil {
		return nil, err
	}
	if _, err := os.Lstat(strings.TrimPrefix(address, "unix://")); err == nil {
		if err := peer(address, config); err != nil {
			return nil, errors.New("preexisting K2 socket has an unknown peer")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	actual := proto.Clone(parameters).(*bootapi.BootstrapParams)
	actual.SocketDir = &config.SocketRoot
	result, err := m.base.Start(ctx, actual)
	if err != nil {
		return nil, err
	}
	if result == nil || result.Address != address || result.Version != 3 || result.Protocol != "ttrpc" || peer(result.Address, config) != nil {
		return nil, errors.New("actual K2 bootstrap peer is unavailable")
	}
	return result, nil
}

func (*Manager) Stop(ctx context.Context, id string) (shim.StopStatus, error) {
	config, err := fixed(ctx)
	if err != nil {
		return shim.StopStatus{}, err
	}
	defer config.Close()
	inputs, err := birth.RecoverInputs(config.Inputs, id)
	if err != nil {
		return shim.StopStatus{}, err
	}
	defer inputs.Close()
	pid, err := runc.ReadPidFile(filepath.Join(inputs.Consumed.Bundle, process.InitPidFile))
	if err != nil || pid <= 0 {
		return shim.StopStatus{}, errors.New("original cleanup PID is unavailable")
	}
	actual := process.NewRunc(config.Inputs.RuncRoot, inputs.Consumed.Bundle, "k8s.io", config.Inputs.RuncPath, false)
	if err := actual.Delete(ctx, id, &runc.DeleteOpts{Force: true}); err != nil {
		return shim.StopStatus{}, err
	}
	if err := mount.UnmountRecursive(filepath.Join(inputs.Consumed.Bundle, "rootfs"), 0); err != nil {
		return shim.StopStatus{}, err
	}
	if err := inputs.CleanupDeleted(); err != nil {
		return shim.StopStatus{}, err
	}
	// This is the SDK's emergency cleanup status, never a source terminal receipt.
	return shim.StopStatus{Pid: pid, ExitStatus: 128 + int(unix.SIGKILL), ExitedAt: time.Now()}, nil
}

func (m *Manager) Info(ctx context.Context, reader io.Reader) (*types.RuntimeInfo, error) {
	config, err := fixedExecutables()
	if err != nil {
		return nil, err
	}
	defer config.Close()
	raw, err := io.ReadAll(io.LimitReader(reader, birth.MaxInputs+1))
	if err != nil || len(raw) > birth.MaxInputs {
		return nil, errors.New("actual K2 runtime options exceed their bound")
	}
	opts, err := shim.ReadRuntimeOptions[*options.Options](bytes.NewReader(raw))
	if err != nil || birth.ValidateOptions(config.Inputs, opts) != nil {
		return nil, errors.New("actual K2 runtime options differ")
	}
	result, err := m.base.Info(ctx, bytes.NewReader(raw))
	if err != nil || result == nil || result.Features == nil {
		return nil, errors.New("actual fixed K2 runc features are unavailable")
	}
	return result, nil
}
