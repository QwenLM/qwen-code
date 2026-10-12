package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
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

type registeredTask struct {
	ArmID       string `json:"armId"`
	Namespace   string `json:"namespace"`
	PodName     string `json:"podName"`
	PodUID      string `json:"podUid"`
	ImageDigest string `json:"imageDigest"`
}

type runtimeObservation struct {
	Version      string `json:"version"`
	ArmID        string `json:"armId"`
	PodUID       string `json:"podUid"`
	ContainerID  string `json:"containerId"`
	SandboxID    string `json:"sandboxId"`
	ImageDigest  string `json:"imageDigest"`
	PID          uint32 `json:"pid"`
	State        string `json:"state"`
	ExitStatus   uint32 `json:"exitStatus"`
	ExitedAtNano int64  `json:"exitedAtNano"`
}

type gatewayOriginal struct {
	task        registeredTask
	containerID string
	sandboxID   string
	pid         uint32
	terminal    *runtimeObservation
	blocked     bool
	wait        <-chan gatewayWaitResult
	waitCancel  context.CancelFunc
	waitDone    <-chan struct{}
	outcome     *runtimeObservation
}

type gatewayWaitResult struct {
	response *tasks.WaitResponse
	err      error
}

type runtimeReadGateway struct {
	mu          sync.Mutex
	tasks       tasks.TasksClient
	cri         cri.RuntimeServiceClient
	originals   map[string]*gatewayOriginal
	coordinator string
	source      string
	identity    *gatewayIdentity
	lifetime    context.Context
	connection  *grpc.ClientConn
	activeWait  *gatewayOriginal
	watches     sync.WaitGroup
	closed      bool
}

func validTask(t registeredTask) bool {
	return safeID(t.ArmID) && safeID(t.Namespace) && safeID(t.PodName) && safeID(t.PodUID) && hashString(t.ImageDigest)
}

func safeID(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

func (g *runtimeReadGateway) register(t registeredTask) error {
	if !validTask(t) {
		return errors.New("invalid original task association")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed || g.lifetime == nil || g.lifetime.Err() != nil {
		return errors.New("original gateway lifetime is unavailable")
	}
	if previous := g.originals[t.ArmID]; previous != nil {
		if previous.task != t || previous.blocked {
			return errors.New("original task association cannot change")
		}
		return nil
	}
	if g.originals == nil {
		g.originals = make(map[string]*gatewayOriginal)
	}
	if len(g.originals) >= 4096 {
		return errors.New("original task registry capacity exceeded")
	}
	g.originals[t.ArmID] = &gatewayOriginal{task: t}
	return nil
}

func (g *runtimeReadGateway) observe(parent context.Context, arm string) (runtimeObservation, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	original := g.originals[arm]
	if g.closed || g.lifetime == nil || g.lifetime.Err() != nil || original == nil || original.blocked {
		return runtimeObservation{}, errors.New("original task is unavailable")
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	ctx = metadata.NewOutgoingContext(ctx, metadata.Pairs("containerd-namespace", "k8s.io"))
	result, err := g.readOriginal(ctx, original)
	if err != nil || ctx.Err() != nil || g.lifetime.Err() != nil || original.pid != 0 && result.PID != original.pid || original.terminal != nil && result != *original.terminal {
		original.blocked = true
		if original.waitCancel != nil {
			original.waitCancel()
		}
		return runtimeObservation{}, errors.New("original runtime observation failed")
	}
	original.pid, original.containerID, original.sandboxID = result.PID, result.ContainerID, result.SandboxID
	if result.PID != 0 && original.wait == nil {
		if err := g.startWait(original); err != nil {
			original.blocked = true
			return runtimeObservation{}, err
		}
	}
	if original.terminal == nil && result.State == "stopped" {
		original.terminal = &result
	}
	return result, nil
}

func (g *runtimeReadGateway) startWait(original *gatewayOriginal) error {
	if g.activeWait != nil {
		select {
		case <-g.activeWait.waitDone:
			g.activeWait = nil
		default:
			return errors.New("another original task wait is active")
		}
	}
	ctx, cancel := context.WithCancel(g.lifetime)
	ctx = metadata.NewOutgoingContext(ctx, metadata.Pairs("containerd-namespace", "k8s.io"))
	result := make(chan gatewayWaitResult, 1)
	done := make(chan struct{})
	original.wait, original.waitCancel, original.waitDone = result, cancel, done
	containerID := original.containerID
	g.activeWait = original
	g.watches.Add(1)
	go func() {
		defer g.watches.Done()
		defer close(done)
		defer cancel()
		response, err := g.tasks.Wait(ctx, &tasks.WaitRequest{ContainerID: containerID})
		result <- gatewayWaitResult{response: response, err: err}
	}()
	return nil
}

func terminalNano(stamp *timestamppb.Timestamp) (int64, bool) {
	if stamp == nil || stamp.CheckValid() != nil {
		return 0, false
	}
	t := stamp.AsTime()
	nano := t.UnixNano()
	return nano, nano > 0 && time.Unix(0, nano).Equal(t)
}

func (g *runtimeReadGateway) collectWait(ctx context.Context, original *gatewayOriginal, await bool) error {
	if original.outcome != nil {
		return nil
	}
	if original.wait == nil {
		if await {
			return errors.New("original lifetime wait was not established")
		}
		return nil
	}
	var received gatewayWaitResult
	if await {
		select {
		case received = <-original.wait:
		case <-ctx.Done():
			return errors.New("original lifetime wait did not complete")
		}
	} else {
		select {
		case received = <-original.wait:
		default:
			return nil
		}
	}
	if received.err != nil || received.response == nil {
		return errors.New("original lifetime wait failed")
	}
	nano, valid := terminalNano(received.response.ExitedAt)
	if !valid {
		return errors.New("original lifetime wait has no terminal outcome")
	}
	original.outcome = &runtimeObservation{Version: "qwen-k2-runtime-read/1", ArmID: original.task.ArmID, PodUID: original.task.PodUID, ContainerID: original.containerID, SandboxID: original.sandboxID, ImageDigest: original.task.ImageDigest, PID: original.pid, State: "stopped", ExitStatus: received.response.ExitStatus, ExitedAtNano: nano}
	return nil
}

func (g *runtimeReadGateway) close() error {
	g.mu.Lock()
	g.closed = true
	if g.activeWait != nil {
		g.activeWait.waitCancel()
	}
	g.mu.Unlock()
	if g.connection != nil {
		_ = g.connection.Close()
	}
	done := make(chan struct{})
	go func() { g.watches.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-time.After(5 * time.Second):
		return errors.New("original task wait did not close")
	}
}

func (g *runtimeReadGateway) readOriginal(ctx context.Context, original *gatewayOriginal) (runtimeObservation, error) {
	if err := g.collectWait(ctx, original, false); err != nil {
		return runtimeObservation{}, err
	}
	registered := original.task
	result := runtimeObservation{Version: "qwen-k2-runtime-read/1", ArmID: registered.ArmID, PodUID: registered.PodUID, ImageDigest: registered.ImageDigest, State: "pending", ContainerID: original.containerID, SandboxID: original.sandboxID}
	{
		listed, err := g.cri.ListPodSandbox(ctx, &cri.ListPodSandboxRequest{})
		if err != nil || listed == nil || len(listed.GetItems()) > 4096 {
			return runtimeObservation{}, errors.New("original sandbox discovery failed")
		}
		found := ""
		for _, sandbox := range listed.Items {
			if sandbox == nil {
				return runtimeObservation{}, errors.New("original sandbox list is malformed")
			}
			if result.SandboxID != "" && sandbox.Id == result.SandboxID || sandbox.Metadata != nil && sandbox.Metadata.Uid == registered.PodUID {
				if found != "" || !hashString(sandbox.Id) || result.SandboxID != "" && sandbox.Id != result.SandboxID || sandbox.Metadata == nil || sandbox.Metadata.Uid != registered.PodUID || sandbox.Metadata.Namespace != registered.Namespace || sandbox.Metadata.Name != registered.PodName || sandbox.Metadata.Attempt != 0 {
					return runtimeObservation{}, errors.New("original sandbox discovery differs")
				}
				found = sandbox.Id
			}
		}
		if found == "" && result.SandboxID == "" {
			return result, nil
		}
		if found != "" {
			result.SandboxID = found
		} else if err := g.collectWait(ctx, original, true); err != nil {
			return runtimeObservation{}, err
		}
	}
	listed, err := g.cri.ListContainers(ctx, &cri.ListContainersRequest{Filter: &cri.ContainerFilter{PodSandboxId: result.SandboxID}})
	if err != nil || listed == nil || len(listed.GetContainers()) > 1 {
		return runtimeObservation{}, errors.New("original container identity is unavailable")
	}
	c := &cri.Container{Id: original.containerID, PodSandboxId: result.SandboxID}
	if len(listed.Containers) == 0 {
		if original.containerID == "" {
			return result, nil
		}
		if err := g.collectWait(ctx, original, true); err != nil {
			return runtimeObservation{}, err
		}
	} else {
		c = listed.Containers[0]
		if c == nil || !hashString(c.Id) || original.containerID != "" && c.Id != original.containerID || c.Metadata == nil || c.Metadata.Name != "runtime" || c.Metadata.Attempt != 0 || c.PodSandboxId != result.SandboxID {
			return runtimeObservation{}, errors.New("original container identity differs")
		}
	}
	sandbox, err := g.cri.PodSandboxStatus(ctx, &cri.PodSandboxStatusRequest{PodSandboxId: c.PodSandboxId, Verbose: false})
	if grpcstatus.Code(err) == codes.NotFound {
		if err := g.collectWait(ctx, original, true); err != nil {
			return runtimeObservation{}, err
		}
	} else if err != nil || sandbox.GetStatus() == nil || sandbox.Status.Id != c.PodSandboxId || sandbox.Status.Metadata == nil {
		return runtimeObservation{}, errors.New("original sandbox is unavailable")
	} else {
		m := sandbox.Status.Metadata
		if m.Uid != registered.PodUID || m.Namespace != registered.Namespace || m.Name != registered.PodName || m.Attempt != 0 {
			return runtimeObservation{}, errors.New("original sandbox identity differs")
		}
	}
	result.ContainerID = c.Id
	container, err := g.cri.ContainerStatus(ctx, &cri.ContainerStatusRequest{ContainerId: c.Id, Verbose: false})
	if grpcstatus.Code(err) == codes.NotFound {
		if err := g.collectWait(ctx, original, true); err != nil {
			return runtimeObservation{}, err
		}
	} else if err != nil || container.GetStatus() == nil {
		return runtimeObservation{}, errors.New("original container status is unavailable")
	}
	status := container.GetStatus()
	if status != nil && (status.Id != c.Id || status.Metadata == nil || status.Metadata.Name != "runtime" || status.Metadata.Attempt != 0 || !matchesImage(status.ImageRef, registered.ImageDigest)) {
		return runtimeObservation{}, errors.New("original image or container status differs")
	}
	process, err := g.tasks.Get(ctx, &tasks.GetRequest{ContainerID: c.Id})
	if grpcstatus.Code(err) == codes.NotFound && original.pid == 0 && status != nil && status.State == cri.ContainerState_CONTAINER_CREATED {
		return result, nil
	}
	if grpcstatus.Code(err) == codes.NotFound {
		if err := g.collectWait(ctx, original, true); err != nil {
			return runtimeObservation{}, err
		}
	} else if err != nil || process.GetProcess() == nil {
		return runtimeObservation{}, errors.New("original task is unavailable")
	}
	p := process.GetProcess()
	if p != nil && (p.ContainerID != "" || p.ID != c.Id || p.Pid == 0 || original.pid != 0 && p.Pid != original.pid) {
		return runtimeObservation{}, errors.New("original task identity differs")
	}
	if p == nil || p.Status == tasktypes.Status_STOPPED {
		if err := g.collectWait(ctx, original, true); err != nil {
			return runtimeObservation{}, err
		}
		outcome := *original.outcome
		if p != nil {
			nano, valid := terminalNano(p.ExitedAt)
			if !valid || p.ExitStatus != outcome.ExitStatus || nano != outcome.ExitedAtNano {
				return runtimeObservation{}, errors.New("original task terminal outcome differs")
			}
		}
		if status != nil && (status.State != cri.ContainerState_CONTAINER_RUNNING && status.State != cri.ContainerState_CONTAINER_EXITED || status.State == cri.ContainerState_CONTAINER_EXITED && (status.ExitCode < 0 || uint32(status.ExitCode) != outcome.ExitStatus || status.FinishedAt != outcome.ExitedAtNano)) {
			return runtimeObservation{}, errors.New("original CRI terminal outcome differs")
		}
		return outcome, nil
	}
	if original.outcome != nil || status == nil {
		return runtimeObservation{}, errors.New("original task is live after terminal outcome")
	}
	result.PID = p.Pid
	switch {
	case p.Status == tasktypes.Status_CREATED && status.State == cri.ContainerState_CONTAINER_CREATED:
		result.State = "created"
	case p.Status == tasktypes.Status_RUNNING && status.State == cri.ContainerState_CONTAINER_RUNNING:
		result.State = "running"
	default:
		return runtimeObservation{}, errors.New("original runtime states differ")
	}
	return result, nil
}

func matchesImage(ref, expected string) bool {
	return ref == "sha256:"+expected || strings.HasSuffix(ref, "@sha256:"+expected) && strings.Count(ref, "@") == 1
}

func (g *runtimeReadGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.RawQuery != "" || r.URL.RawPath != "" || r.ContentLength > maxRecordBytes {
		http.Error(w, "invalid original runtime request", http.StatusBadRequest)
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/v1/runtime" && r.ContentLength == 0 {
		if !hasPrincipal(r, g.source) {
			http.Error(w, "original source principal is required", http.StatusForbidden)
			return
		}
		if g.identity == nil {
			http.Error(w, "original runtime identity unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(g.identity)
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/v1/original:register" {
		if !hasPrincipal(r, g.coordinator) {
			http.Error(w, "source control principal is required", http.StatusForbidden)
			return
		}
		var task registeredTask
		if decodeClosed(r.Body, &task) != nil || g.register(task) != nil {
			http.Error(w, "original task registration refused", http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	const prefix = "/v1/original/"
	if r.Method != http.MethodGet || !strings.HasPrefix(r.URL.Path, prefix) || !safeID(strings.TrimPrefix(r.URL.Path, prefix)) || r.ContentLength != 0 {
		http.Error(w, "unsupported runtime read", http.StatusNotFound)
		return
	}
	if !hasPrincipal(r, g.source) {
		http.Error(w, "original source principal is required", http.StatusForbidden)
		return
	}
	observation, err := g.observe(r.Context(), strings.TrimPrefix(r.URL.Path, prefix))
	if err != nil {
		http.Error(w, "original runtime observation unavailable", http.StatusConflict)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(observation)
}
