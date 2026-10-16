package roleboundary

import (
	"bytes"
	"io"
	"net/http"
)

const MaxJournalBytes = 64 << 20
const maxResponseBytes = ((MaxJournalBytes+2)/3)*4 + 1024

type guardedResponse struct {
	header http.Header
	sent   http.Header
	body   bytes.Buffer
	status int
	failed bool
}

func (w *guardedResponse) Header() http.Header { return w.header }
func (w *guardedResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		w.sent = w.header.Clone()
	}
}
func (w *guardedResponse) Write(raw []byte) (int, error) {
	if w.body.Len()+len(raw) > maxResponseBytes {
		w.failed = true
		return 0, io.ErrShortWrite
	}
	if w.status == 0 {
		_, contentType := w.header["Content-Type"]
		if !contentType && w.header.Get("Transfer-Encoding") == "" {
			w.header.Set("Content-Type", http.DetectContentType(raw))
		}
		w.WriteHeader(http.StatusOK)
	}
	return w.body.Write(raw)
}

// Handler checks actual role files before processing and before exposing a response.
// Its verifier is a deployment file check, never an installation or release grant.
func Handler(verify func() error, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if verify() != nil {
			http.Error(w, "original_role_files_unavailable", http.StatusConflict)
			return
		}
		response := &guardedResponse{header: make(http.Header)}
		next.ServeHTTP(response, r)
		if response.failed || verify() != nil {
			http.Error(w, "original_role_files_unavailable", http.StatusConflict)
			return
		}
		if response.status == 0 {
			response.WriteHeader(http.StatusOK)
		}
		for name, values := range response.sent {
			w.Header()[name] = values
		}
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(response.status)
		_, _ = w.Write(response.body.Bytes())
	})
}
