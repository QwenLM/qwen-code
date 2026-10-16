//go:build linux

package birth

import (
	"context"
	"errors"
	"sync"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/taskboundary"
	task "github.com/containerd/containerd/api/runtime/task/v3"
	"github.com/containerd/log"
	"google.golang.org/protobuf/proto"
)

type Producer struct {
	policy    InputPolicy
	socket    string
	digest    string
	contract  *CreationContract
	mu        sync.Mutex
	creations map[string]*creation
	closed    bool
}

type creation struct {
	inputs  *Inputs
	channel *Channel
	pid     uint32
	deleted *task.DeleteResponse
	cleaned bool
}

var _ taskboundary.Producer = (*Producer)(nil)
var _ taskboundary.Creation = (*creation)(nil)

func NewProducer(policy InputPolicy, socket, sourceSHA string, contract *CreationContract) (*Producer, error) {
	if policy.Validate() != nil || !cleanAbsolute(socket) || len(socket) > 100 || !Hash(sourceSHA) || contract == nil {
		return nil, errors.New("fixed original birth producer configuration is required")
	}
	return &Producer{policy: policy, socket: socket, digest: sourceSHA, contract: contract, creations: make(map[string]*creation)}, nil
}

func (p *Producer) Prepare(ctx context.Context, request *task.CreateTaskRequest) (taskboundary.Creation, error) {
	if ValidateRequest(p.policy, request) != nil {
		return nil, errors.New("actual original birth request is required")
	}
	p.mu.Lock()
	if p.closed || p.creations[request.ID] != nil || len(p.creations) >= 4096 {
		p.mu.Unlock()
		return nil, errors.New("original birth producer cannot reserve another creation")
	}
	c := &creation{}
	p.creations[request.ID] = c
	p.mu.Unlock()
	inputs, err := Protect(p.policy, request, p.contract)
	if err != nil {
		return nil, err
	}
	channel, err := Dial(ctx, p.socket, p.digest, "qwen-k2-source-v1")
	if err == nil {
		_, err = channel.Call(ctx, Call{Action: "prepare", ID: request.ID}, inputs)
	}
	if err != nil {
		if channel != nil {
			err = errors.Join(err, channel.Close())
		}
		return nil, errors.Join(err, inputs.Abort(), inputs.Close())
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, errors.Join(errors.New("original producer closed during preparation"), channel.Close(), inputs.Abort(), inputs.Close())
	}
	c.inputs, c.channel = inputs, channel
	return c, nil
}

func (c *creation) Request() *task.CreateTaskRequest {
	return proto.Clone(c.inputs.Consumed).(*task.CreateTaskRequest)
}

func (c *creation) BindCreated(ctx context.Context, pid uint32) error {
	c.pid = pid
	if err := c.inputs.Verify(); err != nil {
		return err
	}
	_, err := c.channel.Call(ctx, Call{Action: "bind-created", ID: c.inputs.Original.ID, PID: pid}, c.inputs)
	return err
}

func (c *creation) BeforeStart(ctx context.Context, pid uint32) error {
	if pid != c.pid || c.inputs.Verify() != nil {
		return errors.New("original consumed inputs or created PID changed")
	}
	_, err := c.channel.Call(ctx, Call{Action: "before-start", ID: c.inputs.Original.ID, PID: pid}, nil)
	return err
}

func (c *creation) Started(ctx context.Context, pid uint32) error {
	if pid != c.pid {
		return errors.New("original started PID changed")
	}
	_, err := c.channel.Call(ctx, Call{Action: "started", ID: c.inputs.Original.ID, PID: pid}, nil)
	return err
}

func (c *creation) Cleanup(ctx context.Context, actual *task.DeleteResponse) error {
	if c.cleaned {
		if !proto.Equal(actual, c.deleted) {
			return errors.New("saved original Delete result changed")
		}
		return nil
	}
	if actual == nil || c.pid != 0 && actual.Pid != c.pid {
		return errors.New("actual original native deletion is required")
	}
	if c.deleted == nil {
		raw, err := proto.MarshalOptions{Deterministic: true}.Marshal(actual)
		if err != nil {
			return err
		}
		if _, err := c.channel.Call(ctx, Call{Action: "native-deleted", ID: c.inputs.Original.ID, PID: actual.Pid, Deleted: raw}, nil); err != nil {
			// Lost source authority closes physical release, while the real native Delete remains effective.
			log.G(ctx).Warn("original source Delete observation unavailable; disposing only the saved native inputs")
			_ = c.channel.Close()
		}
		c.deleted = proto.Clone(actual).(*task.DeleteResponse)
	} else if !proto.Equal(actual, c.deleted) {
		return errors.New("original Delete result cannot change during cleanup")
	}
	if err := c.inputs.CleanupDeleted(); err != nil {
		return err
	}
	if err := errors.Join(c.inputs.Close(), c.channel.Close()); err != nil {
		return err
	}
	c.cleaned = true
	return nil
}

// Close invalidates unfinished source associations without erasing live container inputs.
func (p *Producer) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	var result error
	for _, c := range p.creations {
		if c.channel != nil {
			result = errors.Join(result, c.channel.Close())
		}
	}
	return result
}
