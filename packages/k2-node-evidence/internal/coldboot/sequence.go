// Package coldboot implements only the fixed first-systemd boot endpoint.
package coldboot

import "fmt"

type bootOperations interface {
	context() error
	retain() error
	closeHelpers() error
	dropModule() error
	loadPolicy() error
	lockPolicy() error
	ready() error
	onExec() error
	exec() error
}

// The injection boundary is package-private. Run always constructs real Linux
// operations; no argument, environment variable or installed field selects it.
func execute(o bootOperations) error {
	steps := []struct {
		name string
		run  func() error
	}{
		{"context", o.context}, {"retained inputs", o.retain}, {"helper closure", o.closeHelpers},
		{"module capability", o.dropModule}, {"single policy load", o.loadPolicy},
		{"policy lock", o.lockPolicy}, {"final verification", o.ready}, {"on-exec", o.onExec}, {"systemd exec", o.exec},
	}
	for _, step := range steps {
		if err := step.run(); err != nil {
			return fmt.Errorf("cold %s refused: %w", step.name, err)
		}
	}
	return fmt.Errorf("cold systemd exec unexpectedly returned")
}
