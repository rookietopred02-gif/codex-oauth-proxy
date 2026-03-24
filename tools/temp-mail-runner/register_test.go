package main

import (
	"encoding/base64"
	"testing"
	"time"
)

func TestExtractPageTypeDetailedFallbacks(t *testing.T) {
	if got := extractPageTypeDetailed(nil, "https://auth.openai.com/add-phone", ""); got != "add_phone" {
		t.Fatalf("expected add_phone from url, got %q", got)
	}

	body := `{"error":{"message":"cannot create your account with the given information"}}`
	if got := extractPageTypeDetailed(nil, "", body); got != "registration_disallowed" {
		t.Fatalf("expected registration_disallowed from body, got %q", got)
	}
}

func TestExtractContinueURL(t *testing.T) {
	data := map[string]interface{}{
		"page": map[string]interface{}{
			"continueUrl": "https://example.test/continue",
		},
	}
	if got := extractContinueURL(data); got != "https://example.test/continue" {
		t.Fatalf("extractContinueURL() = %q", got)
	}
}

func TestResolveWorkspaceIDFromCookie(t *testing.T) {
	payload := `{"workspaces":[{"id":"ws_123"}]}`
	cookie := base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"

	workspaceID, cookieData, err := resolveWorkspaceID(cookie)
	if err != nil {
		t.Fatalf("resolveWorkspaceID() error = %v", err)
	}
	if workspaceID != "ws_123" {
		t.Fatalf("workspaceID = %q", workspaceID)
	}
	if got := extractWorkspaceID(cookieData); got != "ws_123" {
		t.Fatalf("cookie workspace = %q", got)
	}
}

func TestOTPMinTime(t *testing.T) {
	sentAt := time.Date(2026, 3, 24, 21, 45, 19, 0, time.UTC)

	if got := otpMinTime(sentAt, otpWaitAllowClockSkew); !got.Equal(sentAt.Add(-60 * time.Second)) {
		t.Fatalf("allow skew min time = %s, want %s", got, sentAt.Add(-60*time.Second))
	}
	if got := otpMinTime(sentAt, otpWaitRequireFreshCode); !got.Equal(sentAt) {
		t.Fatalf("fresh code min time = %s, want %s", got, sentAt)
	}
}

func TestFindBestTempMailCodeStrictMinTimeSkipsOlderOTP(t *testing.T) {
	seen := map[string]struct{}{}
	minTime := time.Date(2026, 3, 24, 21, 45, 19, 0, time.UTC)

	rows := []tempMailRow{
		{
			ID:       "otp-old",
			Received: "2026-03-24T21:45:03Z",
			Text:     `{"mail_subject":"Your ChatGPT code is 508698","mail_from":"noreply@tm.openai.com"}`,
		},
		{
			ID:       "otp-new",
			Received: "2026-03-24T21:45:21Z",
			Text:     `{"mail_subject":"Your ChatGPT code is 113294","mail_from":"noreply@tm.openai.com"}`,
		},
	}

	if got := findBestTempMailCode(rows, minTime, seen); got != "113294" {
		t.Fatalf("expected newest OTP after minTime, got %q", got)
	}
}
