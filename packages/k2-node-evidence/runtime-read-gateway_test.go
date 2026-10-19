package main

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	containers "github.com/containerd/containerd/api/services/containers/v1"
	tasks "github.com/containerd/containerd/api/services/tasks/v1"
	tasktypes "github.com/containerd/containerd/api/types/task"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	grpcstatus "google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/timestamppb"
	cri "k8s.io/cri-api/pkg/apis/runtime/v1"
)

type gatewayFixture struct {
	mu                        sync.Mutex
	t                         *testing.T
	state                     tasktypes.Status
	criState                  cri.ContainerState
	pid                       uint32
	removed, absent, extra    bool
	image                     string
	getError, waitError       codes.Code
	stamp                     *timestamppb.Timestamp
	finishedAt                int64
	exited, started, waitDone chan struct{}
	waitCalls                 int
	listedUID                 string
	nilListMetadata           bool
	cancelRead                context.CancelFunc
	metadata                  *containers.Container
	metadataError             codes.Code
}

type gatewayTaskFixture struct {
	tasks.TasksClient
	fixture *gatewayFixture
}
type gatewayCriFixture struct {
	cri.RuntimeServiceClient
	fixture *gatewayFixture
}
type gatewayMetadataFixture struct {
	containers.ContainersClient
	fixture *gatewayFixture
}

var gatewayTask = registeredTask{ArmID: "owned-arm", Namespace: "owned-evidence", PodName: "worker", PodUID: "original-uid", ImageDigest: strings.Repeat("c", 64)}
var gatewayCID, gatewaySID = strings.Repeat("a", 64), strings.Repeat("b", 64)

const gatewayOCISpec = `{"ociVersion":"1.2.0","process":{"apparmorProfile":"qwen-k2-worker-v1","noNewPrivileges":true,"user":{"uid":1000,"gid":1000,"additionalGids":[1000]},"args":["/usr/local/bin/node","/opt/qwen-k2/worker.mjs"]},"root":{"path":"rootfs","readonly":true},"linux":{}}`

func (w *gatewayMetadataFixture) Get(ctx context.Context, request *containers.GetContainerRequest, _ ...grpc.CallOption) (*containers.GetContainerResponse, error) {
	f := w.fixture
	f.request(ctx)
	if request.ID != gatewayCID {
		f.t.Error("unexpected original container metadata request")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.metadataError != codes.OK {
		return nil, grpcstatus.Error(f.metadataError, "metadata read error")
	}
	if f.absent {
		return nil, grpcstatus.Error(codes.NotFound, "original metadata removed")
	}
	if f.metadata == nil {
		return &containers.GetContainerResponse{}, nil
	}
	return &containers.GetContainerResponse{Container: proto.Clone(f.metadata).(*containers.Container)}, nil
}

func (f *gatewayFixture) request(ctx context.Context) {
	f.t.Helper()
	m, _ := metadata.FromOutgoingContext(ctx)
	if got := m.Get("containerd-namespace"); len(got) != 1 || got[0] != "k8s.io" {
		f.t.Errorf("unexpected runtime namespace: %v", got)
	}
}

func (w *gatewayCriFixture) ListPodSandbox(ctx context.Context, _ *cri.ListPodSandboxRequest, _ ...grpc.CallOption) (*cri.ListPodSandboxResponse, error) {
	f := w.fixture
	f.request(ctx)
	f.mu.Lock()
	defer f.mu.Unlock()
	r := &cri.ListPodSandboxResponse{}
	if !f.absent {
		m := &cri.PodSandboxMetadata{Uid: gatewayTask.PodUID, Namespace: gatewayTask.Namespace, Name: gatewayTask.PodName}
		if f.listedUID != "" {
			m.Uid = f.listedUID
		}
		if f.nilListMetadata {
			m = nil
		}
		r.Items = []*cri.PodSandbox{{Id: gatewaySID, Metadata: m}}
	}
	return r, nil
}

func (w *gatewayCriFixture) ListContainers(ctx context.Context, r *cri.ListContainersRequest, _ ...grpc.CallOption) (*cri.ListContainersResponse, error) {
	f := w.fixture
	f.request(ctx)
	if r.Filter.PodSandboxId != gatewaySID {
		f.t.Error("unexpected sandbox filter")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	result := &cri.ListContainersResponse{}
	if !f.absent {
		result.Containers = []*cri.Container{{Id: gatewayCID, PodSandboxId: gatewaySID, Metadata: &cri.ContainerMetadata{Name: "runtime"}}}
		if f.extra {
			result.Containers = append(result.Containers, &cri.Container{Id: strings.Repeat("d", 64)})
		}
	}
	return result, nil
}

func (w *gatewayCriFixture) PodSandboxStatus(ctx context.Context, r *cri.PodSandboxStatusRequest, _ ...grpc.CallOption) (*cri.PodSandboxStatusResponse, error) {
	f := w.fixture
	f.request(ctx)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.absent {
		return nil, grpcstatus.Error(codes.NotFound, "original sandbox removed")
	}
	return &cri.PodSandboxStatusResponse{Status: &cri.PodSandboxStatus{Id: r.PodSandboxId, Metadata: &cri.PodSandboxMetadata{Uid: gatewayTask.PodUID, Namespace: gatewayTask.Namespace, Name: gatewayTask.PodName}}}, nil
}

func (w *gatewayCriFixture) ContainerStatus(ctx context.Context, r *cri.ContainerStatusRequest, _ ...grpc.CallOption) (*cri.ContainerStatusResponse, error) {
	f := w.fixture
	f.request(ctx)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.absent {
		return nil, grpcstatus.Error(codes.NotFound, "original container removed")
	}
	return &cri.ContainerStatusResponse{Status: &cri.ContainerStatus{Id: r.ContainerId, Metadata: &cri.ContainerMetadata{Name: "runtime"}, ImageRef: f.image, State: f.criState, FinishedAt: f.finishedAt}}, nil
}

func (w *gatewayTaskFixture) Get(ctx context.Context, r *tasks.GetRequest, _ ...grpc.CallOption) (*tasks.GetResponse, error) {
	f := w.fixture
	f.request(ctx)
	if r.ContainerID != gatewayCID || r.ExecID != "" {
		f.t.Error("unexpected original task request")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.cancelRead != nil {
		f.cancelRead()
	}
	if f.getError != codes.OK {
		return nil, grpcstatus.Error(f.getError, "task read error")
	}
	if f.removed {
		return nil, grpcstatus.Error(codes.NotFound, "original task removed")
	}
	p := &tasktypes.Process{ID: gatewayCID, Pid: f.pid, Status: f.state}
	if f.state == tasktypes.Status_STOPPED {
		p.ExitedAt = f.stamp
	}
	return &tasks.GetResponse{Process: p}, nil
}

func (w *gatewayTaskFixture) Wait(ctx context.Context, r *tasks.WaitRequest, _ ...grpc.CallOption) (*tasks.WaitResponse, error) {
	f := w.fixture
	f.request(ctx)
	if r.ContainerID != gatewayCID || r.ExecID != "" {
		f.t.Error("unexpected original lifetime wait")
	}
	f.mu.Lock()
	f.waitCalls++
	if f.waitCalls == 1 {
		close(f.started)
	}
	f.mu.Unlock()
	defer close(f.waitDone)
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-f.exited:
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.waitError != codes.OK {
		return nil, grpcstatus.Error(f.waitError, "original wait failed")
	}
	return &tasks.WaitResponse{ExitedAt: f.stamp}, nil
}

func newGatewayFixture(t *testing.T) (*runtimeReadGateway, *gatewayFixture, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	stamp := timestamppb.New(time.Unix(1710000000, 123456))
	f := &gatewayFixture{t: t, state: tasktypes.Status_CREATED, criState: cri.ContainerState_CONTAINER_CREATED, pid: 12345, image: "sha256:" + gatewayTask.ImageDigest, stamp: stamp, finishedAt: stamp.AsTime().UnixNano(), exited: make(chan struct{}), started: make(chan struct{}), waitDone: make(chan struct{})}
	f.metadata = &containers.Container{ID: gatewayCID, Image: "opaque-original-image", Snapshotter: "overlayfs", SnapshotKey: gatewayCID,
		Runtime: &containers.Container_Runtime{Name: "io.containerd.runc.v2", Options: &anypb.Any{TypeUrl: "synthetic-runtime-options", Value: []byte{1}}},
		Spec:    &anypb.Any{TypeUrl: "types.containerd.io/opencontainers/runtime-spec/1/Spec", Value: []byte(gatewayOCISpec)}, CreatedAt: stamp,
		Labels: map[string]string{"io.kubernetes.pod.uid": gatewayTask.PodUID, "io.kubernetes.pod.namespace": gatewayTask.Namespace,
			"io.kubernetes.pod.name": gatewayTask.PodName, "io.kubernetes.container.name": "runtime", "io.cri-containerd.kind": "container"}}
	g := &runtimeReadGateway{tasks: &gatewayTaskFixture{fixture: f}, containers: &gatewayMetadataFixture{fixture: f}, cri: &gatewayCriFixture{fixture: f}, lifetime: ctx}
	t.Cleanup(func() {
		cancel()
		if err := g.close(); err != nil {
			t.Error(err)
		}
	})
	if err := g.register(gatewayTask); err != nil {
		t.Fatal(err)
	}
	return g, f, cancel
}

func gatewayRunning(t *testing.T, g *runtimeReadGateway, f *gatewayFixture) {
	t.Helper()
	if r, err := g.observe(context.Background(), gatewayTask.ArmID); err != nil || r.State != "created" {
		t.Fatalf("initial original task: %+v %v", r, err)
	}
	select {
	case <-f.started:
	case <-time.After(time.Second):
		t.Fatal("original Wait was not started before exit")
	}
	f.mu.Lock()
	f.state, f.criState = tasktypes.Status_RUNNING, cri.ContainerState_CONTAINER_RUNNING
	f.mu.Unlock()
	if r, err := g.observe(context.Background(), gatewayTask.ArmID); err != nil || r.State != "running" {
		t.Fatalf("running original task: %+v %v", r, err)
	}
}

func TestGatewayRefusesInvalidContainerMetadataBeforeEstablishingWait(t *testing.T) {
	faults := map[string]func(*runtimeReadGateway, *gatewayFixture){
		"missing-reader":    func(g *runtimeReadGateway, _ *gatewayFixture) { g.containers = nil },
		"missing-container": func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadata = nil },
		"not-found":         func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadataError = codes.NotFound },
		"unavailable":       func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadataError = codes.Unavailable },
		"foreign-id":        func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadata.ID = gatewaySID },
		"foreign-uid":       func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadata.Labels["io.kubernetes.pod.uid"] = "other" },
		"foreign-namespace": func(_ *runtimeReadGateway, f *gatewayFixture) {
			f.metadata.Labels["io.kubernetes.pod.namespace"] = "other"
		},
		"foreign-name": func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadata.Labels["io.kubernetes.pod.name"] = "other" },
		"extra-process": func(_ *runtimeReadGateway, f *gatewayFixture) {
			f.metadata.Labels["io.kubernetes.container.name"] = "sidecar"
		},
		"sandbox": func(_ *runtimeReadGateway, f *gatewayFixture) {
			f.metadata.Labels["io.cri-containerd.kind"] = "sandbox"
		},
		"missing-runtime":     func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadata.Runtime = nil },
		"other-runtime":       func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadata.Runtime.Name = "other" },
		"old-custom-runtime":  func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadata.Runtime.Name = "io.containerd.qwen-k2.v1" },
		"missing-spec":        func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadata.Spec = nil },
		"other-spec-type":     func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadata.Spec.TypeUrl = "other" },
		"empty-spec":          func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadata.Spec.Value = nil },
		"missing-image":       func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadata.Image = "" },
		"missing-snapshotter": func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadata.Snapshotter = "" },
		"missing-snapshot":    func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadata.SnapshotKey = "" },
		"missing-created-at":  func(_ *runtimeReadGateway, f *gatewayFixture) { f.metadata.CreatedAt = nil },
		"invalid-created-at": func(_ *runtimeReadGateway, f *gatewayFixture) {
			f.metadata.CreatedAt = &timestamppb.Timestamp{Seconds: -999999999999}
		},
		"oversized-spec": func(_ *runtimeReadGateway, f *gatewayFixture) {
			f.metadata.Spec.Value = []byte(strings.Repeat("x", 1<<20))
		},
	}
	for name, mutate := range faults {
		t.Run(name, func(t *testing.T) {
			g, f, _ := newGatewayFixture(t)
			mutate(g, f)
			if _, err := g.observe(context.Background(), gatewayTask.ArmID); err == nil {
				t.Fatal("accepted invalid original metadata")
			}
			if f.waitCalls != 0 || g.originals[gatewayTask.ArmID].metadataSHA256 != "" {
				t.Fatal("invalid metadata established an original wait or pin")
			}
		})
	}
}

func TestGatewayPinsAllCurrentContainerInputsAndRefusesRepair(t *testing.T) {
	for name, mutate := range map[string]func(*containers.Container){
		"spec": func(c *containers.Container) {
			c.Spec.Value = []byte(strings.Replace(gatewayOCISpec, `"rootfs"`, `"changed-rootfs"`, 1))
		},
		"runtime-options": func(c *containers.Container) { c.Runtime.Options.Value = []byte{2} },
		"image":           func(c *containers.Container) { c.Image = "other-image" },
		"snapshotter":     func(c *containers.Container) { c.Snapshotter = "other" },
		"snapshot":        func(c *containers.Container) { c.SnapshotKey = "other" },
		"created-at":      func(c *containers.Container) { c.CreatedAt.Seconds++ },
		"extra-label":     func(c *containers.Container) { c.Labels["new-input"] = "other" },
		"extension": func(c *containers.Container) {
			c.Extensions = map[string]*anypb.Any{"new": {TypeUrl: "other", Value: []byte{1}}}
		},
	} {
		t.Run(name, func(t *testing.T) {
			g, f, _ := newGatewayFixture(t)
			gatewayRunning(t, g, f)
			original := proto.Clone(f.metadata).(*containers.Container)
			pin := g.originals[gatewayTask.ArmID].metadataSHA256
			f.mu.Lock()
			mutate(f.metadata)
			f.mu.Unlock()
			if _, err := g.observe(context.Background(), gatewayTask.ArmID); err == nil {
				t.Fatal("accepted changed original container inputs")
			}
			f.mu.Lock()
			f.metadata = original
			f.mu.Unlock()
			if _, err := g.observe(context.Background(), gatewayTask.ArmID); err == nil || g.originals[gatewayTask.ArmID].metadataSHA256 != pin {
				t.Fatal("repaired a blocked original or replaced its input pin")
			}
		})
	}
}

func TestGatewayRefusesInvalidOCIIntentBeforePinOrWaitAndCannotRepair(t *testing.T) {
	faults := map[string]string{
		"null":              "null",
		"array":             "[]",
		"opaque":            `{"synthetic":"current-metadata-only"}`,
		"null-process":      `{"process":null}`,
		"array-process":     `{"process":[]}`,
		"duplicate-process": gatewayOCISpec[:len(gatewayOCISpec)-1] + `,"process":{}}`,
		"duplicate-profile": strings.Replace(gatewayOCISpec, `"apparmorProfile":`, `"apparmorProfile":"unconfined","apparmorProfile":`, 1),
		"duplicate-user":    strings.Replace(gatewayOCISpec, `"user":`, `"user":{},"user":`, 1),
		"duplicate-uid":     strings.Replace(gatewayOCISpec, `"uid":1000`, `"uid":0,"u\u0069d":1000`, 1),
		"alias-process":     strings.Replace(gatewayOCISpec, `"process":`, `"PROCESS":{},"process":`, 1),
		"alias-profile":     strings.Replace(gatewayOCISpec, `"apparmorProfile":`, `"ApparmorProfile":"unconfined","apparmorProfile":`, 1),
		"alias-privileges":  strings.Replace(gatewayOCISpec, `"noNewPrivileges":`, `"NoNewPrivileges":false,"noNewPrivileges":`, 1),
		"alias-user":        strings.Replace(gatewayOCISpec, `"user":`, `"User":{},"user":`, 1),
		"alias-uid":         strings.Replace(gatewayOCISpec, `"uid":1000`, `"UID":0,"uid":1000`, 1),
		"alias-gid":         strings.Replace(gatewayOCISpec, `"gid":1000`, `"Gid":0,"gid":1000`, 1),
		"trailing-document": gatewayOCISpec + `{}`,
		"invalid-utf8":      strings.Replace(gatewayOCISpec, `"rootfs"`, "\"root\xfffs\"", 1),
		"oversized":         strings.Repeat(" ", 1<<20) + gatewayOCISpec,
	}
	for _, pair := range []struct{ from, to string }{
		{`"apparmorProfile":"qwen-k2-worker-v1"`, `"apparmorProfile":null`},
		{`"apparmorProfile":"qwen-k2-worker-v1"`, `"apparmorProfile":"unconfined"`},
		{`"apparmorProfile":"qwen-k2-worker-v1"`, `"ApparmorProfile":"qwen-k2-worker-v1"`},
		{`"apparmorProfile":"qwen-k2-worker-v1"`, `"apparmorProfile":true`},
		{`"noNewPrivileges":true`, `"noNewPrivileges":false`},
		{`"noNewPrivileges":true`, `"noNewPrivileges":"true"`},
		{`"noNewPrivileges":true`, `"noNewPrivileges":null`},
		{`"noNewPrivileges":true`, `"NoNewPrivileges":true`},
		{`"user":{"uid":1000,"gid":1000,"additionalGids":[1000]}`, `"user":null`},
		{`"user":{"uid":1000,"gid":1000,"additionalGids":[1000]}`, `"user":[]`},
		{`"uid":1000`, `"uid":0`},
		{`"uid":1000`, `"uid":null`},
		{`"uid":1000`, `"uid":"1000"`},
		{`"uid":1000`, `"uid":1000.0`},
		{`"uid":1000`, `"uid":1e3`},
		{`"uid":1000`, `"uid":4294967296`},
		{`"gid":1000`, `"gid":0`},
		{`"gid":1000`, `"gid":-1`},
		{`"gid":1000`, `"gid":null`},
		{`"gid":1000`, `"gid":"1000"`},
		{`"gid":1000`, `"gid":1000.0`},
	} {
		faults[pair.to] = strings.Replace(gatewayOCISpec, pair.from, pair.to, 1)
	}
	for name, raw := range faults {
		t.Run(name, func(t *testing.T) {
			g, f, _ := newGatewayFixture(t)
			f.metadata.Spec.Value = []byte(raw)
			if _, err := g.observe(context.Background(), gatewayTask.ArmID); err == nil {
				t.Fatal("accepted invalid original OCI process intent")
			}
			original := g.originals[gatewayTask.ArmID]
			if !original.blocked || original.metadataSHA256 != "" || original.wait != nil || f.waitCalls != 0 {
				t.Fatal("invalid OCI intent established an original pin or wait")
			}
			f.metadata.Spec.Value = []byte(gatewayOCISpec)
			if _, err := g.observe(context.Background(), gatewayTask.ArmID); err == nil {
				t.Fatal("repaired an original blocked by invalid OCI intent")
			}
		})
	}
}

func TestGatewayAllowsOnlyMetadataUpdateTimestampBookkeeping(t *testing.T) {
	g, f, _ := newGatewayFixture(t)
	gatewayRunning(t, g, f)
	pin := g.originals[gatewayTask.ArmID].metadataSHA256
	f.mu.Lock()
	f.metadata.UpdatedAt = timestamppb.New(time.Unix(1710000001, 0))
	f.mu.Unlock()
	if value, err := g.observe(context.Background(), gatewayTask.ArmID); err != nil || value.State != "running" || g.originals[gatewayTask.ArmID].metadataSHA256 != pin {
		t.Fatal("bookkeeping changed the complete original input pin")
	}
}

func TestGatewayOriginalWaitSurvivesTaskCleanup(t *testing.T) {
	for _, scenario := range []string{"stopped-before-cri", "removed-before-cri", "removed-after-cri", "removed-after-cache"} {
		t.Run(scenario, func(t *testing.T) {
			g, f, _ := newGatewayFixture(t)
			gatewayRunning(t, g, f)
			f.mu.Lock()
			f.state = tasktypes.Status_STOPPED
			f.removed = scenario == "removed-before-cri" || scenario == "removed-after-cri"
			if scenario != "stopped-before-cri" && scenario != "removed-before-cri" {
				f.criState = cri.ContainerState_CONTAINER_EXITED
			}
			close(f.exited)
			f.mu.Unlock()
			first, err := g.observe(context.Background(), gatewayTask.ArmID)
			if err != nil || first.State != "stopped" || first.PID != 12345 || first.ContainerID != gatewayCID || first.SandboxID != gatewaySID || first.ImageDigest != gatewayTask.ImageDigest || first.ExitStatus != 0 || first.ExitedAtNano != f.finishedAt {
				t.Fatalf("original exit outcome: %+v %v", first, err)
			}
			f.mu.Lock()
			f.removed, f.absent = true, true
			f.mu.Unlock()
			if retry, err := g.observe(context.Background(), gatewayTask.ArmID); err != nil || retry != first {
				t.Fatalf("cleanup retry changed original outcome: %+v %v", retry, err)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.waitCalls != 1 {
				t.Fatalf("Wait count: %d", f.waitCalls)
			}
		})
	}
}

func TestGatewayWaitDoesNotMakeAbsenceOrConflictSuccessful(t *testing.T) {
	for _, scenario := range []string{"wait-notfound", "wait-unavailable", "wait-null-time", "wait-time-overflow", "changed-pid", "changed-image", "extra-container", "get-unavailable", "cri-outcome-conflict", "live-task-after-wait", "listed-uid-conflict", "listed-metadata-missing"} {
		t.Run(scenario, func(t *testing.T) {
			g, f, _ := newGatewayFixture(t)
			gatewayRunning(t, g, f)
			f.mu.Lock()
			f.state, f.criState = tasktypes.Status_STOPPED, cri.ContainerState_CONTAINER_EXITED
			switch scenario {
			case "wait-notfound":
				f.waitError, f.removed = codes.NotFound, true
			case "wait-unavailable":
				f.waitError = codes.Unavailable
			case "wait-null-time":
				f.stamp = nil
			case "wait-time-overflow":
				f.stamp = &timestamppb.Timestamp{Seconds: 253402300799}
			case "changed-pid":
				f.pid++
			case "changed-image":
				f.image = "sha256:" + strings.Repeat("d", 64)
			case "extra-container":
				f.extra = true
			case "get-unavailable":
				f.getError = codes.Unavailable
			case "cri-outcome-conflict":
				f.finishedAt++
			case "listed-uid-conflict":
				f.listedUID = "replacement-uid"
			case "listed-metadata-missing":
				f.nilListMetadata = true
			case "live-task-after-wait":
				f.state, f.criState = tasktypes.Status_RUNNING, cri.ContainerState_CONTAINER_RUNNING
			}
			close(f.exited)
			f.mu.Unlock()
			<-f.waitDone
			if r, err := g.observe(context.Background(), gatewayTask.ArmID); err == nil || r != (runtimeObservation{}) || !g.originals[gatewayTask.ArmID].blocked {
				t.Fatalf("unsafe outcome accepted: %+v %v", r, err)
			}
			if _, err := g.observe(context.Background(), gatewayTask.ArmID); err == nil {
				t.Fatal("blocked original revived")
			}
		})
	}
}

func TestGatewayWaitHasOneActiveOriginalAndClosesOnLifetimeLoss(t *testing.T) {
	g, f, cancel := newGatewayFixture(t)
	gatewayRunning(t, g, f)
	other := &gatewayOriginal{task: registeredTask{ArmID: "other"}, containerID: strings.Repeat("d", 64), pid: 67890}
	g.mu.Lock()
	err := g.startWait(other)
	g.mu.Unlock()
	if err == nil || other.wait != nil {
		t.Fatal("second live wait accepted")
	}
	cancel()
	if err := g.close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-f.waitDone:
	default:
		t.Fatal("original Wait outlived gateway")
	}
	if _, err := g.observe(context.Background(), gatewayTask.ArmID); err == nil {
		t.Fatal("closed gateway accepted observation")
	}
	if err := g.register(gatewayTask); err == nil {
		t.Fatal("closed gateway accepted registration")
	}
}

func TestGatewayPendingTaskAndCompletedRequestDoNotLoseLifetimeWait(t *testing.T) {
	g, f, _ := newGatewayFixture(t)
	f.removed = true
	if r, err := g.observe(context.Background(), gatewayTask.ArmID); err != nil || r.State != "pending" || r.PID != 0 || g.originals[gatewayTask.ArmID].wait != nil {
		t.Fatalf("pre-birth task absence: %+v %v", r, err)
	}
	f.removed = false
	request, endRequest := context.WithCancel(context.Background())
	if r, err := g.observe(request, gatewayTask.ArmID); err != nil || r.State != "created" {
		t.Fatalf("first bound task: %+v %v", r, err)
	}
	endRequest()
	select {
	case <-f.started:
	case <-time.After(time.Second):
		t.Fatal("lifetime Wait was not started")
	}
	select {
	case <-f.waitDone:
		t.Fatal("successful observation request canceled lifetime Wait")
	default:
	}
	f.mu.Lock()
	f.state, f.criState = tasktypes.Status_RUNNING, cri.ContainerState_CONTAINER_RUNNING
	f.mu.Unlock()
	if r, err := g.observe(context.Background(), gatewayTask.ArmID); err != nil || r.State != "running" {
		t.Fatalf("later live observation: %+v %v", r, err)
	}
}

func TestGatewayLifetimeLossDuringReadCannotReturnNewObservation(t *testing.T) {
	for _, stage := range []string{"created", "running", "stopped"} {
		t.Run(stage, func(t *testing.T) {
			g, f, cancel := newGatewayFixture(t)
			if stage != "created" {
				gatewayRunning(t, g, f)
			}
			f.mu.Lock()
			if stage == "stopped" {
				f.state = tasktypes.Status_STOPPED
				f.criState = cri.ContainerState_CONTAINER_EXITED
				close(f.exited)
			}
			f.cancelRead = cancel
			f.mu.Unlock()
			if stage == "stopped" {
				<-f.waitDone
			}
			r, err := g.observe(context.Background(), gatewayTask.ArmID)
			if err == nil || r != (runtimeObservation{}) || !g.originals[gatewayTask.ArmID].blocked || g.lifetime.Err() == nil {
				t.Fatalf("lifetime loss accepted: %+v %v", r, err)
			}
			if stage == "created" && g.originals[gatewayTask.ArmID].wait != nil {
				t.Fatal("started Watch after lifetime loss")
			}
		})
	}
}
