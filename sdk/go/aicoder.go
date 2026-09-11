// AICoder Go SDK
//
// 用法:
//
//	client := aicoder.NewClient("http://localhost:8787", "your-token")
//	result, err := client.Run(ctx, "统计 src 下的文件数", aicoder.RunOptions{})
//	fmt.Println(result.Text)
package aicoder

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Client 是 AICoder HTTP 客户端。
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// NewClient 创建客户端。
func NewClient(baseURL, token string) *Client {
	return &Client{
		BaseURL: baseURL,
		Token:   token,
		HTTP:    &http.Client{Timeout: 600 * time.Second},
	}
}

// RunOptions 控制单次执行。
type RunOptions struct {
	UseRAG     bool
	AllowWrite bool
}

// RunResult 是一次执行的返回。
type RunResult struct {
	OK        bool     `json:"ok"`
	Text      string   `json:"text"`
	ToolCalls []string `json:"toolCalls"`
	Steps     int      `json:"steps"`
	Error     string   `json:"error,omitempty"`
}

type runRequest struct {
	Message    string `json:"message"`
	UseRAG     bool   `json:"useRag"`
	AllowWrite bool   `json:"allowWrite"`
}

func (c *Client) do(ctx context.Context, method, path string, body interface{}) (*http.Response, error) {
	var buf *bytes.Buffer
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		buf = bytes.NewBuffer(data)
	} else {
		buf = bytes.NewBuffer(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	return c.HTTP.Do(req)
}

// Run 一次性执行任务。
func (c *Client) Run(ctx context.Context, message string, opts RunOptions) (*RunResult, error) {
	resp, err := c.do(ctx, http.MethodPost, "/api/run", runRequest{
		Message:    message,
		UseRAG:     opts.UseRAG,
		AllowWrite: opts.AllowWrite,
	})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var result RunResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Health 健康检查。
func (c *Client) Health(ctx context.Context) (map[string]interface{}, error) {
	resp, err := c.do(ctx, http.MethodGet, "/api/health", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}
