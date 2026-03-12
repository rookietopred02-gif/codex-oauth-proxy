package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
)

const (
	tempMailHomeURL      = "https://temp-mail.org/en/"
	tempMailAPIBase      = "https://web2.temp-mail.org"
	mailTMAPIBase        = "https://api.mail.tm"
	tempMailPollInterval = 4 * time.Second
	tempMailDefaultGap   = 15 * time.Second
	tempMailCreateWait   = 24 * time.Second
	mailTMDomainCacheTTL = 15 * time.Minute
	pollTimeout          = 180 * time.Second
	resendInterval       = 25 * time.Second
)

var (
	tempMailCodeRe        = regexp.MustCompile(`\b(\d{6})\b`)
	tempMailChatGPTCodeRe = regexp.MustCompile(`(?is)chatgpt[^A-Za-z0-9]{0,120}(\d{6})`)
	tempMailAfterCodeRe   = regexp.MustCompile(`(?is)[^A-Za-z0-9](\d{6})\b`)
	tempMailEmailRe       = regexp.MustCompile(`(?i)\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b`)
	tempMailService       = &tempMailRuntime{createGap: tempMailDefaultGap}
)

type tempMailConfig struct {
	Count            int    `json:"count"`
	Password         string `json:"password"`
	AllowParallel    bool   `json:"allow_parallel,omitempty"`
	Workers          int    `json:"workers,omitempty"`
	NextDelaySeconds *int   `json:"next_delay_seconds,omitempty"`
}

func normalizeConfig(cfg tempMailConfig) tempMailConfig {
	if cfg.Count < 1 {
		cfg.Count = 1
	}
	if cfg.Workers < 1 {
		cfg.Workers = 1
	}
	if cfg.NextDelaySeconds == nil {
		v := 15
		cfg.NextDelaySeconds = &v
	}
	if *cfg.NextDelaySeconds < 0 {
		v := 15
		cfg.NextDelaySeconds = &v
	}
	if *cfg.NextDelaySeconds > 300 {
		v := 300
		cfg.NextDelaySeconds = &v
	}
	return cfg
}

func (c tempMailConfig) PostSuccessDelaySeconds() int {
	if c.NextDelaySeconds == nil {
		return 15
	}
	if *c.NextDelaySeconds < 0 {
		return 15
	}
	if *c.NextDelaySeconds > 300 {
		return 300
	}
	return *c.NextDelaySeconds
}

func (c tempMailConfig) MailboxCreateGap() time.Duration {
	return time.Duration(c.PostSuccessDelaySeconds()) * time.Second
}

type tempMailRow struct {
	ID       string
	Received string
	Text     string
}

type tempMailboxResp struct {
	Token   string `json:"token"`
	Mailbox string `json:"mailbox"`
}

type tempMessagesResp struct {
	Mailbox  string                   `json:"mailbox"`
	Messages []map[string]interface{} `json:"messages"`
}

type mailTMHydraResp struct {
	Members []map[string]interface{} `json:"hydra:member"`
}

type tempMailRuntime struct {
	mu              sync.Mutex
	httpClient      *httpClient
	proxy           string
	createGap       time.Duration
	provider        string
	token           string
	currentMailbox  string
	firstServed     bool
	lastCreatedAt   time.Time
	mailTMDomain    string
	domainFetchedAt time.Time
	detailCache     map[string]string
}

func (s *tempMailRuntime) Configure(proxy string, cfg *tempMailConfig) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	proxy = strings.TrimSpace(proxy)
	if cfg == nil {
		s.createGap = tempMailDefaultGap
	} else {
		s.createGap = cfg.MailboxCreateGap()
	}
	if proxy != s.proxy {
		s.proxy = proxy
		s.httpClient = nil
	}
	return s.ensureReadyLocked(context.Background())
}

func (s *tempMailRuntime) ensureReadyLocked(ctx context.Context) error {
	if s.httpClient == nil {
		client, err := newHTTPClient(s.proxy)
		if err != nil {
			return fmt.Errorf("create temp mail http client failed: %w", err)
		}
		s.httpClient = client
	}
	if isValidMailbox(s.currentMailbox) && (s.token != "" || strings.EqualFold(s.provider, "mailtm")) {
		return nil
	}
	_, _, _ = s.httpClient.Get(tempMailHomeURL)
	if err := s.createOrRotateMailboxLocked(ctx, ""); err != nil {
		return err
	}
	s.firstServed = false
	return nil
}

func (s *tempMailRuntime) AcquireMailbox(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureReadyLocked(ctx); err != nil {
		return "", err
	}
	if !s.firstServed {
		s.firstServed = true
		if strings.EqualFold(s.provider, "mailtm") {
			if err := s.createMailTMMailboxLocked(ctx); err == nil {
				return s.currentMailbox, nil
			}
		}
		return s.currentMailbox, nil
	}
	if err := s.createFreshMailboxLocked(ctx, s.token); err != nil {
		return "", err
	}
	return s.currentMailbox, nil
}

func (s *tempMailRuntime) createFreshMailboxLocked(ctx context.Context, authToken string) error {
	previousMailbox := strings.TrimSpace(strings.ToLower(s.currentMailbox))
	if err := s.createOrRotateMailboxLocked(ctx, authToken); err != nil {
		return err
	}
	if previousMailbox != "" && strings.EqualFold(previousMailbox, strings.TrimSpace(strings.ToLower(s.currentMailbox))) {
		if strings.EqualFold(s.provider, "temp-mail") {
			emitLog("    Temp Mail reused mailbox; switching to mail.tm fallback.", "warning")
			if err := s.createMailTMMailboxLocked(ctx); err == nil {
				return nil
			}
		}
		return fmt.Errorf("failed to acquire a fresh mailbox; reuse blocked: %s", previousMailbox)
	}
	return nil
}

func (s *tempMailRuntime) createOrRotateMailboxLocked(ctx context.Context, authToken string) error {
	if strings.EqualFold(s.provider, "mailtm") {
		return s.createMailTMMailboxLocked(ctx)
	}
	if wait := s.createGap - time.Since(s.lastCreatedAt); wait > 0 {
		emitLog(fmt.Sprintf("    Temp Mail cooldown: waiting %ds...", int(wait.Seconds())+1), "dim")
		if err := sleepWithContext(ctx, wait); err != nil {
			return err
		}
	}

	extraHeaders := map[string]string{
		"Accept":       "application/json",
		"Content-Type": "application/json",
	}
	if strings.TrimSpace(authToken) != "" {
		extraHeaders["Authorization"] = "Bearer " + strings.TrimSpace(authToken)
	}

	var lastErr error
	deadline := time.Now().Add(tempMailCreateWait)
	for attempt := 1; ; attempt++ {
		status, body, err := s.httpClient.PostJSON(tempMailAPIBase+"/mailbox", map[string]interface{}{}, extraHeaders)
		if err != nil {
			lastErr = fmt.Errorf("request temp-mail mailbox failed: %w", err)
		} else if status == 429 {
			lastErr = fmt.Errorf("temp-mail mailbox rate limited: %d %s", status, truncate(body, 120))
			sleep := time.Duration(attempt*4) * time.Second
			if sleep > 45*time.Second {
				sleep = 45 * time.Second
			}
			emitLog(fmt.Sprintf("    Temp Mail rate limited, retry in %ds...", int(sleep.Seconds())), "warning")
			if time.Now().Add(sleep).After(deadline) {
				break
			}
			if err := sleepWithContext(ctx, sleep); err != nil {
				return err
			}
			continue
		} else if status < 200 || status >= 300 {
			lastErr = fmt.Errorf("request temp-mail mailbox failed: %d %s", status, truncate(body, 200))
		} else {
			var resp tempMailboxResp
			if err := json.Unmarshal([]byte(body), &resp); err != nil {
				lastErr = fmt.Errorf("parse temp-mail mailbox failed: %w", err)
			} else {
				resp.Token = strings.TrimSpace(resp.Token)
				resp.Mailbox = strings.TrimSpace(resp.Mailbox)
				if resp.Token == "" || !isValidMailbox(resp.Mailbox) {
					lastErr = fmt.Errorf("temp-mail did not return a usable mailbox")
				} else {
					s.token = resp.Token
					s.provider = "temp-mail"
					s.currentMailbox = resp.Mailbox
					s.lastCreatedAt = time.Now()
					return nil
				}
			}
		}

		sleep := time.Duration(attempt) * time.Second
		if sleep > 15*time.Second {
			sleep = 15 * time.Second
		}
		if time.Now().Add(sleep).After(deadline) {
			break
		}
		if err := sleepWithContext(ctx, sleep); err != nil {
			return err
		}
	}

	if s.validateCurrentMailboxLocked() {
		emitLog("    Temp Mail kept the current mailbox because fresh creation was rate limited.", "warning")
		return nil
	}

	errText := ""
	if lastErr != nil {
		errText = lastErr.Error()
	}
	if strings.Contains(strings.ToLower(errText), "rate") || strings.Contains(errText, "429") {
		emitLog("    Temp Mail switching to mail.tm fallback.", "warning")
		if err := s.createMailTMMailboxLocked(ctx); err == nil {
			return nil
		}
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("request temp-mail mailbox failed")
	}
	return lastErr
}

func (s *tempMailRuntime) tempMailGetLocked(path string) (int, string, error) {
	req, err := fhttp.NewRequest("GET", tempMailAPIBase+path, nil)
	if err != nil {
		return 0, "", err
	}
	s.httpClient.setGetHeaders(req)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.token)

	resp, err := s.httpClient.client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	s.httpClient.saveCookies(resp)
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b), nil
}

func (s *tempMailRuntime) fetchRowsLocked() (string, []tempMailRow, error) {
	if strings.EqualFold(s.provider, "mailtm") {
		return s.fetchRowsMailTMLocked()
	}
	var (
		status int
		body   string
		err    error
	)
	for attempt := 1; attempt <= 5; attempt++ {
		status, body, err = s.tempMailGetLocked("/messages")
		if err != nil {
			if attempt < 5 {
				time.Sleep(time.Duration(attempt) * time.Second)
				continue
			}
			return "", nil, err
		}
		if status == 429 {
			if attempt < 5 {
				wait := time.Duration(attempt*3) * time.Second
				emitLog(fmt.Sprintf("    Temp Mail message poll rate limited, retry in %ds...", int(wait.Seconds())), "warning")
				time.Sleep(wait)
				continue
			}
			break
		}
		if status == 401 || status == 403 {
			if rotateErr := s.createOrRotateMailboxLocked(context.Background(), ""); rotateErr != nil {
				return "", nil, rotateErr
			}
			status, body, err = s.tempMailGetLocked("/messages")
			if err != nil {
				return "", nil, err
			}
		}
		break
	}
	if status < 200 || status >= 300 {
		return "", nil, fmt.Errorf("read temp-mail messages failed: %d %s", status, truncate(body, 200))
	}

	var resp tempMessagesResp
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		return "", nil, fmt.Errorf("parse temp-mail messages failed: %w", err)
	}
	mailbox := strings.TrimSpace(resp.Mailbox)
	if isValidMailbox(mailbox) {
		s.currentMailbox = mailbox
	}

	rows := make([]tempMailRow, 0, len(resp.Messages))
	for idx, msg := range resp.Messages {
		row := tempMailRow{
			ID:       strings.TrimSpace(pickFirstNonEmpty(strFromAny(msg["id"]), strFromAny(msg["_id"]), strFromAny(msg["message_id"]))),
			Received: strings.TrimSpace(pickFirstNonEmpty(strFromAny(msg["created_at"]), strFromAny(msg["createdAt"]), strFromAny(msg["date"]), strFromAny(msg["timestamp"]), strFromAny(msg["time"]), strFromAny(msg["receivedAt"]), strFromAny(msg["sent_at"]))),
		}
		if row.ID == "" {
			row.ID = fmt.Sprintf("row-%d", idx)
		}
		if b, err := json.Marshal(msg); err == nil {
			row.Text = string(b)
		}
		rows = append(rows, row)
	}
	return mailbox, rows, nil
}

func (s *tempMailRuntime) createMailTMMailboxLocked(ctx context.Context) error {
	domain, err := s.fetchMailTMDomainLocked()
	if err != nil {
		return err
	}

	var (
		address string
		token   string
		lastErr error
	)
	for i := 0; i < 6; i++ {
		local := fmt.Sprintf("tm%d%x", time.Now().Unix()%1_000_000_000, rand.Intn(0xffff))
		address = strings.ToLower(strings.TrimSpace(local + "@" + domain))
		password := fmt.Sprintf("Qw%d!mT", 100000+rand.Intn(899999))

		status, body, reqErr := s.mailTMPostJSONLocked("/accounts", map[string]string{
			"address":  address,
			"password": password,
		}, "")
		if reqErr != nil {
			lastErr = fmt.Errorf("create mail.tm account failed: %w", reqErr)
			continue
		}
		if status < 200 || status >= 300 {
			if status == 422 {
				lastErr = fmt.Errorf("mail.tm address conflict")
				continue
			}
			lastErr = fmt.Errorf("create mail.tm account failed: %d %s", status, truncate(body, 180))
			continue
		}

		ts, tb, tokErr := s.mailTMPostJSONLocked("/token", map[string]string{
			"address":  address,
			"password": password,
		}, "")
		if tokErr != nil {
			lastErr = fmt.Errorf("fetch mail.tm token failed: %w", tokErr)
			continue
		}
		if ts < 200 || ts >= 300 {
			lastErr = fmt.Errorf("fetch mail.tm token failed: %d %s", ts, truncate(tb, 180))
			continue
		}
		var tok map[string]interface{}
		if err := json.Unmarshal([]byte(tb), &tok); err != nil {
			lastErr = fmt.Errorf("parse mail.tm token failed: %w", err)
			continue
		}
		token = strings.TrimSpace(strFromAny(tok["token"]))
		if token == "" {
			lastErr = fmt.Errorf("mail.tm token is empty")
			continue
		}
		break
	}
	if token == "" {
		if lastErr == nil {
			lastErr = fmt.Errorf("mail.tm mailbox creation failed")
		}
		return lastErr
	}

	s.provider = "mailtm"
	s.token = token
	s.currentMailbox = address
	s.lastCreatedAt = time.Now()
	s.detailCache = make(map[string]string)
	if ctx.Err() != nil {
		return errStoppedRun
	}
	return nil
}

func (s *tempMailRuntime) fetchMailTMDomainLocked() (string, error) {
	if domain := strings.TrimSpace(s.mailTMDomain); domain != "" && time.Since(s.domainFetchedAt) < mailTMDomainCacheTTL {
		return domain, nil
	}
	status, body, err := s.mailTMGetLocked("/domains?page=1", "")
	if err != nil {
		return "", fmt.Errorf("read mail.tm domains failed: %w", err)
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("read mail.tm domains failed: %d %s", status, truncate(body, 180))
	}
	var resp mailTMHydraResp
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		return "", fmt.Errorf("parse mail.tm domains failed: %w", err)
	}
	for _, d := range resp.Members {
		domain := strings.TrimSpace(strFromAny(d["domain"]))
		isActive := strings.EqualFold(strFromAny(d["isActive"]), "true") || strFromAny(d["isActive"]) == "1"
		if !isActive {
			if b, ok := d["isActive"].(bool); !ok || !b {
				continue
			}
		}
		if isValidMailbox("x@" + domain) {
			s.mailTMDomain = domain
			s.domainFetchedAt = time.Now()
			return domain, nil
		}
	}
	return "", fmt.Errorf("mail.tm has no usable domain")
}

func (s *tempMailRuntime) fetchRowsMailTMLocked() (string, []tempMailRow, error) {
	if strings.TrimSpace(s.token) == "" || !isValidMailbox(s.currentMailbox) {
		return "", nil, fmt.Errorf("mail.tm mailbox state is invalid")
	}
	status, body, err := s.mailTMGetLocked("/messages?page=1", s.token)
	if err != nil {
		return "", nil, fmt.Errorf("read mail.tm messages failed: %w", err)
	}
	if status < 200 || status >= 300 {
		return "", nil, fmt.Errorf("read mail.tm messages failed: %d %s", status, truncate(body, 200))
	}
	var resp mailTMHydraResp
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		return "", nil, fmt.Errorf("parse mail.tm messages failed: %w", err)
	}

	rows := make([]tempMailRow, 0, len(resp.Members))
	for idx, msg := range resp.Members {
		id := strings.TrimSpace(strFromAny(msg["id"]))
		if id == "" {
			id = fmt.Sprintf("row-%d", idx)
		}
		received := strings.TrimSpace(pickFirstNonEmpty(
			strFromAny(msg["createdAt"]),
			strFromAny(msg["created_at"]),
			strFromAny(msg["date"]),
		))
		text := ""
		if b, err := json.Marshal(msg); err == nil {
			text = string(b)
		}
		if extractTempMailCode(text) == "" && isTempMailCodeCandidate(text) {
			if s.detailCache == nil {
				s.detailCache = make(map[string]string)
			}
			if cached := strings.TrimSpace(s.detailCache[id]); cached != "" {
				text = cached
			} else {
				ds, db, derr := s.mailTMGetLocked("/messages/"+url.PathEscape(id), s.token)
				if derr == nil && ds >= 200 && ds < 300 {
					text = db
					s.detailCache[id] = db
				}
			}
		}
		rows = append(rows, tempMailRow{ID: id, Received: received, Text: text})
	}
	return s.currentMailbox, rows, nil
}

func (s *tempMailRuntime) mailTMGetLocked(path, bearer string) (int, string, error) {
	req, err := fhttp.NewRequest("GET", mailTMAPIBase+path, nil)
	if err != nil {
		return 0, "", err
	}
	req.Header = fhttp.Header{
		"user-agent":      {s.httpClient.userAgent},
		"accept":          {"application/ld+json, application/json;q=0.9, */*;q=0.8"},
		"accept-language": {"en-US,en;q=0.9"},
		"accept-encoding": {"gzip, deflate, br"},
	}
	if strings.TrimSpace(bearer) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(bearer))
	}
	resp, err := s.httpClient.client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	s.httpClient.saveCookies(resp)
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b), nil
}

func (s *tempMailRuntime) mailTMPostJSONLocked(path string, payload interface{}, bearer string) (int, string, error) {
	b, _ := json.Marshal(payload)
	req, err := fhttp.NewRequest("POST", mailTMAPIBase+path, strings.NewReader(string(b)))
	if err != nil {
		return 0, "", err
	}
	req.Header = fhttp.Header{
		"user-agent":      {s.httpClient.userAgent},
		"accept":          {"application/ld+json, application/json;q=0.9, */*;q=0.8"},
		"content-type":    {"application/json"},
		"accept-language": {"en-US,en;q=0.9"},
		"accept-encoding": {"gzip, deflate, br"},
	}
	if strings.TrimSpace(bearer) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(bearer))
	}
	resp, err := s.httpClient.client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	s.httpClient.saveCookies(resp)
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body), nil
}

func (s *tempMailRuntime) validateCurrentMailboxLocked() bool {
	if !isValidMailbox(s.currentMailbox) || s.httpClient == nil {
		return false
	}
	if strings.EqualFold(s.provider, "mailtm") {
		if strings.TrimSpace(s.token) == "" {
			return false
		}
		status, _, err := s.mailTMGetLocked("/messages?page=1", s.token)
		return err == nil && status >= 200 && status < 300
	}
	if strings.TrimSpace(s.token) == "" {
		return false
	}
	status, _, err := s.tempMailGetLocked("/messages")
	if err != nil {
		return false
	}
	return (status >= 200 && status < 300) || status == 429
}

func (s *tempMailRuntime) FindCode(ctx context.Context, expectedEmail string, minTime time.Time, seen map[string]struct{}) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureReadyLocked(ctx); err != nil {
		return "", err
	}
	mailbox, rows, err := s.fetchRowsLocked()
	if err != nil {
		return "", err
	}
	if expectedEmail != "" && isValidMailbox(mailbox) && !strings.EqualFold(expectedEmail, mailbox) {
		return "", fmt.Errorf("temp-mail mailbox changed: expected=%s current=%s", expectedEmail, mailbox)
	}
	return findBestTempMailCode(rows, minTime, seen), nil
}

func waitForTempMailCode(ctx context.Context, email string, otpSentAt time.Time, resendFn func() bool) (string, error) {
	minTime := otpSentAt.Add(-60 * time.Second)
	done := make(chan struct{})
	defer close(done)

	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(20 * time.Second):
		case <-done:
			return
		}
		if resendFn != nil {
			if resendFn() {
				emitLog("    OTP resent.", "info")
			}
		}
		ticker := time.NewTicker(resendInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-done:
				return
			case <-ticker.C:
				if resendFn != nil {
					if resendFn() {
						emitLog("    OTP resent.", "info")
					}
				}
			}
		}
	}()

	started := time.Now()
	seen := map[string]struct{}{}
	var lastWarnAt time.Time
	ticker := time.NewTicker(tempMailPollInterval)
	defer ticker.Stop()

	for {
		if ctx.Err() != nil {
			return "", errStoppedRun
		}
		code, err := tempMailService.FindCode(ctx, email, minTime, seen)
		if err != nil {
			if time.Since(lastWarnAt) > 10*time.Second {
				emitLog(fmt.Sprintf("    Temp Mail poll warning: %s", truncate(err.Error(), 120)), "warning")
				lastWarnAt = time.Now()
			}
		} else if code != "" {
			emitLog(fmt.Sprintf("    Verification code: %s (Temp Mail)", code), "success")
			return code, nil
		}

		if time.Since(started) >= pollTimeout {
			return "", fmt.Errorf("waiting for Temp Mail verification code timed out")
		}
		select {
		case <-ctx.Done():
			return "", errStoppedRun
		case <-ticker.C:
		}
	}
}

func extractTempMailCode(text string) string {
	if text == "" {
		return ""
	}
	clean := tempMailEmailRe.ReplaceAllString(text, " ")
	lower := strings.ToLower(clean)
	if !strings.Contains(lower, "chatgpt") {
		return ""
	}
	if m := tempMailChatGPTCodeRe.FindStringSubmatch(clean); len(m) > 1 {
		return m[1]
	}
	pos := strings.Index(lower, "chatgpt")
	if pos < 0 || pos >= len(clean) {
		return ""
	}
	tail := clean[pos:]
	if m := tempMailAfterCodeRe.FindStringSubmatch(tail); len(m) > 1 {
		return m[1]
	}
	if m := tempMailCodeRe.FindStringSubmatch(tail); len(m) > 1 {
		return m[1]
	}
	return ""
}

func isTempMailCodeCandidate(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	return strings.Contains(lower, "chatgpt") || strings.Contains(lower, "openai")
}

func findBestTempMailCode(rows []tempMailRow, minTime time.Time, seen map[string]struct{}) string {
	var bestCode string
	var bestTs time.Time
	for _, row := range rows {
		key := strings.TrimSpace(row.ID)
		if key == "" {
			key = row.Received + "|" + truncate(row.Text, 120)
		}
		if _, ok := seen[key]; ok {
			continue
		}
		ts := parseTempMailTime(row.Received)
		if !ts.IsZero() && ts.Before(minTime) {
			seen[key] = struct{}{}
			continue
		}
		code := extractTempMailCode(row.Text)
		if code == "" {
			if !isTempMailCodeCandidate(row.Text) {
				seen[key] = struct{}{}
			}
			continue
		}
		seen[key] = struct{}{}
		if ts.IsZero() {
			if bestCode == "" {
				bestCode = code
			}
			continue
		}
		if bestTs.IsZero() || ts.After(bestTs) {
			bestTs = ts
			bestCode = code
		}
	}
	return bestCode
}

func parseTempMailTime(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}
	}
	if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
		if n > 1_000_000_000_000 {
			return time.UnixMilli(n)
		}
		if n > 1_000_000_000 {
			return time.Unix(n, 0)
		}
	}
	if f, err := strconv.ParseFloat(raw, 64); err == nil {
		n := int64(f)
		if n > 1_000_000_000_000 {
			return time.UnixMilli(n)
		}
		if n > 1_000_000_000 {
			return time.Unix(n, 0)
		}
	}
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05",
		"2006-01-02 15:04:05 MST",
		"2006-01-02 15:04:05 -0700",
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, raw); err == nil {
			return t
		}
	}
	return time.Time{}
}

func isValidMailbox(mailbox string) bool {
	mailbox = strings.TrimSpace(strings.ToLower(mailbox))
	if mailbox == "" || !strings.Contains(mailbox, "@") || strings.Contains(mailbox, "loading") {
		return false
	}
	return true
}

func strFromAny(v interface{}) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(t), 'f', -1, 32)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case int32:
		return strconv.FormatInt(int64(t), 10)
	case json.Number:
		return t.String()
	default:
		return ""
	}
}

func pickFirstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
