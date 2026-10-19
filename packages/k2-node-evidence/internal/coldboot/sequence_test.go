package coldboot

import (
	"errors"
	"reflect"
	"testing"
)

type fakeBoot struct {
	reached []string
	fail    string
}

func (f *fakeBoot) step(name string) error {
	f.reached = append(f.reached, name)
	if f.fail == name {
		return errors.New("injected failure")
	}
	return nil
}
func (f *fakeBoot) context() error      { return f.step("context") }
func (f *fakeBoot) retain() error       { return f.step("retain") }
func (f *fakeBoot) closeHelpers() error { return f.step("helpers") }
func (f *fakeBoot) dropModule() error   { return f.step("capabilities") }
func (f *fakeBoot) loadPolicy() error   { return f.step("load") }
func (f *fakeBoot) lockPolicy() error   { return f.step("lock") }
func (f *fakeBoot) ready() error        { return f.step("ready") }
func (f *fakeBoot) onExec() error       { return f.step("onexec") }
func (f *fakeBoot) exec() error         { return f.step("exec") }

func TestEveryFailureStopsBeforeAnyLaterOperation(t *testing.T) {
	steps := []string{"context", "retain", "helpers", "capabilities", "load", "lock", "ready", "onexec", "exec"}
	for i, step := range steps {
		t.Run(step, func(t *testing.T) {
			f := &fakeBoot{fail: step}
			if execute(f) == nil || !reflect.DeepEqual(f.reached, steps[:i+1]) {
				t.Fatal("failed stage advanced or retried", f.reached)
			}
		})
	}
	f := &fakeBoot{}
	if execute(f) == nil || !reflect.DeepEqual(f.reached, steps) {
		t.Fatal("a returning exec must never become success", f.reached)
	}
}
