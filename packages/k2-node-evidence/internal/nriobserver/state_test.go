package nriobserver

import (
	"context"
	"errors"
	"strings"
	"testing"

	introspection "github.com/containerd/containerd/api/services/introspection/v1"
	"github.com/containerd/containerd/v2/plugins"
	"github.com/containerd/errdefs"
	"github.com/containerd/plugin"
	"github.com/containerd/typeurl/v2"
	rpc "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// This mutable read-counter is an interface fixture, not a native NRI instance.
type nriFixture struct {
	enabled bool
	calls   int
}

func (n *nriFixture) IsEnabled() bool {
	n.calls++
	return n.enabled
}

func addFixture(t *testing.T, set *plugin.Set, id string, value any, err error) {
	t.Helper()
	r := plugin.Registration{Type: plugins.NRIApiPlugin, ID: id,
		InitFn: func(*plugin.InitContext) (any, error) { return value, err },
	}
	if err := set.Add(r.Init(plugin.NewContext(context.Background(), set, nil))); err != nil {
		t.Fatal(err)
	}
}

func TestObserverRetainsAndReadsOriginalObject(t *testing.T) {
	set := plugin.NewPluginSet()
	nri := &nriFixture{}
	addFixture(t, set, "nri", nri, nil)
	r := Registration()
	if r.Type != "io.qwen.k2.nri-state.v1" || r.ID != "state" || r.Config != nil ||
		len(r.Requires) != 1 || r.Requires[0] != plugins.NRIApiPlugin {
		t.Fatal("observer registration contract differs")
	}
	initialized := r.Init(plugin.NewContext(context.Background(), set, nil))
	instance, err := initialized.Instance()
	if err != nil || nri.calls != 0 {
		t.Fatal("observer must retain, not sample, the initialization object", err)
	}
	observer := instance.(*state)
	for i, enabled := range []bool{false, true, false} {
		nri.enabled = enabled
		result, err := observer.PluginInfo(context.Background(), &emptypb.Empty{})
		if err != nil || result.(*wrapperspb.BoolValue).Value != enabled || nri.calls != i+1 {
			t.Fatal("observer did not re-read the original instance", result, err)
		}
	}
	unknown := &emptypb.Empty{}
	unknown.ProtoReflect().SetUnknown([]byte{0x08, 0x01})
	for _, options := range []any{nil, (*emptypb.Empty)(nil), &wrapperspb.BoolValue{}, unknown} {
		if _, err := observer.PluginInfo(context.Background(), options); !errors.Is(err, errdefs.ErrInvalidArgument) || nri.calls != 3 {
			t.Fatal("invalid options sampled NRI or were accepted", err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := observer.PluginInfo(ctx, &emptypb.Empty{}); !errors.Is(err, context.Canceled) || nri.calls != 3 {
		t.Fatal("canceled observation sampled NRI or was accepted", err)
	}
}

func TestObserverRejectsUnavailableOrAmbiguousInstances(t *testing.T) {
	for _, failure := range []string{"missing", "wrong-id", "nil-instance", "wrong-interface", "failed", "skipped", "ambiguous", "failed-other"} {
		t.Run(failure, func(t *testing.T) {
			set := plugin.NewPluginSet()
			switch failure {
			case "wrong-id":
				addFixture(t, set, "other", &nriFixture{}, nil)
			case "nil-instance":
				addFixture(t, set, "nri", nil, nil)
			case "wrong-interface":
				addFixture(t, set, "nri", struct{}{}, nil)
			case "failed":
				addFixture(t, set, "nri", &nriFixture{}, errors.New("init failed"))
			case "skipped":
				addFixture(t, set, "nri", &nriFixture{}, plugin.ErrSkipPlugin)
			case "ambiguous", "failed-other":
				addFixture(t, set, "nri", &nriFixture{}, nil)
				var err error
				if failure == "failed-other" {
					err = errors.New("other init failed")
				}
				addFixture(t, set, "other", &nriFixture{}, err)
			}
			if p := Registration().Init(plugin.NewContext(context.Background(), set, nil)); p.Err() == nil {
				t.Fatal("unsupported original NRI selection accepted")
			}
		})
	}
}

type replyFixture struct {
	introspection.IntrospectionClient
	t       *testing.T
	reply   *introspection.PluginInfoResponse
	err     error
	onQuery func()
}

func (c *replyFixture) PluginInfo(ctx context.Context, request *introspection.PluginInfoRequest, options ...grpc.CallOption) (*introspection.PluginInfoResponse, error) {
	c.t.Helper()
	if request.Type != "io.qwen.k2.nri-state.v1" || request.ID != "state" || request.Options == nil ||
		request.Options.TypeUrl != "google.protobuf.Empty" || len(request.Options.Value) != 0 || len(options) != 1 {
		c.t.Fatal("original NRI request contract differs")
	}
	limit, ok := options[0].(grpc.MaxRecvMsgSizeCallOption)
	if !ok || limit.MaxRecvMsgSize != 32<<10 {
		c.t.Fatal("NRI receive bound differs")
	}
	if c.onQuery != nil {
		c.onQuery()
	}
	return c.reply, c.err
}

func disabledReply() *introspection.PluginInfoResponse {
	return &introspection.PluginInfoResponse{
		Plugin: &introspection.Plugin{Type: "io.qwen.k2.nri-state.v1", ID: "state"},
		Extra:  &anypb.Any{TypeUrl: "google.protobuf.BoolValue"},
	}
}

func TestClosedBoundedNRIReply(t *testing.T) {
	reply := disabledReply()
	actual, err := typeurl.MarshalAnyToProto(wrapperspb.Bool(false))
	if err != nil || !proto.Equal(actual, reply.Extra) || len(actual.Value) != 0 {
		t.Fatal("false must have a present typed extra with a valid empty body", actual, err)
	}
	if err := Observe(context.Background(), &replyFixture{t: t, reply: reply}); err != nil {
		t.Fatal(err)
	}
	mutations := map[string]func(*introspection.PluginInfoResponse){
		"missing-plugin":   func(r *introspection.PluginInfoResponse) { r.Plugin = nil },
		"wrong-type":       func(r *introspection.PluginInfoResponse) { r.Plugin.Type = "io.containerd.nri.v1" },
		"wrong-id":         func(r *introspection.PluginInfoResponse) { r.Plugin.ID = "other" },
		"init-error":       func(r *introspection.PluginInfoResponse) { r.Plugin.InitErr = &rpc.Status{Code: 2} },
		"empty-init-error": func(r *introspection.PluginInfoResponse) { r.Plugin.InitErr = &rpc.Status{} },
		"missing-extra":    func(r *introspection.PluginInfoResponse) { r.Extra = nil },
		"wrong-extra-type": func(r *introspection.PluginInfoResponse) { r.Extra.TypeUrl = "google.protobuf.Empty" },
		"prefixed-extra-type": func(r *introspection.PluginInfoResponse) {
			r.Extra.TypeUrl = "type.googleapis.com/google.protobuf.BoolValue"
		},
		"empty-extra-type":       func(r *introspection.PluginInfoResponse) { r.Extra.TypeUrl = "" },
		"malformed-extra":        func(r *introspection.PluginInfoResponse) { r.Extra.Value = []byte{0x80} },
		"enabled":                func(r *introspection.PluginInfoResponse) { r.Extra.Value = []byte{0x08, 0x01} },
		"unknown-value-field":    func(r *introspection.PluginInfoResponse) { r.Extra.Value = []byte{0x10, 0x00} },
		"unknown-envelope-field": func(r *introspection.PluginInfoResponse) { r.Extra.ProtoReflect().SetUnknown([]byte{0x18, 0x00}) },
		"oversized": func(r *introspection.PluginInfoResponse) {
			r.Plugin.Capabilities = []string{strings.Repeat("x", 32<<10)}
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			r := disabledReply()
			mutate(r)
			if Observe(context.Background(), &replyFixture{t: t, reply: r}) == nil {
				t.Fatal("unsupported NRI observation accepted")
			}
		})
	}
	if Observe(context.Background(), &replyFixture{t: t}) == nil ||
		Observe(context.Background(), &replyFixture{t: t, reply: disabledReply(), err: errors.New("lost original client")}) == nil {
		t.Fatal("unavailable NRI observation accepted")
	}
	r := disabledReply()
	r.Plugin.Capabilities = []string{strings.Repeat("x", 32<<10)}
	excess := proto.Size(r) - (32 << 10)
	r.Plugin.Capabilities[0] = r.Plugin.Capabilities[0][:len(r.Plugin.Capabilities[0])-excess]
	if proto.Size(r) != 32<<10 || Observe(context.Background(), &replyFixture{t: t, reply: r}) != nil {
		t.Fatal("exactly bounded NRI observation refused")
	}
	ctx, cancel := context.WithCancel(context.Background())
	if Observe(ctx, &replyFixture{t: t, reply: disabledReply(), onQuery: cancel}) == nil {
		t.Fatal("cancellation during RPC accepted")
	}
}
