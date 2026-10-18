package cristate

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/nriobserver"
	introspection "github.com/containerd/containerd/api/services/introspection/v1"
	serverconfig "github.com/containerd/containerd/v2/cmd/containerd/server/config"
	"github.com/containerd/containerd/v2/plugins"
	_ "github.com/containerd/containerd/v2/plugins/nri"
	"github.com/containerd/containerd/v2/plugins/services"
	_ "github.com/containerd/containerd/v2/plugins/services/introspection"
	_ "github.com/containerd/containerd/v2/plugins/services/warning"
	"github.com/containerd/plugin"
	"github.com/containerd/plugin/registry"
	"github.com/containerd/typeurl/v2"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/wrapperspb"
	cri "k8s.io/cri-api/pkg/apis/runtime/v1"
)

func upstreamRegistration(t *testing.T, kind plugin.Type, id string) plugin.Registration {
	t.Helper()
	var found []plugin.Registration
	for _, r := range registry.Graph(nil) {
		if r.Type == kind && r.ID == id {
			found = append(found, r)
		}
	}
	if len(found) != 1 {
		t.Fatalf("expected one upstream registration for %s.%s", kind, id)
	}
	return found[0]
}

func initialize(t *testing.T, set *plugin.Set, r plugin.Registration, config any) any {
	t.Helper()
	ic := plugin.NewContext(context.Background(), set, nil)
	ic.Config = config
	p := r.Init(ic)
	instance, err := p.Instance()
	if err != nil {
		t.Fatal(err)
	}
	if err := set.Add(p); err != nil {
		t.Fatal(err)
	}
	return instance
}

type statusFixture struct {
	cri.UnimplementedRuntimeServiceServer
	response *cri.StatusResponse
}

func (s *statusFixture) Status(context.Context, *cri.StatusRequest) (*cri.StatusResponse, error) {
	return s.response, nil
}

// Only Status and overlay metadata are inert fixtures. NRI initialization,
// observer, upstream introspection service and gRPC serialization are real.
func TestActualUpstreamNRIThroughOriginalConnection(t *testing.T) {
	nriRegistration := upstreamRegistration(t, plugins.NRIApiPlugin, "nri")
	defaults, err := json.Marshal(nriRegistration.Config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		after, err := json.Marshal(nriRegistration.Config)
		if err != nil || string(after) != string(defaults) {
			t.Error("global upstream NRI registration defaults changed", err)
		}
	})
	for _, test := range []struct {
		name     string
		disable  bool
		observer bool
	}{
		{"stock-disabled", true, false},
		{"observed-disabled", true, true},
		{"observed-enabled", false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			set := plugin.NewPluginSet()
			nriConfig := reflect.New(reflect.TypeOf(nriRegistration.Config).Elem()).Interface()
			if err := json.Unmarshal(defaults, nriConfig); err != nil {
				t.Fatal(err)
			}
			declaration := serverconfig.Config{Plugins: map[string]any{
				nriRegistration.URI(): map[string]any{"disable": test.disable},
			}}
			decoded, err := declaration.Decode(context.Background(), nriRegistration.URI(), nriConfig)
			if err != nil {
				t.Fatal(err)
			}
			initialize(t, set, upstreamRegistration(t, plugins.WarningPlugin, plugins.DeprecationsPlugin), nil)
			nri := initialize(t, set, nriRegistration, decoded).(interface{ IsEnabled() bool })
			if nri.IsEnabled() == test.disable {
				t.Fatal("actual upstream NRI initializer differs from its decoded configuration")
			}
			if test.observer {
				initialize(t, set, *nriobserver.Registration(), nil)
			}
			initialize(t, set, plugin.Registration{Type: plugins.SnapshotPlugin, ID: "overlayfs",
				InitFn: func(ic *plugin.InitContext) (any, error) {
					ic.Meta.Exports["root"] = "/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs"
					return struct{}{}, nil
				}}, nil)
			initialize(t, set, upstreamRegistration(t, plugins.ServicePlugin, services.IntrospectionService), nil)
			registrar := initialize(t, set, upstreamRegistration(t, plugins.GRPCPlugin, "introspection"), nil).(interface{ Register(*grpc.Server) error })
			listener := bufconn.Listen(1 << 20)
			server := grpc.NewServer()
			if err := registrar.Register(server); err != nil {
				t.Fatal(err)
			}
			cri.RegisterRuntimeServiceServer(server, &statusFixture{response: status(t, config())})
			done := make(chan error, 1)
			go func() { done <- server.Serve(listener) }()
			t.Cleanup(func() {
				server.Stop()
				_ = listener.Close()
				select {
				case err := <-done:
					if err != nil && !errors.Is(err, grpc.ErrServerStopped) && !errors.Is(err, net.ErrClosed) {
						t.Error("in-memory server cleanup failed", err)
					}
				case <-time.After(5 * time.Second):
					t.Error("in-memory server cleanup timed out")
				}
			})
			var dials atomic.Int32
			conn, err := grpc.NewClient("passthrough:///k2-nri-memory", grpc.WithTransportCredentials(insecure.NewCredentials()),
				grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
					dials.Add(1)
					return listener.DialContext(ctx)
				}))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = conn.Close() })
			client := introspection.NewIntrospectionClient(conn)
			if test.observer {
				options, err := typeurl.MarshalAnyToProto(&emptypb.Empty{})
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				reply, err := client.PluginInfo(ctx, &introspection.PluginInfoRequest{Type: "io.qwen.k2.nri-state.v1", ID: "state", Options: options})
				if err != nil || reply.Extra == nil || reply.Extra.TypeUrl != "google.protobuf.BoolValue" {
					t.Fatal("actual observer-to-upstream-wire reply failed", reply, err)
				}
				value, err := typeurl.UnmarshalAny(reply.Extra)
				if err != nil || value.(*wrapperspb.BoolValue).Value == test.disable || test.disable && len(reply.Extra.Value) != 0 {
					t.Fatal("actual NRI value or false empty body lost through wire", value, err)
				}
			}
			guard, err := Open(context.Background(), cri.NewRuntimeServiceClient(conn), client, testSnapshotRoot)
			wantPass := test.observer && test.disable
			if (err == nil) != wantPass || (guard != nil) != wantPass {
				t.Fatalf("actual chain pass=%v, want=%v: %v", err == nil, wantPass, err)
			}
			if wantPass {
				if err := guard.Verify(); err != nil {
					t.Fatal(err)
				}
				if err := conn.Close(); err != nil || guard.Verify() == nil || guard.Verify() == nil {
					t.Fatal("lost original connection did not permanently refuse", err)
				}
			}
			if dials.Load() != 1 {
				t.Fatal("original in-memory connection was replaced", dials.Load())
			}
		})
	}
}
