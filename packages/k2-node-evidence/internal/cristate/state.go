// Package cristate checks sampled effective CRI settings, not installation or
// release authority. Its client is the caller's already held original client.
package cristate

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"path"
	"reflect"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/nriobserver"
	introspection "github.com/containerd/containerd/api/services/introspection/v1"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
	cri "k8s.io/cri-api/pkg/apis/runtime/v1"
)

const maxStatusBytes = 1 << 20
const handlerName = "qwen-k2-runc-v1"
const maxPluginBytes = 32 << 10

type Guard struct {
	mu       sync.Mutex
	client   cri.RuntimeServiceClient
	plugins  introspection.IntrospectionClient
	root     string
	lifetime context.Context
	failed   bool
}

func Open(ctx context.Context, client cri.RuntimeServiceClient, plugins introspection.IntrospectionClient, snapshotRoot string) (*Guard, error) {
	if ctx == nil || client == nil || plugins == nil || snapshotRoot != "/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots" {
		return nil, errors.New("original runtime clients, validated snapshot root and lifetime are required")
	}
	g := &Guard{client: client, plugins: plugins, root: path.Dir(snapshotRoot), lifetime: ctx}
	if err := g.Verify(); err != nil {
		return nil, err
	}
	return g, nil
}

func (g *Guard) Verify() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.failed || g.lifetime.Err() != nil {
		g.failed = true
		return errors.New("original effective CRI configuration is unavailable")
	}
	ctx, cancel := context.WithTimeout(g.lifetime, 5*time.Second)
	defer cancel()
	status, err := g.client.Status(ctx, &cri.StatusRequest{Verbose: true}, grpc.MaxCallRecvMsgSize(maxStatusBytes))
	if err != nil || Check(status) != nil || ctx.Err() != nil {
		g.failed = true
		return errors.New("original effective CRI configuration differs or was lost")
	}
	plugin, err := g.plugins.PluginInfo(ctx, &introspection.PluginInfoRequest{Type: "io.containerd.snapshotter.v1", ID: "overlayfs"}, grpc.MaxCallRecvMsgSize(maxPluginBytes))
	if err != nil || checkSnapshotter(plugin, g.root) != nil || ctx.Err() != nil {
		g.failed = true
		return errors.New("original effective snapshotter root differs or was lost")
	}
	if err := nriobserver.Observe(ctx, g.plugins); err != nil {
		g.failed = true
		return errors.New("original effective NRI state differs or was lost")
	}
	return nil
}

func checkSnapshotter(reply *introspection.PluginInfoResponse, root string) error {
	if reply == nil || proto.Size(reply) > maxPluginBytes || reply.Plugin == nil || reply.Extra != nil {
		return errors.New("bounded original snapshotter metadata is required")
	}
	p := reply.Plugin
	// Pinned upstream proxy plugins always export address, even when empty.
	if p.Type != "io.containerd.snapshotter.v1" || p.ID != "overlayfs" || p.InitErr != nil || len(p.Exports) != 1 || p.Exports["root"] != root {
		return errors.New("original builtin snapshotter root differs")
	}
	return nil
}

func Check(status *cri.StatusResponse) error {
	if status == nil || proto.Size(status) > maxStatusBytes || status.Status == nil || len(status.Status.Conditions) == 0 || len(status.Status.Conditions) > 32 ||
		len(status.RuntimeHandlers) == 0 || len(status.RuntimeHandlers) > 128 || len(status.Info) > 128 {
		return errors.New("bounded original CRI status is required")
	}
	conditions := make(map[string]bool)
	for _, condition := range status.Status.Conditions {
		if condition == nil || condition.Type == "" || len(condition.Type) > 128 || conditions[condition.Type] {
			return errors.New("original CRI readiness is ambiguous")
		}
		conditions[condition.Type] = true
		if condition.Type == "RuntimeReady" && (!condition.Status || condition.Reason != "" || condition.Message != "") {
			return errors.New("original CRI is not ready")
		}
	}
	if !conditions["RuntimeReady"] {
		return errors.New("original CRI readiness is missing")
	}
	handlers := make(map[string]bool)
	for _, handler := range status.RuntimeHandlers {
		if handler == nil || len(handler.Name) > 128 || handlers[handler.Name] {
			return errors.New("original CRI handlers are ambiguous")
		}
		handlers[handler.Name] = true
	}
	if !handlers[handlerName] {
		return errors.New("original CRI handler is missing")
	}
	raw := status.Info["config"]
	if len(raw) == 0 || len(raw) > maxStatusBytes || !utf8.ValidString(raw) {
		return errors.New("original CRI configuration exceeds its bound")
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	value, err := readValue(decoder, 0)
	if err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("original CRI configuration has trailing data")
	}
	root, _ := value.(map[string]any)
	containerd, _ := root["containerd"].(map[string]any)
	runtimes, _ := containerd["runtimes"].(map[string]any)
	handler, _ := runtimes[handlerName].(map[string]any)
	if len(runtimes) == 0 || len(runtimes) > 128 || handler == nil {
		return errors.New("original effective handler configuration is missing")
	}
	if err := require(root, map[string]any{
		"containerd":         containerd,
		"containerdEndpoint": "/run/containerd/containerd.sock",
		"containerdRootDir":  "/var/lib/containerd",
		"rootDir":            "/var/lib/containerd/io.containerd.grpc.v1.cri",
		"stateDir":           "/run/containerd/io.containerd.grpc.v1.cri",
		"disableApparmor":    false, "enableSelinux": false, "enableCDI": false,
		"enableCRIU": false, "enableExperimentalRestoreViaCreate": false,
		"netnsMountsUnderStateDir": false,
	}, false); err != nil {
		return err
	}
	if err := require(containerd, map[string]any{"runtimes": runtimes}, false); err != nil {
		return err
	}
	if err := require(runtimes, map[string]any{handlerName: handler}, false); err != nil {
		return err
	}
	for _, name := range []string{"PodAnnotations", "ContainerAnnotations"} {
		value, present := handler[name]
		array, isArray := value.([]any)
		if !present || value != nil && (!isArray || len(array) != 0) {
			return errors.New("original handler annotation pass-through differs")
		}
	}
	ioType, ok := handler["io_type"].(string)
	if !ok || ioType != "" && ioType != "fifo" {
		return errors.New("original handler IO type differs")
	}
	options, _ := handler["options"].(map[string]any)
	if err := require(options, map[string]any{
		"BinaryName": "/opt/qwen-k2/bin/runc", "Root": "/run/qwen-k2/runc", "SystemdCgroup": true,
	}, true); err != nil {
		return err
	}
	return require(handler, map[string]any{
		"runtimeType": "io.containerd.runc.v2", "runtimePath": "/opt/qwen-k2/bin/containerd-shim-qwen-k2-v1",
		"PodAnnotations": handler["PodAnnotations"], "ContainerAnnotations": handler["ContainerAnnotations"], "options": options,
		"privileged_without_host_devices": false, "privileged_without_host_devices_all_devices_allowed": false,
		"cgroupWritable": false, "baseRuntimeSpec": "", "cniConfDir": "", "cniMaxConfNum": json.Number("0"),
		"snapshotter": "overlayfs", "sandboxer": "podsandbox", "io_type": ioType,
	}, true)
}

func require(actual, expected map[string]any, closed bool) error {
	if actual == nil || closed && len(actual) != len(expected) {
		return errors.New("original effective configuration fields differ")
	}
	for name := range actual {
		for canonical := range expected {
			if name != canonical && strings.EqualFold(name, canonical) {
				return errors.New("original effective configuration field case differs")
			}
		}
	}
	for name, want := range expected {
		if value, present := actual[name]; !present || !reflect.DeepEqual(value, want) {
			return errors.New("original effective configuration value differs")
		}
	}
	return nil
}

// Build the bounded value tree once, rejecting duplicate decoded keys before
// they can be collapsed into a map. Unknown root/CNI data is never authority.
func readValue(decoder *json.Decoder, depth int) (any, error) {
	if depth > 64 {
		return nil, errors.New("effective CRI configuration nesting exceeds its bound")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, errors.New("invalid effective CRI configuration JSON")
	}
	delimiter, container := token.(json.Delim)
	if !container {
		return token, nil
	}
	if delimiter != '{' && delimiter != '[' {
		return nil, errors.New("invalid effective CRI configuration container")
	}
	object := make(map[string]any)
	array := make([]any, 0)
	for count := 0; decoder.More(); count++ {
		if count >= 1024 {
			return nil, errors.New("effective CRI configuration container exceeds its bound")
		}
		var key string
		if delimiter == '{' {
			token, err := decoder.Token()
			var ok bool
			key, ok = token.(string)
			if _, present := object[key]; err != nil || !ok || present {
				return nil, errors.New("duplicate or invalid effective CRI configuration key")
			}
		}
		value, err := readValue(decoder, depth+1)
		if err != nil {
			return nil, err
		}
		if delimiter == '{' {
			object[key] = value
		} else {
			array = append(array, value)
		}
	}
	end, err := decoder.Token()
	if err != nil || delimiter == '{' && end != json.Delim('}') || delimiter == '[' && end != json.Delim(']') {
		return nil, errors.New("invalid effective CRI configuration terminator")
	}
	if delimiter == '{' {
		return object, nil
	}
	return array, nil
}
