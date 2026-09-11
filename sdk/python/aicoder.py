"""AICoder Python SDK

用法:
    from aicoder import AICoder

    client = AICoder(base_url="http://localhost:8787", token="your-token")
    result = client.run("统计 src 下的文件数")
    print(result["text"])
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Optional
from urllib import request, error


@dataclass
class RunResult:
    ok: bool
    text: str
    tool_calls: list[str]
    steps: int
    error: Optional[str] = None


class AICoderError(Exception):
    pass


class AICoder:
    """AICoder HTTP 客户端（同步）。"""

    def __init__(
        self,
        base_url: str = "http://localhost:8787",
        token: Optional[str] = None,
        timeout: float = 600.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        data = json.dumps(payload).encode("utf-8")
        req = request.Request(url, data=data, headers=self._headers(), method="POST")
        try:
            with request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            raise AICoderError(f"HTTP {e.code}: {body}") from e
        except error.URLError as e:
            raise AICoderError(f"连接失败: {e.reason}") from e

    def run(self, message: str, use_rag: bool = False, allow_write: bool = False) -> RunResult:
        """一次性执行任务，返回最终文本与统计。"""
        data = self._post(
            "/api/run",
            {"message": message, "useRag": use_rag, "allowWrite": allow_write},
        )
        return RunResult(
            ok=bool(data.get("ok")),
            text=data.get("text", ""),
            tool_calls=data.get("toolCalls", []),
            steps=data.get("steps", 0),
            error=data.get("error"),
        )

    def health(self) -> dict[str, Any]:
        """健康检查。"""
        url = f"{self.base_url}/api/health"
        try:
            with request.urlopen(url, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except error.URLError as e:
            raise AICoderError(f"连接失败: {e.reason}") from e
