package main

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	tasks "github.com/containerd/containerd/api/services/tasks/v1"
	tasktypes "github.com/containerd/containerd/api/types/task"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	grpcstatus "google.golang.org/grpc/status"
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
}

type gatewayTaskFixture struct {
	tasks.TasksClient
	fixture *gatewayFixture
}
type gatewayCriFixture struct {
	cri.RuntimeServiceClient
	fixture *gatewayFixture
}

var gatewayTask = registeredTask{ArmID: "owned-arm", Namespace: "owned-evidence", PodName: "worker", PodUID: "original-uid", ImageDigest: strings.Repeat("c", 64)}
var gatewayCID, gatewaySID = strings.Repeat("a", 64), strings.Repeat("b", 64)

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
	g := &runtimeReadGateway{tasks: &gatewayTaskFixture{fixture: f}, cri: &gatewayCriFixture{fixture: f}, lifetime: ctx}
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
