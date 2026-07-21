# 接口文档（轻量 backend API）

描述仓库 `backend/` 轻量 FastAPI 提供的接口、请求参数、返回结构与示例。完整 SaaS / AIOps 能力见 `saas_api/`。

---

## 运行与 Base URL

### 默认端口

- **后端**：`http://127.0.0.1:8030`
- **前端**：`http://127.0.0.1:5173`

### 前端代理（推荐）

前端开发环境通过 Vite 代理把 `/api/*` 转发到后端（见 `frontend/vite.config.ts`）：

- 前端调用：`/api/health` → 实际后端：`GET http://127.0.0.1:8030/health`
- 前端调用：`/api/chat` → 实际后端：`POST http://127.0.0.1:8030/chat`
- 前端调用：`/api/models` → 实际后端：`GET http://127.0.0.1:8030/models`

如果你不用前端代理，也可以直接请求后端 `/health` `/chat` `/models`。

---

## 通用说明

- **Content-Type**：
  - JSON 请求：`application/json`
  - 流式响应：`text/plain; charset=utf-8`
- **CORS**：后端允许来自 `http://127.0.0.1:5173` 等本地地址访问（见 `backend/app/main.py`）。
- **Ollama**：
  - 默认地址：`http://127.0.0.1:11434`（可用环境变量 `OLLAMA_BASE_URL` 覆盖）
  - 默认模型：`qwen2.5-coder:1.5b`（可用 `OLLAMA_MODEL` 覆盖）

---

## 1) 健康检查

### `GET /health`

用于探测后端是否启动成功。

#### 响应（JSON）

- **200 OK**

```json
{
  "ok": true,
  "port": "8030"
}
```

#### 示例

```bash
curl http://127.0.0.1:8030/health
```

---

## 2) 模型服务健康检查（Ollama）

### `GET /model/health`

用于探测后端是否能连通 Ollama（调用 `/api/tags`）。

#### 响应（JSON）

- **200 OK**（无论成功失败都会返回 200，靠 `ok` 字段判断）

成功示例：

```json
{
  "ok": true,
  "status": 200,
  "url": "http://127.0.0.1:11434/api/tags",
  "model": "qwen2.5-coder:1.5b"
}
```

失败示例：

```json
{
  "ok": false,
  "error": "...",
  "url": "http://127.0.0.1:11434/api/tags",
  "model": "qwen2.5-coder:1.5b"
}
```

#### 示例

```bash
curl http://127.0.0.1:8030/model/health
```

---

## 3) 获取可用模型列表

### `GET /models`

返回 Ollama 当前已安装/可用的模型（来自 Ollama `/api/tags`）。

#### 响应（JSON）

- **200 OK**

成功示例：

```json
{
  "ok": true,
  "models": ["qwen2.5-coder:1.5b", "gpt-oss:20b"],
  "default": "qwen2.5-coder:1.5b"
}
```

失败示例：

```json
{
  "ok": false,
  "error": "...",
  "models": [],
  "default": "qwen2.5-coder:1.5b"
}
```

#### 示例

```bash
curl http://127.0.0.1:8030/models
```

---

## 4) 聊天（流式）

### `POST /chat`

向模型发送一条消息，后端以 **流式纯文本** 返回 assistant 的增量输出。

#### 请求体（JSON）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `session_id` | string | 否 | 会话 ID（前端用于归档/持久化） |
| `message` | string | 是 | 用户输入文本 |
| `model` | string | 否 | 选择的模型名；为空则使用默认模型（`OLLAMA_MODEL` 或 `qwen2.5-coder:1.5b`） |

示例：

```json
{
  "session_id": "s_123",
  "message": "请用三句话解释什么是 FastAPI。",
  "model": "qwen2.5-coder:1.5b"
}
```

#### 响应（Streaming）

- `Content-Type: text/plain; charset=utf-8`
- 流内容是 **纯文本**（不是 SSE，也不是 JSON lines）
- 前端应使用 `fetch().body.getReader()` 逐段读取并拼接显示

> 若 Ollama 不可用：后端会先输出中文提示（“未检测到本地模型服务…”），然后输出一个占位的流式回复（用于 UI 验证链路）。

#### 示例（curl）

```bash
curl -N http://127.0.0.1:8030/chat ^
  -H \"Content-Type: application/json\" ^
  -d \"{\\\"session_id\\\":\\\"s_123\\\",\\\"message\\\":\\\"Hello\\\",\\\"model\\\":\\\"qwen2.5-coder:1.5b\\\"}\"\n+```

---

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 后端端口（脚本会设置） | 空 |
| `OLLAMA_BASE_URL` | Ollama 服务地址 | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | 默认模型名 | `qwen2.5-coder:1.5b` |


