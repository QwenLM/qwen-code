package cristate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	introspection "github.com/containerd/containerd/api/services/introspection/v1"
	rpc "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
	cri "k8s.io/cri-api/pkg/apis/runtime/v1"
)

// Inert decoded status/config data; no daemon, socket or native process fixture.
func config() map[string]any {
	return map[string]any{
		"containerdEndpoint": "/run/containerd/containerd.sock",
		"containerdRootDir":  "/var/lib/containerd",
		"rootDir":            "/var/lib/containerd/io.containerd.grpc.v1.cri",
		"stateDir":           "/run/containerd/io.containerd.grpc.v1.cri",
		"disableApparmor":    false, "enableSelinux": false, "enableCDI": false,
		"enableCRIU": false, "enableExperimentalRestoreViaCreate": false,
		"netnsMountsUnderStateDir": false,
		"containerd": map[string]any{"defaultRuntimeName": "runc", "runtimes": map[string]any{
			"runc": map[string]any{"runtimeType": "unrelated"},
			"qwen-k2-runc-v1": map[string]any{
				"runtimeType":    "io.containerd.runc.v2",
				"runtimePath":    "/opt/qwen-k2/bin/containerd-shim-qwen-k2-v1",
				"PodAnnotations": nil, "ContainerAnnotations": nil,
				"options":                         map[string]any{"BinaryName": "/opt/qwen-k2/bin/runc", "Root": "/run/qwen-k2/runc", "SystemdCgroup": true},
				"privileged_without_host_devices": false, "privileged_without_host_devices_all_devices_allowed": false,
				"cgroupWritable": false, "baseRuntimeSpec": "", "cniConfDir": "", "cniMaxConfNum": 0,
				"snapshotter": "overlayfs", "sandboxer": "podsandbox", "io_type": "",
			},
		}},
		"cni": map[string]any{"confDir": "/etc/cni/net.d"},
	}
}

func objectAt(value map[string]any, path ...string) map[string]any {
	for _, name := range path {
		value = value[name].(map[string]any)
	}
	return value
}

func status(t *testing.T, config map[string]any) *cri.StatusResponse {
	t.Helper()
	raw, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	return &cri.StatusResponse{
		Status: &cri.RuntimeStatus{Conditions: []*cri.RuntimeCondition{
			{Type: "RuntimeReady", Status: true},
			{Type: "NetworkReady", Status: false},
			{Type: "ContainerdHasNoDeprecationWarnings", Status: false},
		}},
		RuntimeHandlers: []*cri.RuntimeHandler{{Name: ""}, {Name: "runc"}, {Name: "qwen-k2-runc-v1"}},
		Info:            map[string]string{"config": string(raw), "golang": `"go1.27.2"`, "lastCNILoadStatus": "OK"},
	}
}

func TestSupportedUpstreamRepresentations(t *testing.T) {
	for _, ioType := range []string{"", "fifo"} {
		for _, array := range []any{nil, []any{}} {
			c := config()
			handler := objectAt(c, "containerd", "runtimes", "qwen-k2-runc-v1")
			handler["io_type"], handler["PodAnnotations"], handler["ContainerAnnotations"] = ioType, array, array
			if err := Check(status(t, c)); err != nil {
				t.Fatalf("supported representation refused: %q %v: %v", ioType, array, err)
			}
		}
	}
}

func TestEveryCheckedFieldRequiredAndTyped(t *testing.T) {
	paths := [][]string{
		{}, {"containerd", "runtimes", "qwen-k2-runc-v1"},
		{"containerd", "runtimes", "qwen-k2-runc-v1", "options"},
	}
	for _, path := range paths {
		for name := range objectAt(config(), path...) {
			if len(path) == 0 && (name == "containerd" || name == "cni") {
				continue
			}
			for _, mutation := range []string{"missing", "wrong-type", "wrong-case", "null"} {
				if mutation == "null" && (name == "PodAnnotations" || name == "ContainerAnnotations") {
					continue
				}
				t.Run(strings.Join(path, "/")+"/"+name+"/"+mutation, func(t *testing.T) {
					c := config()
					object := objectAt(c, path...)
					switch mutation {
					case "missing":
						delete(object, name)
					case "wrong-type":
						object[name] = []any{"wrong"}
					case "wrong-case":
						object[strings.ToUpper(name)] = object[name]
					case "null":
						object[name] = nil
					}
					if Check(status(t, c)) == nil {
						t.Fatal("invalid field accepted")
					}
				})
			}
		}
	}
}

func TestChangedSettingsAndStructureRefuse(t *testing.T) {
	mutations := map[string]func(map[string]any){
		"old-custom-type":       func(h map[string]any) { h["runtimeType"] = "io.containerd.qwen-k2.v1" },
		"standard-shim":         func(h map[string]any) { h["runtimePath"] = "/usr/bin/containerd-shim-runc-v2" },
		"inherited-snapshotter": func(h map[string]any) { h["snapshotter"] = "" },
		"base-spec":             func(h map[string]any) { h["baseRuntimeSpec"] = "/etc/custom.json" },
		"pod-annotation":        func(h map[string]any) { h["PodAnnotations"] = []any{"*"} },
		"container-annotation":  func(h map[string]any) { h["ContainerAnnotations"] = []any{"*"} },
		"cgroups":               func(h map[string]any) { h["cgroupWritable"] = true },
		"shim-sandbox":          func(h map[string]any) { h["sandboxer"] = "shim" },
		"streaming":             func(h map[string]any) { h["io_type"] = "streaming" },
		"extra-handler-field":   func(h map[string]any) { h["newField"] = false },
		"extra-options":         func(h map[string]any) { h["options"].(map[string]any)["ConfigPath"] = "/etc/override" },
		"binary":                func(h map[string]any) { h["options"].(map[string]any)["BinaryName"] = "/usr/bin/runc" },
		"root":                  func(h map[string]any) { h["options"].(map[string]any)["Root"] = "/run/runc" },
		"systemd":               func(h map[string]any) { h["options"].(map[string]any)["SystemdCgroup"] = false },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			c := config()
			mutate(objectAt(c, "containerd", "runtimes", "qwen-k2-runc-v1"))
			if Check(status(t, c)) == nil {
				t.Fatal("unsupported setting accepted")
			}
		})
	}
	for _, path := range [][]string{{"containerd"}, {"containerd", "runtimes"}, {"containerd", "runtimes", "qwen-k2-runc-v1"}} {
		for _, value := range []any{nil, "wrong", []any{}} {
			c := config()
			objectAt(c, path[:len(path)-1]...)[path[len(path)-1]] = value
			if Check(status(t, c)) == nil {
				t.Fatal("wrong object shape accepted")
			}
		}
	}
	for _, name := range []string{"disableApparmor", "enableSelinux", "enableCDI", "enableCRIU", "enableExperimentalRestoreViaCreate", "netnsMountsUnderStateDir"} {
		c := config()
		c[name] = true
		if Check(status(t, c)) == nil {
			t.Fatalf("unsupported global %s accepted", name)
		}
	}
}

func TestMalformedOrAmbiguousStatusRefuses(t *testing.T) {
	mutations := map[string]func(*cri.StatusResponse){
		"missing-status":     func(s *cri.StatusResponse) { s.Status = nil },
		"missing-conditions": func(s *cri.StatusResponse) { s.Status.Conditions = nil },
		"nil-condition":      func(s *cri.StatusResponse) { s.Status.Conditions[0] = nil },
		"nonready":           func(s *cri.StatusResponse) { s.Status.Conditions[0].Status = false },
		"missing-ready":      func(s *cri.StatusResponse) { s.Status.Conditions[0].Type = "other" },
		"duplicate-ready":    func(s *cri.StatusResponse) { s.Status.Conditions = append(s.Status.Conditions, s.Status.Conditions[0]) },
		"ambiguous-ready":    func(s *cri.StatusResponse) { s.Status.Conditions[0].Reason = "unknown" },
		"missing-handlers":   func(s *cri.StatusResponse) { s.RuntimeHandlers = nil },
		"missing-handler":    func(s *cri.StatusResponse) { s.RuntimeHandlers[2].Name = "other" },
		"nil-handler":        func(s *cri.StatusResponse) { s.RuntimeHandlers[2] = nil },
		"duplicate-handler":  func(s *cri.StatusResponse) { s.RuntimeHandlers = append(s.RuntimeHandlers, s.RuntimeHandlers[2]) },
		"missing-info":       func(s *cri.StatusResponse) { s.Info = nil },
		"missing-config":     func(s *cri.StatusResponse) { delete(s.Info, "config") },
		"large-response":     func(s *cri.StatusResponse) { s.Info["unrelated"] = strings.Repeat("x", 1<<20) },
	}
	if Check(nil) == nil {
		t.Fatal("nil response accepted")
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			s := status(t, config())
			mutate(s)
			if Check(s) == nil {
				t.Fatal("ambiguous status accepted")
			}
		})
	}
}

func TestMalformedConfigBytesRefuse(t *testing.T) {
	valid := status(t, config()).Info["config"]
	for _, raw := range []string{
		"", "null", "[]", "{}", valid + "{}", valid + " trailing",
		strings.Replace(valid, `"enableCDI":false`, `"enableCDI":false,"enableCDI":false`, 1),
		strings.Replace(valid, `"enableCDI":false`, `"enableCDI":false,"enable\u0043DI":true`, 1),
		strings.Replace(valid, `"cniMaxConfNum":0`, `"cniMaxConfNum":0.0`, 1),
		strings.Replace(valid, `"cniMaxConfNum":0`, `"cniMaxConfNum":null`, 1),
		strings.Replace(valid, `"confDir":"/etc/cni/net.d"`, `"confDir":"`+string([]byte{0xff})+`"`, 1),
		strings.Replace(valid, `"confDir":"/etc/cni/net.d"`, `"nested":`+strings.Repeat("[", 66)+"0"+strings.Repeat("]", 66), 1),
		strings.Repeat(" ", 1<<20) + valid,
	} {
		s := status(t, config())
		s.Info["config"] = raw
		if raw == valid || Check(s) == nil {
			t.Fatalf("malformed config not rejected: len=%d", len(raw))
		}
	}
}

func TestContainerBoundsAndIdentityAliases(t *testing.T) {
	for _, name := range []string{"conditions", "handlers", "info", "runtimes", "json-object", "json-array", "containerd-case", "runtimes-case", "handler-case", "endpoint", "root", "state"} {
		t.Run(name, func(t *testing.T) {
			c := config()
			s := status(t, c)
			switch name {
			case "conditions":
				for n := 0; n < 32; n++ {
					s.Status.Conditions = append(s.Status.Conditions, &cri.RuntimeCondition{Type: fmt.Sprint(n)})
				}
			case "handlers":
				for n := 0; n < 128; n++ {
					s.RuntimeHandlers = append(s.RuntimeHandlers, &cri.RuntimeHandler{Name: fmt.Sprint(n)})
				}
			case "info":
				for n := 0; n < 128; n++ {
					s.Info[fmt.Sprint(n)] = "OK"
				}
			default:
				switch name {
				case "runtimes":
					for n := 0; n < 128; n++ {
						objectAt(c, "containerd", "runtimes")[fmt.Sprint(n)] = nil
					}
				case "json-object":
					object := objectAt(c, "cni")
					for n := 0; n < 1024; n++ {
						object[fmt.Sprint(n)] = nil
					}
				case "json-array":
					c["unrelated"] = make([]any, 1025)
				case "containerd-case":
					c["Containerd"] = c["containerd"]
				case "runtimes-case":
					objectAt(c, "containerd")["Runtimes"] = objectAt(c, "containerd", "runtimes")
				case "handler-case":
					objectAt(c, "containerd", "runtimes")["QWEN-K2-RUNC-V1"] = objectAt(c, "containerd", "runtimes", "qwen-k2-runc-v1")
				case "endpoint":
					c["containerdEndpoint"] = "/run/other.sock"
				case "root":
					c["containerdRootDir"] = "/srv/containerd"
				case "state":
					c["stateDir"] = "/run/other/io.containerd.grpc.v1.cri"
				}
				s = status(t, c)
			}
			if Check(s) == nil {
				t.Fatal("unsupported boundary or alias accepted")
			}
		})
	}
}

type statusClient struct {
	cri.RuntimeServiceClient
	response *cri.StatusResponse
	err      error
	calls    int
	deadline time.Time
}

func (c *statusClient) Status(ctx context.Context, request *cri.StatusRequest, _ ...grpc.CallOption) (*cri.StatusResponse, error) {
	c.calls++
	deadline, ok := ctx.Deadline()
	c.deadline = deadline
	if !request.Verbose || !ok || time.Until(deadline) > 5*time.Second {
		return nil, errors.New("a bounded verbose request is required")
	}
	return c.response, c.err
}

const testSnapshotRoot = "/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots"

func pluginReply() *introspection.PluginInfoResponse {
	return &introspection.PluginInfoResponse{Plugin: &introspection.Plugin{
		Type: "io.containerd.snapshotter.v1", ID: "overlayfs",
		Exports: map[string]string{"root": "/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs"},
	}}
}

type pluginClient struct {
	introspection.IntrospectionClient
	response *introspection.PluginInfoResponse
	err      error
	calls    int
	status   *statusClient
}

func (c *pluginClient) PluginInfo(ctx context.Context, request *introspection.PluginInfoRequest, options ...grpc.CallOption) (*introspection.PluginInfoResponse, error) {
	c.calls++
	deadline, ok := ctx.Deadline()
	if !ok || time.Until(deadline) > 5*time.Second || c.status != nil && !deadline.Equal(c.status.deadline) || request.Type != "io.containerd.snapshotter.v1" || request.ID != "overlayfs" || request.Options != nil || len(options) != 1 {
		return nil, errors.New("the exact bounded original plugin query is required")
	}
	limit, ok := options[0].(grpc.MaxRecvMsgSizeCallOption)
	if !ok || limit.MaxRecvMsgSize != 32<<10 {
		return nil, errors.New("a 32 KiB receive bound is required")
	}
	return c.response, c.err
}

func TestOriginalSnapshotterMetadata(t *testing.T) {
	root := "/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs"
	if err := checkSnapshotter(pluginReply(), root); err != nil {
		t.Fatal(err)
	}
	mutations := map[string]func(*introspection.PluginInfoResponse){
		"missing-plugin":   func(r *introspection.PluginInfoResponse) { r.Plugin = nil },
		"wrong-type":       func(r *introspection.PluginInfoResponse) { r.Plugin.Type = "io.containerd.other.v1" },
		"wrong-id":         func(r *introspection.PluginInfoResponse) { r.Plugin.ID = "native" },
		"failed-init":      func(r *introspection.PluginInfoResponse) { r.Plugin.InitErr = &rpc.Status{Code: 2} },
		"empty-init-error": func(r *introspection.PluginInfoResponse) { r.Plugin.InitErr = &rpc.Status{} },
		"missing-exports":  func(r *introspection.PluginInfoResponse) { r.Plugin.Exports = nil },
		"missing-root":     func(r *introspection.PluginInfoResponse) { delete(r.Plugin.Exports, "root") },
		"empty-root":       func(r *introspection.PluginInfoResponse) { r.Plugin.Exports["root"] = "" },
		"root-override":    func(r *introspection.PluginInfoResponse) { r.Plugin.Exports["root"] = "/srv/overlay" },
		"snapshots-child":  func(r *introspection.PluginInfoResponse) { r.Plugin.Exports["root"] += "/snapshots" },
		"unclean-root": func(r *introspection.PluginInfoResponse) {
			r.Plugin.Exports["root"] += "/../io.containerd.snapshotter.v1.overlayfs"
		},
		"trailing-root": func(r *introspection.PluginInfoResponse) { r.Plugin.Exports["root"] += "/" },
		"root-case": func(r *introspection.PluginInfoResponse) {
			r.Plugin.Exports["Root"] = r.Plugin.Exports["root"]
			delete(r.Plugin.Exports, "root")
		},
		"case-alias":     func(r *introspection.PluginInfoResponse) { r.Plugin.Exports["Root"] = r.Plugin.Exports["root"] },
		"proxy":          func(r *introspection.PluginInfoResponse) { r.Plugin.Exports["address"] = "/run/external.sock" },
		"empty-proxy":    func(r *introspection.PluginInfoResponse) { r.Plugin.Exports["address"] = "" },
		"extra-export":   func(r *introspection.PluginInfoResponse) { r.Plugin.Exports["extra"] = "" },
		"extra-response": func(r *introspection.PluginInfoResponse) { r.Extra = &anypb.Any{} },
		"large-response": func(r *introspection.PluginInfoResponse) {
			r.Plugin.Capabilities = []string{strings.Repeat("x", 32<<10)}
		},
	}
	if checkSnapshotter(nil, root) == nil {
		t.Fatal("nil plugin response accepted")
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			r := pluginReply()
			mutate(r)
			if checkSnapshotter(r, root) == nil {
				t.Fatal("unsupported snapshotter metadata accepted")
			}
		})
	}
	r := pluginReply()
	r.Plugin.Capabilities = []string{strings.Repeat("x", 32<<10)}
	excess := proto.Size(r) - (32 << 10)
	r.Plugin.Capabilities[0] = r.Plugin.Capabilities[0][:len(r.Plugin.Capabilities[0])-excess]
	if proto.Size(r) != 32<<10 || checkSnapshotter(r, root) != nil {
		t.Fatal("exactly bounded metadata refused")
	}
}

func TestSnapshotterClientFailureIsPermanent(t *testing.T) {
	for _, failure := range []string{"rpc", "changed-root", "nil-response"} {
		t.Run(failure, func(t *testing.T) {
			client := &statusClient{response: status(t, config())}
			plugins := &pluginClient{response: pluginReply(), status: client}
			guard, err := Open(context.Background(), client, plugins, testSnapshotRoot)
			if err != nil || client.calls != 1 || plugins.calls != 1 {
				t.Fatal("original bounded queries failed", err)
			}
			switch failure {
			case "rpc":
				plugins.err = errors.New("original plugin metadata unavailable")
			case "changed-root":
				plugins.response.Plugin.Exports["root"] = "/srv/other"
			case "nil-response":
				plugins.response = nil
			}
			if guard.Verify() == nil || client.calls != 2 || plugins.calls != 2 {
				t.Fatal("failed plugin observation accepted")
			}
			plugins.err, plugins.response = nil, pluginReply()
			if guard.Verify() == nil || client.calls != 2 || plugins.calls != 2 {
				t.Fatal("failed plugin guard reacquired a baseline")
			}
		})
	}
}

func TestInvalidSnapshotterInputsBeforeRPC(t *testing.T) {
	client := &statusClient{response: status(t, config())}
	plugins := &pluginClient{response: pluginReply()}
	for _, root := range []string{"", "/srv/overlay/snapshots", testSnapshotRoot + "/"} {
		if guard, err := Open(context.Background(), client, plugins, root); guard != nil || err == nil {
			t.Fatal("unsupported expected root accepted")
		}
	}
	if g, err := Open(nil, client, plugins, testSnapshotRoot); g != nil || err == nil {
		t.Fatal("nil lifetime accepted")
	}
	if g, err := Open(context.Background(), nil, plugins, testSnapshotRoot); g != nil || err == nil {
		t.Fatal("nil CRI client accepted")
	}
	if g, err := Open(context.Background(), client, nil, testSnapshotRoot); g != nil || err == nil {
		t.Fatal("nil plugin client accepted")
	}
	if client.calls != 0 || plugins.calls != 0 {
		t.Fatal("invalid inputs made an RPC")
	}
}

func TestOriginalClientFailureIsPermanent(t *testing.T) {
	client := &statusClient{response: status(t, config())}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	plugins := &pluginClient{response: pluginReply()}
	guard, err := Open(ctx, client, plugins, testSnapshotRoot)
	if err != nil || client.calls != 1 || guard.Verify() != nil || client.calls != 2 {
		t.Fatalf("initial/ongoing verification failed: calls=%d err=%v", client.calls, err)
	}
	client.err = errors.New("original status unavailable")
	if guard.Verify() == nil || client.calls != 3 {
		t.Fatal("failed status accepted")
	}
	client.err = nil
	if guard.Verify() == nil || client.calls != 3 {
		t.Fatal("failed client reacquired a baseline")
	}
	client = &statusClient{response: status(t, config())}
	guard, err = Open(ctx, client, plugins, testSnapshotRoot)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if guard.Verify() == nil || client.calls != 1 {
		t.Fatal("cancelled lifetime still called the client")
	}
	if g, err := Open(context.Background(), &statusClient{}, plugins, testSnapshotRoot); g != nil || err == nil {
		t.Fatal("invalid initial status accepted")
	}
	client = &statusClient{response: status(t, config())}
	guard, err = Open(context.Background(), client, plugins, testSnapshotRoot)
	if err != nil {
		t.Fatal(err)
	}
	client.response.Info["config"] = "{}"
	if guard.Verify() == nil || client.calls != 2 {
		t.Fatal("changed effective configuration accepted")
	}
	client.response = status(t, config())
	if guard.Verify() == nil || client.calls != 2 {
		t.Fatal("configuration failure was reset by a later good reading")
	}
}
