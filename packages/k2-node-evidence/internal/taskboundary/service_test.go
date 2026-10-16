package taskboundary

import (
	"context"
	"errors"
	"strings"
	"testing"

	task "github.com/containerd/containerd/api/runtime/task/v3"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"
)

type inertBase struct {
	task.TTRPCTaskService
	creates, deletes, shutdowns int
}

func (b *inertBase) Create(context.Context, *task.CreateTaskRequest) (*task.CreateTaskResponse, error) {
	b.creates++
	return nil, errors.New("inert unknown Create outcome")
}

func (b *inertBase) Delete(context.Context, *task.DeleteRequest) (*task.DeleteResponse, error) {
	b.deletes++
	return nil, status.Error(codes.NotFound, "inert missing task")
}

func (b *inertBase) Shutdown(context.Context, *task.ShutdownRequest) (*emptypb.Empty, error) {
	b.shutdowns++
	return &emptypb.Empty{}, nil
}

type inertProducer struct {
	creation Creation
	err      error
}

func (p inertProducer) Prepare(context.Context, *task.CreateTaskRequest) (Creation, error) {
	return p.creation, p.err
}

type inertCreation struct {
	Creation
	request *task.CreateTaskRequest
}

func (c inertCreation) Request() *task.CreateTaskRequest { return c.request }

func TestUncreatedPreparationCanShutdownWithoutNativeDelete(t *testing.T) {
	for _, prepareErr := range []error{nil, errors.New("inert preparation refusal")} {
		base := &inertBase{}
		service, err := New(base, inertProducer{err: prepareErr})
		if err != nil {
			t.Fatal(err)
		}
		ctx := namespaces.WithNamespace(context.Background(), "k8s.io")
		id := strings.Repeat("a", 64)
		if _, err := service.Create(ctx, &task.CreateTaskRequest{ID: id}); err == nil {
			t.Fatal("preparation without a creation was accepted")
		}
		if _, err := service.Delete(ctx, &task.DeleteRequest{ID: id}); status.Code(err) != codes.NotFound {
			t.Fatalf("uncreated task deletion returned %v", err)
		}
		if _, err := service.Shutdown(ctx, &task.ShutdownRequest{ID: id}); err != nil {
			t.Fatalf("uncreated owner blocked shutdown: %v", err)
		}
		if base.creates != 0 || base.deletes != 0 || base.shutdowns != 1 {
			t.Fatalf("unexpected inert calls: %+v", base)
		}
	}
}

func TestUnknownNativeCreateStillBlocksShutdown(t *testing.T) {
	id := strings.Repeat("b", 64)
	base := &inertBase{}
	service, err := New(base, inertProducer{creation: inertCreation{request: &task.CreateTaskRequest{ID: id}}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := namespaces.WithNamespace(context.Background(), "k8s.io")
	if _, err := service.Create(ctx, &task.CreateTaskRequest{ID: id}); err == nil {
		t.Fatal("inert unknown Create outcome was accepted")
	}
	if _, err := service.Delete(ctx, &task.DeleteRequest{ID: id}); status.Code(err) != codes.NotFound {
		t.Fatalf("inert native deletion returned %v", err)
	}
	if _, err := service.Shutdown(ctx, &task.ShutdownRequest{ID: id}); err == nil {
		t.Fatal("unknown native Create outcome allowed shutdown")
	}
	if base.creates != 1 || base.deletes != 1 || base.shutdowns != 0 {
		t.Fatalf("unexpected inert calls: %+v", base)
	}
}
