package roleboundary

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStableRoleForwardsActualResponseAndHeaders(t *testing.T) {
	checked := 0
	for _, status := range []int{http.StatusOK, http.StatusCreated, http.StatusNoContent, http.StatusForbidden} {
		checked = 0
		before := ""
		next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			before = r.Method + " " + r.URL.Path
			w.Header().Add("X-Original", "one")
			w.Header().Add("X-Original", "two")
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "public")
			w.WriteHeader(status)
			w.WriteHeader(http.StatusBadRequest)
			if status != http.StatusNoContent {
				_, _ = io.WriteString(w, "original response bytes")
			}
		})
		response := httptest.NewRecorder()
		Handler(func() error { checked++; return nil }, next).ServeHTTP(response, httptest.NewRequest("GET", "/v1/journal", nil))
		if checked != 2 || before != "GET /v1/journal" || response.Code != status || strings.Join(response.Header().Values("X-Original"), ",") != "one,two" || response.Header().Get("Content-Type") != "application/json" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("stable actual response changed")
		}
		if status == http.StatusNoContent && response.Body.Len() != 0 || status != http.StatusNoContent && response.Body.String() != "original response bytes" {
			t.Fatal("actual response body changed")
		}
	}
}

func TestFileFailureBeforeProcessingSendsNoAuthorityOperation(t *testing.T) {
	called := false
	response := httptest.NewRecorder()
	Handler(func() error { return errors.New("declared unavailable file") }, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	})).ServeHTTP(response, httptest.NewRequest("POST", "/v1/arm", nil))
	if called || response.Code != http.StatusConflict || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("unavailable role reached the operation")
	}
}

func TestBufferPreservesFirstHeaderAndImplicitContentType(t *testing.T) {
	for _, next := range []http.Handler{
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("X-Original", "before")
			w.WriteHeader(http.StatusCreated)
			w.Header().Set("X-Original", "after")
			w.Header().Set("X-Late", "not published")
			_, _ = io.WriteString(w, "original")
		}),
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ordinary text") }),
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header()["Content-Type"] = nil
			_, _ = io.WriteString(w, "explicitly absent content type")
		}),
	} {
		original := httptest.NewRecorder()
		next.ServeHTTP(original, httptest.NewRequest("GET", "/v1/runtime", nil))
		guarded := httptest.NewRecorder()
		Handler(func() error { return nil }, next).ServeHTTP(guarded, httptest.NewRequest("GET", "/v1/runtime", nil))
		before, after := original.Result(), guarded.Result()
		for _, key := range []string{"Content-Type", "X-Original", "X-Late"} {
			if before.Header.Get(key) != after.Header.Get(key) {
				t.Fatalf("first response header changed: %s", key)
			}
		}
		if before.StatusCode != after.StatusCode || !bytes.Equal(original.Body.Bytes(), guarded.Body.Bytes()) {
			t.Fatal("buffer changed actual status or body")
		}
		before.Body.Close()
		after.Body.Close()
	}
}

func TestFileFailureDuringProcessingDoesNotExposeSavedSuccess(t *testing.T) {
	checks := 0
	response := httptest.NewRecorder()
	Handler(func() error {
		checks++
		if checks == 2 {
			return errors.New("declared file changed during operation")
		}
		return nil
	}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Success", "saved authority response")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, "must remain private until the role recheck")
	})).ServeHTTP(response, httptest.NewRequest("POST", "/v1/stop", nil))
	if checks != 2 || response.Code != http.StatusConflict || response.Header().Get("X-Success") != "" || strings.Contains(response.Body.String(), "must remain private") {
		t.Fatal("changed role exposed the buffered response")
	}
}

func TestResponseLimitCannotBeBypassedByAnIgnoredWriteError(t *testing.T) {
	response := httptest.NewRecorder()
	Handler(func() error { return nil }, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, err := w.Write(bytes.Repeat([]byte{'x'}, maxResponseBytes+1))
		if !errors.Is(err, io.ErrShortWrite) {
			t.Fatal("oversized response was buffered")
		}
		_, _ = io.WriteString(w, "success after ignored overflow")
	})).ServeHTTP(response, httptest.NewRequest("GET", "/v1/journal", nil))
	if response.Code != http.StatusConflict || strings.Contains(response.Body.String(), "success after") {
		t.Fatal("an ignored overflow exposed success")
	}
}
