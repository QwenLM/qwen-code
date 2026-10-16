//go:build linux

package shimplugin

import (
	"context"
	"errors"
	"os"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/taskboundary"
	"github.com/containerd/containerd/v2/cmd/containerd-shim-runc-v2/task"
	"github.com/containerd/containerd/v2/pkg/shim"
	"github.com/containerd/containerd/v2/pkg/shutdown"
	"github.com/containerd/containerd/v2/plugins"
	"github.com/containerd/plugin"
	"github.com/containerd/plugin/registry"
)

func init() {
	registry.Register(&plugin.Registration{
		Type:     plugins.TTRPCPlugin,
		ID:       "task",
		Requires: []plugin.Type{plugins.EventPlugin, plugins.InternalPlugin},
		InitFn: func(ic *plugin.InitContext) (any, error) {
			config, err := birth.LoadShimConfig()
			if err != nil {
				return nil, err
			}
			self, err := os.Executable()
			if err != nil || self != config.ShimPath || birth.VerifyExecutable(self, config.ShimSHA256) != nil || birth.VerifyExecutable(config.Inputs.RuncPath, config.Inputs.RuncSHA256) != nil {
				config.Close()
				return nil, errors.New("actual shim or runc executable differs from the fixed handler")
			}
			publisher, err := ic.GetByID(plugins.EventPlugin, "publisher")
			if err != nil {
				config.Close()
				return nil, err
			}
			lifetime, err := ic.GetByID(plugins.InternalPlugin, "shutdown")
			if err != nil {
				config.Close()
				return nil, err
			}
			pub, publisherOK := publisher.(shim.Publisher)
			sd, shutdownOK := lifetime.(shutdown.Service)
			if !publisherOK || !shutdownOK {
				config.Close()
				return nil, errors.New("actual SDK publisher and shutdown service are required")
			}
			producer, err := birth.NewProducer(config.Inputs, config.SourceSocket, config.SourceSHA256, config.Contract())
			if err != nil {
				config.Close()
				return nil, err
			}
			sd.RegisterCallback(func(context.Context) error { return errors.Join(producer.Close(), config.Close()) })
			base, err := task.NewTaskService(ic.Context, pub, sd)
			if err != nil {
				return nil, errors.Join(err, producer.Close(), config.Close())
			}
			return taskboundary.New(base, producer)
		},
	})
}
