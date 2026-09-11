# AICoder Go SDK

调用 AICoder 服务的 `/api/run` 与 `/api/health`。

## 用法

```go
package main

import (
	"context"
	"fmt"
	"time"

	"example.com/aicoder/sdk/go"
)

func main() {
	client := aicoder.NewClient("http://localhost:8787", "your-token")
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	result, err := client.Run(ctx, "统计 src 下的 TypeScript 文件数", aicoder.RunOptions{})
	if err != nil {
		panic(err)
	}
	fmt.Println(result.OK, result.Text, result.ToolCalls, result.Steps)
}
```

## 前置

```bash
aicoder web
```

默认地址 `http://localhost:8787`，令牌见启动输出或 `AICODER_TOKEN`。
