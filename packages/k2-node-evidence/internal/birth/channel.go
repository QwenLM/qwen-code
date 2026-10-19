package birth

import (
	"encoding/json"
	"errors"

	task "github.com/containerd/containerd/api/runtime/task/v3"
	"google.golang.org/protobuf/proto"
)

const ChannelVersion = "qwen-k2-pre-exec/1"
const MaxFrame = 64 << 10

type Call struct {
	Version     string `json:"version"`
	Sequence    uint64 `json:"sequence"`
	Action      string `json:"action"`
	ID          string `json:"id"`
	Association string `json:"association"`
	PID         uint32 `json:"pid"`
	Deleted     []byte `json:"deleted"`
}

type Reply struct {
	Version     string `json:"version"`
	Sequence    uint64 `json:"sequence"`
	Incarnation string `json:"incarnation"`
	RequestHash string `json:"requestHash"`
	Association string `json:"association"`
	Accepted    bool   `json:"accepted"`
}

func (c Call) Validate(sequence uint64) error {
	if c.Version != ChannelVersion || c.Sequence != sequence || sequence == 0 || sequence > 16 || !Hash(c.ID) {
		return errors.New("invalid pre-exec call identity")
	}
	if c.Action == "prepare" {
		if c.Association != "" || c.PID != 0 || len(c.Deleted) != 0 || sequence != 1 {
			return errors.New("invalid original preparation call")
		}
		return nil
	}
	if !Hash(c.Association) || c.PID == 0 {
		return errors.New("missing original pre-exec association")
	}
	switch c.Action {
	case "bind-created", "before-start", "started":
		if len(c.Deleted) != 0 {
			return errors.New("unexpected deletion fields")
		}
	case "native-deleted":
		var actual task.DeleteResponse
		if len(c.Deleted) == 0 || len(c.Deleted) > MaxInputs || proto.Unmarshal(c.Deleted, &actual) != nil || len(actual.ProtoReflect().GetUnknown()) != 0 || actual.Pid != c.PID || actual.ExitedAt == nil || actual.ExitedAt.CheckValid() != nil {
			return errors.New("original native deletion result is required")
		}
	default:
		return errors.New("unsupported pre-exec action")
	}
	return nil
}

func DecodeCall(raw []byte, sequence uint64) (Call, error) {
	var call Call
	if err := Decode(raw, &call, MaxFrame); err != nil {
		return Call{}, err
	}
	canonical, err := json.Marshal(call)
	if err != nil || string(canonical) != string(raw) || call.Validate(sequence) != nil {
		return Call{}, errors.New("pre-exec call is not a closed canonical frame")
	}
	return call, nil
}

func DecodeReply(raw, request []byte, sequence uint64, incarnation, association string) (Reply, error) {
	var reply Reply
	if Decode(raw, &reply, MaxFrame) != nil || reply.Version != ChannelVersion || reply.Sequence != sequence || !Hash(reply.Incarnation) || reply.RequestHash != SHA256(request) || !Hash(reply.Association) || !reply.Accepted || incarnation != "" && reply.Incarnation != incarnation || association != "" && reply.Association != association {
		return Reply{}, errors.New("original pre-exec source reply is unavailable")
	}
	canonical, err := json.Marshal(reply)
	if err != nil || string(canonical) != string(raw) {
		return Reply{}, errors.New("pre-exec reply is not a closed canonical frame")
	}
	return reply, nil
}
