package main

import "testing"

func TestIsPasswordlessUnavailable(t *testing.T) {
	body := `{"error":{"message":"Passwordless signup is unavailable. Please continue with a password."}}`
	if !isPasswordlessUnavailable(401, body) {
		t.Fatalf("expected passwordless unavailable to be detected")
	}
	if isPasswordlessUnavailable(400, body) {
		t.Fatalf("unexpected match for non-401 response")
	}
	if isPasswordlessUnavailable(401, `{"error":{"message":"other"}}`) {
		t.Fatalf("unexpected match for unrelated 401 response")
	}
}

func TestNormalizeRegisterPassword(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{name: "blank uses default", input: "", want: defaultRegisterPassword},
		{name: "legacy default is upgraded", input: "Qwer1234!", want: defaultRegisterPassword},
		{name: "valid password is kept", input: "Abcd1234!XYZ", want: "Abcd1234!XYZ"},
		{name: "short custom password is rejected", input: "short123!", wantErr: true},
	}

	for _, tc := range cases {
		got, err := normalizeRegisterPassword(tc.input)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("%s: expected error", tc.name)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", tc.name, err)
		}
		if got != tc.want {
			t.Fatalf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}
}

func TestExtractPageType(t *testing.T) {
	pageType := extractPageType(map[string]interface{}{
		"page": map[string]interface{}{
			"type": "email_otp_send",
		},
	})
	if pageType != "email_otp_send" {
		t.Fatalf("expected email_otp_send, got %q", pageType)
	}
}
