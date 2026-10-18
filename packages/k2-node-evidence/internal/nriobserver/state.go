// Package nriobserver exposes sampled state of the original daemon's NRI object.
package nriobserver

import (
	"context"
	"errors"

	introspection "github.com/containerd/containerd/api/services/introspection/v1"
	"github.com/containerd/containerd/v2/plugins"
	"github.com/containerd/errdefs"
	"github.com/containerd/plugin"
	"github.com/containerd/typeurl/v2"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

const (
	observerType  plugin.Type = "io.qwen.k2.nri-state.v1"
	observerID                = "state"
	maxReplyBytes             = 32 << 10
)

type state struct {
	nri interface{ IsEnabled() bool }
}

func Registration() *plugin.Registration {
	return &plugin.Registration{
		Type: observerType, ID: observerID,
		Requires: []plugin.Type{plugins.NRIApiPlugin},
		InitFn: func(ic *plugin.InitContext) (any, error) {
			instances, err := ic.GetByType(plugins.NRIApiPlugin)
			if err != nil || len(instances) != 1 {
				return nil, errors.New("one original NRI instance is required")
			}
			instance, err := ic.GetByID(plugins.NRIApiPlugin, "nri")
			if err != nil {
				return nil, err
			}
			nri, ok := instance.(interface{ IsEnabled() bool })
			if !ok {
				return nil, errors.New("original NRI state is unavailable")
			}
			return &state{nri: nri}, nil
		},
	}
}

func (s *state) PluginInfo(ctx context.Context, options any) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	empty, ok := options.(*emptypb.Empty)
	if !ok || empty == nil || len(empty.ProtoReflect().GetUnknown()) != 0 {
		return nil, errdefs.ErrInvalidArgument
	}
	enabled := s.nri.IsEnabled()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return wrapperspb.Bool(enabled), nil
}

func Observe(ctx context.Context, client introspection.IntrospectionClient) error {
	options, err := typeurl.MarshalAnyToProto(&emptypb.Empty{})
	if err != nil {
		return err
	}
	reply, err := client.PluginInfo(ctx, &introspection.PluginInfoRequest{
		Type: string(observerType), ID: observerID, Options: options,
	}, grpc.MaxCallRecvMsgSize(maxReplyBytes))
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if reply == nil || proto.Size(reply) > maxReplyBytes || reply.Plugin == nil ||
		reply.Plugin.Type != string(observerType) || reply.Plugin.ID != observerID || reply.Plugin.InitErr != nil ||
		reply.Extra == nil || reply.Extra.TypeUrl != "google.protobuf.BoolValue" || len(reply.Extra.ProtoReflect().GetUnknown()) != 0 {
		return errors.New("bounded original NRI observation is required")
	}
	value, err := typeurl.UnmarshalAny(reply.Extra)
	if err != nil {
		return err
	}
	enabled, ok := value.(*wrapperspb.BoolValue)
	if !ok || enabled == nil || len(enabled.ProtoReflect().GetUnknown()) != 0 || enabled.Value {
		return errors.New("original NRI is enabled or its state is unavailable")
	}
	return nil
}
