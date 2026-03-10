package main

import (
	"strings"
	"testing"
	"time"
)

func TestExtractTempMailCodePrefersChatGPTContext(t *testing.T) {
	text := `From: noreply@tm.openai.com Subject: 你的 ChatGPT 验证码为 039738`
	if got := extractTempMailCode(text); got != "039738" {
		t.Fatalf("expected 039738, got %q", got)
	}
}

func TestFindBestTempMailCodeSkipsNonCandidates(t *testing.T) {
	now := time.Now()
	seen := map[string]struct{}{}
	rows := []tempMailRow{
		{ID: "1", Received: now.Add(-10 * time.Second).Format(time.RFC3339), Text: `{"subject":"promo 123456"}`},
		{ID: "2", Received: now.Format(time.RFC3339), Text: `{"subject":"ChatGPT code 654321"}`},
	}
	if got := findBestTempMailCode(rows, now.Add(-time.Minute), seen); got != "654321" {
		t.Fatalf("expected 654321, got %q", got)
	}
	if _, ok := seen["1"]; !ok {
		t.Fatalf("expected non-candidate row to be marked seen")
	}
}

func TestNormalizeConfigBoundsDelay(t *testing.T) {
	cfg := normalizeConfig(tempMailConfig{
		Count:            0,
		Workers:          0,
		NextDelaySeconds: ptrInt(999),
	})
	if cfg.Count != 1 {
		t.Fatalf("expected count=1, got %d", cfg.Count)
	}
	if cfg.Workers != 1 {
		t.Fatalf("expected workers=1, got %d", cfg.Workers)
	}
	if cfg.PostSuccessDelaySeconds() != 300 {
		t.Fatalf("expected delay=300, got %d", cfg.PostSuccessDelaySeconds())
	}
}

func TestIsTempMailCodeCandidate(t *testing.T) {
	if !isTempMailCodeCandidate("ChatGPT security code") {
		t.Fatal("expected ChatGPT text to be candidate")
	}
	if isTempMailCodeCandidate("newsletter") {
		t.Fatal("did not expect unrelated text to be candidate")
	}
}

func TestExtractTempMailCodeRejectsEmailAddressDigits(t *testing.T) {
	text := "foo123456@example.com ChatGPT verification"
	if got := extractTempMailCode(text); got != "" {
		t.Fatalf("expected no code, got %q", got)
	}
}

func TestNormalizeWorkersRespectsParallelToggle(t *testing.T) {
	if got := normalizeWorkers(7, false); got != 1 {
		t.Fatalf("expected 1, got %d", got)
	}
	if got := normalizeWorkers(7, true); got != 7 {
		t.Fatalf("expected 7, got %d", got)
	}
}

func TestParseTempMailTimeSupportsUnixMillis(t *testing.T) {
	got := parseTempMailTime("1741587000000")
	if got.IsZero() {
		t.Fatal("expected parsed timestamp")
	}
	if !strings.Contains(got.UTC().Format(time.RFC3339), "2025") && !strings.Contains(got.UTC().Format(time.RFC3339), "2026") {
		t.Fatalf("unexpected parsed year: %s", got.UTC().Format(time.RFC3339))
	}
}

func ptrInt(v int) *int { return &v }
