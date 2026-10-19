package taskboundary

import (
	"context"
	"errors"
	"sync"

	task "github.com/containerd/containerd/api/runtime/task/v3"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	"github.com/containerd/ttrpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/emptypb"
)

// Creation owns the actual consumed inputs and original pre-exec source binding.
type Creation interface {
	Request() *task.CreateTaskRequest
	BindCreated(context.Context, uint32) error
	BeforeStart(context.Context, uint32) error
	Started(context.Context, uint32) error
	Cleanup(context.Context, *task.DeleteResponse) error
}

type Producer interface {
	Prepare(context.Context, *task.CreateTaskRequest) (Creation, error)
}

type owner struct {
	mu       sync.Mutex
	creation Creation
	pid      uint32
	stage    string
	deleted  *task.DeleteResponse
}

type Service struct {
	base     task.TTRPCTaskService
	producer Producer
	mu       sync.Mutex
	owners   map[string]*owner
	closing  bool
}

var _ task.TTRPCTaskService = (*Service)(nil)

func New(base task.TTRPCTaskService, producer Producer) (*Service, error) {
	if base == nil || producer == nil {
		return nil, errors.New("K2 task boundary requires its actual service and creation producer")
	}
	return &Service{base: base, producer: producer, owners: make(map[string]*owner)}, nil
}

func (s *Service) RegisterTTRPC(server *ttrpc.Server) error {
	task.RegisterTTRPCTaskService(server, s)
	return nil
}

func refused() error {
	return status.Error(codes.FailedPrecondition, "original K2 init authority is unavailable")
}

func valid(ctx context.Context, id, execID string, request proto.Message) bool {
	namespace, err := namespaces.NamespaceRequired(ctx)
	if err != nil || namespace != "k8s.io" || len(id) != 64 || execID != "" || request == nil ||
		!request.ProtoReflect().IsValid() || len(request.ProtoReflect().GetUnknown()) != 0 || proto.Size(request) > 64<<10 {
		return false
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func (s *Service) known(ctx context.Context, id, execID string, request proto.Message) (*owner, error) {
	if !valid(ctx, id, execID, request) {
		return nil, refused()
	}
	s.mu.Lock()
	o := s.owners[id]
	s.mu.Unlock()
	if o == nil {
		return nil, refused()
	}
	return o, nil
}

func (s *Service) Create(ctx context.Context, request *task.CreateTaskRequest) (*task.CreateTaskResponse, error) {
	if !valid(ctx, request.GetID(), "", request) || request.Terminal || request.Checkpoint != "" || request.ParentCheckpoint != "" {
		return nil, refused()
	}
	// Own the reservation before preparing; even an unknown Create outcome cannot be overwritten.
	o := &owner{stage: "preparing"}
	o.mu.Lock()
	defer o.mu.Unlock()
	s.mu.Lock()
	if s.closing || s.owners[request.ID] != nil || len(s.owners) >= 4096 {
		s.mu.Unlock()
		return nil, refused()
	}
	s.owners[request.ID] = o
	s.mu.Unlock()
	o.stage = "failed"
	creation, err := s.producer.Prepare(ctx, proto.Clone(request).(*task.CreateTaskRequest))
	if err != nil || creation == nil {
		o.stage = "uncreated"
		if err != nil {
			return nil, err
		}
		return nil, refused()
	}
	o.creation = creation
	consumed := creation.Request()
	if !valid(ctx, consumed.GetID(), "", consumed) || consumed.ID != request.ID || consumed.Terminal || consumed.Checkpoint != "" || consumed.ParentCheckpoint != "" {
		return nil, refused()
	}
	// The producer may relocate Bundle only; every actual RPC input must be preserved.
	expected := proto.Clone(request).(*task.CreateTaskRequest)
	expected.Bundle = consumed.Bundle
	if !proto.Equal(expected, consumed) {
		return nil, refused()
	}
	response, err := s.base.Create(ctx, proto.Clone(consumed).(*task.CreateTaskRequest))
	if err != nil {
		return nil, err
	}
	if response == nil || response.Pid == 0 {
		return nil, refused()
	}
	o.pid = response.Pid
	if err := creation.BindCreated(ctx, response.Pid); err != nil {
		return nil, err
	}
	o.stage = "created"
	return response, nil
}

func (s *Service) Start(ctx context.Context, request *task.StartRequest) (*task.StartResponse, error) {
	o, err := s.known(ctx, request.GetID(), request.GetExecID(), request)
	if err != nil {
		return nil, err
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.stage != "created" || o.creation == nil || o.pid == 0 {
		return nil, refused()
	}
	o.stage = "failed"
	if err := o.creation.BeforeStart(ctx, o.pid); err != nil {
		return nil, err
	}
	response, err := s.base.Start(ctx, request)
	if err != nil {
		return nil, err
	}
	if response == nil || response.Pid != o.pid {
		return nil, refused()
	}
	if err := o.creation.Started(ctx, response.Pid); err != nil {
		return nil, err
	}
	o.stage = "started"
	return response, nil
}

func (s *Service) Delete(ctx context.Context, request *task.DeleteRequest) (*task.DeleteResponse, error) {
	o, err := s.known(ctx, request.GetID(), request.GetExecID(), request)
	if err != nil {
		return nil, err
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.stage == "uncreated" {
		return nil, status.Error(codes.NotFound, "original K2 init was not created")
	}
	if o.stage != "native-deleted" && o.stage != "cleaned" {
		response, err := s.base.Delete(ctx, request)
		if err != nil {
			return nil, err
		}
		if response == nil || o.pid != 0 && response.Pid != o.pid {
			return nil, refused()
		}
		o.deleted = proto.Clone(response).(*task.DeleteResponse)
		o.stage = "native-deleted"
	}
	// A failed input cleanup remains retryable without a second native Delete.
	if o.stage != "cleaned" && o.creation != nil {
		if err := o.creation.Cleanup(ctx, proto.Clone(o.deleted).(*task.DeleteResponse)); err != nil {
			return nil, err
		}
	}
	o.stage = "cleaned"
	return proto.Clone(o.deleted).(*task.DeleteResponse), nil
}

func (s *Service) State(ctx context.Context, r *task.StateRequest) (*task.StateResponse, error) {
	if _, err := s.known(ctx, r.GetID(), r.GetExecID(), r); err != nil {
		return nil, err
	}
	return s.base.State(ctx, r)
}

func (s *Service) Wait(ctx context.Context, r *task.WaitRequest) (*task.WaitResponse, error) {
	if _, err := s.known(ctx, r.GetID(), r.GetExecID(), r); err != nil {
		return nil, err
	}
	return s.base.Wait(ctx, r)
}

func (s *Service) Kill(ctx context.Context, r *task.KillRequest) (*emptypb.Empty, error) {
	o, err := s.known(ctx, r.GetID(), r.GetExecID(), r)
	if err != nil {
		return nil, err
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.stage == "native-deleted" || o.stage == "cleaned" {
		return nil, refused()
	}
	return s.base.Kill(ctx, r)
}

func (s *Service) CloseIO(ctx context.Context, r *task.CloseIORequest) (*emptypb.Empty, error) {
	if _, err := s.known(ctx, r.GetID(), r.GetExecID(), r); err != nil {
		return nil, err
	}
	return s.base.CloseIO(ctx, r)
}

func (s *Service) Connect(ctx context.Context, r *task.ConnectRequest) (*task.ConnectResponse, error) {
	if _, err := s.known(ctx, r.GetID(), "", r); err != nil {
		return nil, err
	}
	return s.base.Connect(ctx, r)
}

func (s *Service) Stats(ctx context.Context, r *task.StatsRequest) (*task.StatsResponse, error) {
	if _, err := s.known(ctx, r.GetID(), "", r); err != nil {
		return nil, err
	}
	return s.base.Stats(ctx, r)
}

func (s *Service) Pids(ctx context.Context, r *task.PidsRequest) (*task.PidsResponse, error) {
	if _, err := s.known(ctx, r.GetID(), "", r); err != nil {
		return nil, err
	}
	return s.base.Pids(ctx, r)
}

func (s *Service) Shutdown(ctx context.Context, r *task.ShutdownRequest) (*emptypb.Empty, error) {
	if !valid(ctx, r.GetID(), "", r) || r.Now {
		return nil, refused()
	}
	if _, err := s.known(ctx, r.GetID(), "", r); err != nil {
		return nil, err
	}
	s.mu.Lock()
	for _, original := range s.owners {
		if !original.mu.TryLock() {
			s.mu.Unlock()
			return nil, refused()
		}
		cleaned := original.stage == "cleaned" || original.stage == "uncreated"
		original.mu.Unlock()
		if !cleaned {
			s.mu.Unlock()
			return nil, refused()
		}
	}
	s.closing = true
	// Release the adapter lock before SDK shutdown callbacks run.
	s.mu.Unlock()
	return s.base.Shutdown(ctx, r)
}

func (s *Service) Exec(context.Context, *task.ExecProcessRequest) (*emptypb.Empty, error) {
	return nil, refused()
}

func (s *Service) Checkpoint(context.Context, *task.CheckpointTaskRequest) (*emptypb.Empty, error) {
	return nil, refused()
}

func (s *Service) Update(context.Context, *task.UpdateTaskRequest) (*emptypb.Empty, error) {
	return nil, refused()
}

func (s *Service) Pause(context.Context, *task.PauseRequest) (*emptypb.Empty, error) {
	return nil, refused()
}

func (s *Service) Resume(context.Context, *task.ResumeRequest) (*emptypb.Empty, error) {
	return nil, refused()
}

func (s *Service) ResizePty(context.Context, *task.ResizePtyRequest) (*emptypb.Empty, error) {
	return nil, refused()
}
