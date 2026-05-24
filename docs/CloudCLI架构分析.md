# CloudCLI 架构分析

> 项目：[@cloudcli-ai/cloudcli](https://github.com/siteboon/claudecodeui) v1.32.0
> 分析日期：2026-05-24

---

## 1. 项目概述

CloudCLI 是一个**自托管的 Web UI**，用于通过浏览器远程使用 Claude Code CLI（及其他 AI 编程 CLI 工具）。核心理念：在后端服务器上运行 CLI 进程，通过 WebSocket 实时推送输出到浏览器，用户获得与本地终端相同的体验。

**支持 4 种 Provider**：Claude（默认）、Cursor、Codex、Gemini。

---

## 2. 技术栈

| 层 | 技术 | 用途 |
|---|---|---|
| 后端运行时 | Node.js + Express | HTTP REST API + WebSocket 服务器 |
| 前端框架 | React 18 + Vite | SPA 构建 |
| 样式 | Tailwind CSS + CSS 变量 (HSL) | 暗色主题、响应式 |
| 终端 | node-pty + xterm.js (WebGL) | PTY 伪终端 + 前端渲染 |
| 数据库 | SQLite (better-sqlite3) | 用户、Session、项目、API Key |
| 认证 | JWT (jsonwebtoken) + bcrypt | Token 签发 + 密码哈希 |
| CLI 集成 | @anthropic-ai/claude-agent-sdk | 直接调用 Claude Code SDK |
| 代码编辑 | CodeMirror 6 | 内嵌代码编辑器 |
| 国际化 | react-i18next | 多语言支持 |
| 实时通信 | ws (WebSocket) | 双向消息推送 |

---

## 3. 系统架构总览

```
┌─────────────────────────────────────────────────────────┐
│                    浏览器 (React SPA)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ Sidebar  │ │ Chat UI  │ │  Shell   │ │ CodeEditor│  │
│  │ 项目/会话 │ │ 消息渲染  │ │ Terminal │ │ CodeMirror│  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
│         ▲            ▲           ▲            ▲          │
│         └────────────┴─────┬─────┴────────────┘          │
│                     WebSocket (ws://)                     │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────┐
│                 Node.js Express 服务器                     │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              WebSocket Server (单端口)              │   │
│  │  /ws  ├─ chat  (ChatWebSocketHandler)            │   │
│  │       └─ shell (ShellWebSocketHandler)           │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────┐ ┌──────────────┐ ┌────────────────────┐   │
│  │ REST API │ │ Provider     │ │ Session Manager    │   │
│  │ /api/*   │ │ Registry     │ │ (PTY 生命周期)      │   │
│  │          │ │ Claude/Cursor│ │                    │   │
│  │          │ │ /Codex/Gemini│ │ 30min 空闲超时      │   │
│  └──────────┘ └──────┬───────┘ └────────────────────┘   │
│                      │                                   │
│            ┌─────────┴─────────┐                        │
│            │ Claude Agent SDK  │                        │
│            │ (直接调用, 非子进程) │                        │
│            └───────────────────┘                        │
│                      │                                   │
│            ┌─────────┴─────────┐                        │
│            │ Claude Code CLI   │                        │
│            │ (node-pty 伪终端)  │                        │
│            └───────────────────┘                        │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              SQLite 数据库 (better-sqlite3)        │   │
│  │  users / sessions / projects / api_keys / ...     │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### 关键设计决策

1. **单一 WebSocket 服务器**：chat 和 shell 共享同一端口，通过消息中的字段区分路由
2. **双协议架构**：HTTP REST 用于 CRUD（项目、设置），WebSocket 用于实时流（聊天、终端）
3. **Provider Adapter 模式**：不同 CLI (Claude/Cursor/Codex/Gemini) 通过统一接口接入
4. **SDK 优先**：Claude 使用 `@anthropic-ai/claude-agent-sdk` 直接调用，不再 fork 子进程

---

## 4. 后端架构详解

### 4.1 服务器入口 (`server/index.js`)

```
Express App
├── 中间件：CORS, JSON(50mb), Helmet(部分)
├── 路由挂载
│   ├── /health              → 健康检查
│   ├── /api/auth/*          → JWT 认证 (login/register/refresh)
│   ├── /api/projects/*      → 项目管理
│   ├── /api/git/*           → Git 操作
│   ├── /api/taskmaster/*    → TaskMaster 集成
│   ├── /api/mcp-utils/*     → MCP 工具
│   ├── /api/commands/*      → 用户命令
│   ├── /api/settings/*      → 应用设置
│   ├── /api/user/*          → 用户管理
│   ├── /api/plugins/*       → 插件系统
│   ├── /api/providers/*     → Provider 管理
│   ├── /api/agent/*         → Agent API
│   └── /api/files/*         → 文件浏览/读取
├── WebSocket：/ws (upgrade)
│   ├── chat  → chat-websocket.service.ts
│   └── shell → shell-websocket.service.ts
├── 静态文件：dist/ (Svelte/Vite build)
│   ├── HTML：Cache-Control: no-cache
│   └── 资源：Cache-Control: immutable (含hash)
└── 启动模式检测
    ├── git 仓库 → npm run dev (开发)
    └── npm 全局包 → 已编译的 dist-server/
```

### 4.2 数据库 (SQLite)

**表结构**（通过 better-sqlite3 操作）：

| 表 | 核心字段 | 用途 |
|---|---|---|
| `users` | id, username, password_hash, role | 用户认证 |
| `sessions` | session_id, provider, project_path, jsonl_path, custom_name, is_archived | 会话索引 |
| `projects` | project_path, display_name, is_starred, is_archived | 项目注册 |
| `api_keys` | key_hash, user_id, name | API 密钥 |
| `credentials` | provider, api_key, user_id | Provider 凭证 |
| `app_config` | key, value | KV 配置存储 |
| `notification_preferences` | user_id, provider, kind | 通知偏好 |
| `push_subscriptions` | user_id, endpoint, p256dh, auth | Web Push |
| `scan_state` | project_path, provider, last_scanned_at | 项目扫描状态 |

### 4.3 Provider 系统（核心架构）

```
Provider Registry (provider.registry.ts)
├── claude  → ClaudeProvider
├── cursor  → CursorProvider
├── codex   → CodexProvider
└── gemini  → GeminiProvider

每个 Provider 实现 AbstractProvider，包含 5 个模块：
├── auth              → 认证检测、安装检查
├── sessions          → 消息规范化、历史加载 (核心)
├── sessionSynchronizer → Session 自动发现/同步
├── mcp               → MCP 服务器配置
└── skills            → 技能文件管理
```

**Claude Provider 的 Session 发现流程**：

```
1. 扫描项目目录：~/.claude/projects/<project-hash>/
2. 读取 *.jsonl 文件（Claude CLI 的对话记录）
3. 解析 JSONL → 提取 session_id
4. 写入 SQLite sessions 表 → 前端 Sidebar 可展示
```

**消息规范化 (ClaudeSessionsProvider.normalizeMessage)**：

```
Claude JSONL/Stream 事件 → NormalizedMessage

事件类型映射：
  user message (text)        → kind: 'text', role: 'user'
  user message (tool_result) → kind: 'tool_result'
  assistant message (text)   → kind: 'text', role: 'assistant'
  assistant message (tool_use)→ kind: 'tool_use'
  thinking block             → kind: 'thinking'
  system-reminder            → 过滤/跳过
  compact summary            → kind: 'text', role: 'assistant', isCompactSummary
  local command              → kind: 'text', role: 'user', isLocalCommand
  local command stdout       → kind: 'text', role: 'assistant', isLocalCommandStdout
  content_block_delta        → kind: 'stream_delta' (SSE 增量)
  content_block_stop         → kind: 'stream_end'
  permission_request         → kind: 'permission_request'
```

### 4.4 Claude SDK 集成 (`server/claude-sdk.js`)

**核心流程**：

```
用户发送消息 → WebSocket
  → chat-websocket.service.ts
    → queryClaudeSDK(command, options, ws)
      → mapCliOptionsToSDK(options)
        ├── 设置 environment (继承 process.env)
        ├── 设置 permissionMode (default/bypass/plan)
        ├── 设置 allowedTools / disallowedTools
        ├── 设置 model (sonnet/opus/haiku)
        ├── 设置 systemPrompt (preset: 'claude_code')
        ├── 设置 settingSources (project/user/local)
        └── 加载 MCP 配置 (从 ~/.claude.json)
      → 处理图片 (base64 → 临时文件)
      → 设置 hooks.Notification (Agent 通知)
      → 设置 canUseTool 回调
        ├── bypassPermissions 模式 → 自动允许
        ├── 非交互工具 → 检查 allowedTools/disallowedTools
        └── 其他 → 发送 permission_request → 等待用户批准
      → query({ prompt, options })  // SDK 调用
      → for await (message of queryInstance)
        ├── 捕获 session_id
        ├── sessionsService.normalizeMessage() → WS 发送
        └── 提取 token budget → WS 发送
      → 清理临时文件 + 发送 complete 事件
```

**工具审批流程**：

```
canUseTool 回调
  → ws.send(permission_request) → 前端弹出审批 UI
  → waitForToolApproval(requestId, timeout=55s)
    ├── 用户允许 (+ rememberEntry) → 写入 allowedTools
    ├── 用户拒绝 → 返回 deny
    └── 超时 → 返回 deny
  → 交互式工具 (AskUserQuestion/ExitPlanMode): timeout=0 (无限等待)
```

**Session 生命周期**：

```
activeSessions Map<sessionId, { instance, startTime, status, writer }>
├── queryClaudeSDK 开始时 → addSession
├── 流式输出中 → status='active'
├── 用户 abort → interrupt() → status='aborted'
├── 完成/异常 → removeSession
└── 重连 → reconnectSessionWriter (换绑 WebSocket)
```

### 4.5 WebSocket 服务

**Chat WebSocket** (`chat-websocket.service.ts`)：

```
handleChatConnection(ws, request, dependencies)

客户端消息类型：
  command          → 发送给 AI (prompt)
  options          → 设置 model/permissionMode/tools
  provider         → 切换 provider (claude/cursor/codex/gemini)
  sessionId        → 标记当前 session
  requestId        → 工具审批操作
  allow            → 允许工具执行
  updatedInput     → 修改后的输入
  rememberEntry    → 记住权限规则
  abort            → 中断执行
  get-pending-permissions → 恢复未决审批 (重连时)
  session:refresh  → 刷新会话列表
  session:switch   → 切换活动会话
  session:create   → 创建新会话
  session:delete   → 删除会话
  session:rename   → 重命名会话
```

**Shell WebSocket** (`shell-websocket.service.ts`)：

```
handleShellConnection(ws, dependencies)

客户端消息类型：
  init    → 初始化 PTY (projectPath, sessionId, provider, cols, rows)
            ├── 检查是否有现存 PTY → 复用 + 回放 buffer
            ├── 构建 shell 命令 (claude --resume / cursor-agent / codex / gemini)
            ├── 创建 PTY (node-pty.spawn)
            └── 设置 onData → buffer (环形 5000行) + WS 推流
  input   → 发送输入到 PTY (shellProcess.write)
  resize  → 调整终端大小 (shellProcess.resize)

PTY 生命周期：
  创建 → 复用 → WS 断开 → 30min 空闲 → kill
  重连 → 回放 buffer → 继续使用
```

### 4.6 Session 管理

**SessionManager** (`server/sessionManager.js`) — 仅用于 Gemini：

```
Map<sessions> (内存)
├── createSession(sessionId, projectPath) → 创建 + 持久化到 ~/.gemini/sessions/
├── addMessage(sessionId, role, content) → 追加消息 + 自动保存
├── getSessionMessages(sessionId) → 消息列表
└── 自动驱逐：max 100 sessions (LRU)
```

**注意**：Claude 的 session 由 Claude CLI 自己管理（`~/.claude/projects/` 下的 JSONL 文件），CloudCLI 只读取/索引，不写入。

---

## 5. 前端架构详解

### 5.1 App Shell

```
App.tsx
└── Providers (由外向内)
    ├── I18nextProvider (i18n)
    ├── ThemeProvider (暗色/亮色主题)
    ├── AuthProvider (JWT 认证)
    ├── WebSocketProvider (WS 连接 + 状态)
    ├── PluginsProvider (插件系统)
    ├── TasksSettingsProvider (TaskMaster 设置)
    └── TaskMasterProvider
        └── ProtectedRoute (未登录 → 登录页)
            └── Router (basename 可配置)
                └── AppContent
                    ├── PaletteOpsProvider (命令面板)
                    └── AppContentInner
                        ├── Sidebar (桌面固定/移动端 overlay)
                        ├── MainContent
                        │   ├── MainContentHeader (Tab 导航)
                        │   └── Tab 内容
                        │       ├── ChatInterface (chat tab)
                        │       ├── FileTree (files tab)
                        │       ├── StandaloneShell (shell tab)
                        │       ├── GitPanel (git tab)
                        │       ├── TaskMasterPanel (tasks tab)
                        │       └── PluginTabContent (plugin:* tabs)
                        ├── EditorSidebar (代码编辑器侧栏, CodeMirror)
                        └── CommandPalette (Ctrl+K 命令面板)
```

### 5.2 WebSocket Context

```typescript
// 单一 WebSocket 连接，全局共享
WebSocketContext {
  ws: WebSocket | null       // 当前连接
  sendMessage: (msg) => void // 发送 JSON 消息
  latestMessage: any         // 最新收到的消息
  isConnected: boolean       // 连接状态
}

// 自动重连：断开后 3s 重试
// Token 变更时自动重连
```

**消息分发**：`latestMessage` 更新 → 各组件 `useEffect` 监听 → 根据 `message.type` 路由处理。

### 5.3 Sidebar 结构

```
Sidebar
├── SidebarContent (折叠状态)
│   ├── 用户信息 + 项目搜索
│   ├── 项目列表 (可展开)
│   │   ├── 项目名称 + 星标/归档
│   │   └── Session 列表 (子项)
│   │       ├── Session 名称 (可重命名)
│   │       ├── 双击重命名
│   │       └── 右键删除
│   ├── 归档区域
│   └── 底部操作
│       ├── 新建项目
│       ├── 设置
│       └── 版本检查 (GitHub Release)
├── SidebarCollapsed (折叠态图标栏)
└── SidebarModals (模态框)
    ├── 新建项目
    ├── 删除确认
    ├── 版本更新提示
    └── 设置面板
```

### 5.4 Chat Interface (核心)

```
ChatInterface
├── ChatMessagesPane
│   ├── 消息列表 (虚拟滚动)
│   │   └── MessageComponent × N
│   │       ├── 用户消息 (右对齐气泡)
│   │       ├── 助手消息 (Markdown 渲染)
│   │       ├── 工具调用 (ToolRenderer)
│   │       │   ├── Bash → 终端输出 + 折叠
│   │       │   ├── Edit/Write → Diff 预览
│   │       │   ├── Read → 代码块
│   │       │   ├── WebSearch/WebFetch → 链接
│   │       │   ├── Task → 任务卡片
│   │       │   └── AskUserQuestion → 交互式问答
│   │       ├── 思考块 (Thinking, 可折叠)
│   │       ├── 错误消息
│   │       └── Token 用量指示器
│   ├── 滚动控制
│   │   ├── 自动跟随 (流式输出时)
│   │   ├── 用户手动上滚 → 暂停自动跟随
│   │   └── "回到底部" 按钮
│   └── 加载更多 (分页加载历史消息)
├── ChatComposer (输入区)
│   ├── 文本区域 (自动扩展高度)
│   ├── Provider 切换 (Claude/Cursor/Codex/Gemini)
│   ├── Model 选择 (sonnet/opus/haiku)
│   ├── Permission Mode 切换
│   ├── @文件 引用 (自动补全)
│   ├── / 命令菜单 (slash commands)
│   ├── 图片粘贴/拖拽上传
│   ├── Ctrl+Enter 发送 (可配置)
│   └── 停止生成 按钮
└── QuickSettingsPanel (快捷设置弹出)
```

**ChatInterface 使用的 Hooks**：

| Hook | 职责 |
|---|---|
| `useChatProviderState` | Provider/Model/PermissionMode 状态 |
| `useChatSessionState` | 消息历史、加载更多、滚动、Token |
| `useChatRealtimeHandlers` | WebSocket 实时消息处理 |
| `useChatComposerState` | 输入框、@文件、/命令、图片 |

### 5.5 消息类型 (ChatMessage)

```typescript
type ChatMessage = {
  // 基础
  type: 'user' | 'assistant' | 'tool' | 'error' | 'thinking'
  content: string
  timestamp: string

  // 工具相关
  isToolUse?: boolean
  toolName?: string        // Bash, Edit, Write, Read, WebSearch...
  toolInput?: object       // 工具参数
  toolResult?: {           // 工具结果
    content: string
    isError: boolean
    toolUseResult?: unknown
  }
  subagentTools?: object[] // 子 Agent 工具

  // 思考
  isThinking?: boolean     // Thinking block

  // 权限
  permissionRequest?: {
    requestId: string
    toolName: string
    input: object
  }

  // Token
  tokenBudget?: {
    used: number
    total: number
  }
}
```

### 5.6 样式系统

```css
/* CSS 变量 (HSL 颜色) */
:root, .dark {
  --background: 222.2 84% 4.9%;    /* 深蓝黑 */
  --foreground: 210 40% 98%;       /* 白色文字 */
  --card: 217.2 91.2% 8%;          /* 卡片背景 */
  --primary: 217.2 91.2% 59.8%;    /* 蓝色强调 */
  --secondary: 217.2 32.6% 17.5%;  /* 次级背景 */
  --muted: 217.2 32.6% 17.5%;      /* 静音背景 */
  --muted-foreground: 215 20.2% 65.1%; /* 静音文字 */
  --border: 217.2 32.6% 17.5%;     /* 边框 */
  --destructive: 0 62.8% 30.6%;    /* 危险/红色 */
  --radius: 0.5rem;                /* 圆角基准 */
}

/* Tailwind 映射 */
background  → hsl(var(--background))
foreground  → hsl(var(--foreground))
card        → hsl(var(--card))
primary     → hsl(var(--primary))
etc.
```

---

## 6. 数据流详解

### 6.1 聊天消息流 (完整链路)

```
用户输入 "帮我重构这个函数"
  │
  ├─ 1. ChatComposer 捕获输入
  │     → setInput + textareaRef
  │
  ├─ 2. 用户按 Enter/Ctrl+Enter 发送
  │     → sendMessage({ type: 'command', text: '帮我重构...', options: {...} })
  │     → WebSocket.send(JSON.stringify(msg))
  │
  ├─ 3. 后端 chat-websocket.service.ts 收到消息
  │     → 解析 provider / sessionId / 选项
  │     → 如果 provider === 'claude' → queryClaudeSDK(command, options, ws)
  │
  ├─ 4. claude-sdk.js 处理
  │     → mapCliOptionsToSDK(options)
  │     → query({ prompt, options })  // Anthropic SDK
  │     → for await (message of queryInstance)
  │
  ├─ 5. 消息归一化
  │     → sessionsService.normalizeMessage('claude', message, sessionId)
  │     → ClaudeSessionsProvider.normalizeMessage()
  │     → 输出 NormalizedMessage[]
  │
  ├─ 6. WebSocket 推送到前端
  │     → ws.send(JSON.stringify(normalizedMsg))
  │
  ├─ 7. 前端 WebSocketContext 接收
  │     → setLatestMessage(data)
  │
  ├─ 8. ChatInterface 处理
  │     → useChatRealtimeHandlers 监听 latestMessage
  │     → 根据 kind 分发：
  │       ├── 'stream_delta' → 追加到当前消息 content (SSE 增量)
  │       ├── 'text'         → addMessage (新消息)
  │       ├── 'tool_use'     → addMessage (工具调用)
  │       ├── 'tool_result'  → 更新对应 tool_use 的 toolResult
  │       ├── 'thinking'     → addMessage (思考块)
  │       ├── 'complete'     → 标记流结束
  │       └── 'error'        → 显示错误
  │
  └─ 9. MessageComponent 渲染
        ├── user 消息 → 右对齐气泡
        ├── assistant 消息 → Markdown 渲染
        ├── tool_use 消息 → ToolRenderer (Diff/终端/代码块)
        └── thinking 消息 → Reasoning 组件 (可折叠)
```

### 6.2 Shell PTY 流

```
1. 用户切换到 Shell tab
   → StandaloneShell 挂载
   → ws.send({ type: 'init', projectPath, sessionId, provider, cols, rows })

2. 后端 shell-websocket.service.ts
   → buildShellCommand() → 构建命令
     例：claude --resume "session-123" || claude
   → node-pty.spawn(shell, args, { cwd, env, cols, rows })

3. PTY onData 回调
   → buffer.push(chunk)  (最多 5000 行)
   → ws.send({ type: 'output', data: chunk })

4. 前端 xterm.js 渲染
   → terminal.write(data)

5. 用户输入
   → terminal.onData(callback) → ws.send({ type: 'input', data })

6. 窗口调整
   → terminal.onResize → ws.send({ type: 'resize', cols, rows })
   → pty.resize(cols, rows)

7. 断开
   → ws.on('close') → setTimeout(30min) → pty.kill()
   → 重连 → 复用 PTY + 回放 buffer
```

### 6.3 Session 发现流 (Claude)

```
1. 前端请求项目列表
   → GET /api/projects

2. 后端查询 SQLite projects 表
   → 返回注册项目

3. Session 同步 (后台)
   → ClaudeSessionSynchronizer
   → 扫描项目目录
     例：~/.claude/projects/-C-Users-Vincent-myproject/
   → 读取 agent-*.jsonl 文件
   → 提取 session_id
   → 写入 SQLite sessions 表

4. 前端获取 Session 列表
   → GET /api/projects/:id/sessions
   → 返回 sessions 列表 (含 session_id, name, last_activity)
```

### 6.4 重连恢复流

```
1. 前端 WebSocket 断开 (页面刷新/网络)
   → 3s 后自动重连

2. 重连成功
   → ws.send({ type: 'get-pending-permissions', sessionId })
   → 恢复未决的工具审批

3. Chat Session (SDK)
   → reconnectSessionWriter(sessionId, newRawWs)
   → 将 WebSocketWriter 换绑到新连接
   → 继续接收流式输出

4. Shell Session (PTY)
   → PTY 继续运行 (30min 超时前)
   → 重连 → 复用 → 回放 buffer
```

---

## 7. 关键设计模式

### 7.1 Provider Adapter 模式

```
IProvider (抽象接口)
├── id: LLMProvider
├── auth: IProviderAuth           → 认证/安装检查
├── sessions: IProviderSessions   → 消息规范化/历史加载
├── sessionSynchronizer           → Session 发现/同步
├── mcp: IProviderMcp            → MCP 配置
└── skills: IProviderSkills       → 技能管理

providerRegistry.resolveProvider('claude')
  → ClaudeProvider 实例
  → provider.sessions.normalizeMessage(raw, sessionId)
```

### 7.2 WebSocket 依赖注入

```javascript
// 所有依赖通过闭包注入到 WebSocket handler
handleChatConnection(ws, request, {
  queryClaudeSDK,        // Claude SDK 调用
  abortClaudeSDKSession, // 中断
  resolveToolApproval,   // 工具审批
  reconnectSessionWriter,// 重连
  // ...Cursor/Codex/Gemini 对应函数
});
```

### 7.3 前端 Context + Hooks 分层

```
Context 层 (全局状态)
├── WebSocketContext  → WS 连接 + 消息
├── AuthContext       → 认证/Token
├── ThemeContext      → 主题
├── PluginsContext    → 插件
└── TaskMasterContext → TaskMaster

Hooks 层 (业务逻辑)
├── useChatProviderState    → Provider/Model 状态
├── useChatSessionState     → 消息历史/滚动
├── useChatRealtimeHandlers → WS 消息处理
├── useChatComposerState    → 输入框/命令
└── useProjectsState        → 项目/Session/导航
```

---

## 8. 目录结构

```
claudecodeui-main/
├── package.json              # v1.32.0, @cloudcli-ai/cloudcli
├── vite.config.js            # Vite 构建配置
├── tailwind.config.js        # Tailwind + CSS 变量
│
├── server/                   # ── 后端 ──
│   ├── index.js              # Express 入口, 路由挂载, WS 启动
│   ├── claude-sdk.js         # Claude Agent SDK 集成 (核心)
│   ├── cursor-cli.js         # Cursor CLI 集成
│   ├── codex-cli.js          # Codex CLI 集成
│   ├── gemini-cli.js         # Gemini CLI 集成
│   ├── sessionManager.js     # PTY Session 管理器 (Gemini 用)
│   ├── shared/               # 共享工具
│   │   ├── modelConstants.js
│   │   ├── claude-cli-path.js
│   │   └── utils.js
│   ├── modules/
│   │   ├── websocket/services/
│   │   │   ├── chat-websocket.service.ts
│   │   │   └── shell-websocket.service.ts
│   │   ├── providers/        # Provider 系统
│   │   │   ├── provider.registry.ts
│   │   │   ├── provider.routes.ts
│   │   │   ├── list/
│   │   │   │   ├── claude/   # Claude Provider
│   │   │   │   │   ├── claude.provider.ts
│   │   │   │   │   ├── claude-sessions.provider.ts
│   │   │   │   │   ├── claude-auth.provider.ts
│   │   │   │   │   ├── claude-mcp.provider.ts
│   │   │   │   │   ├── claude-skills.provider.ts
│   │   │   │   │   └── claude-session-synchronizer.provider.ts
│   │   │   │   ├── cursor/
│   │   │   │   ├── codex/
│   │   │   │   └── gemini/
│   │   │   ├── services/     # Provider 服务
│   │   │   │   ├── sessions.service.ts
│   │   │   │   ├── session-synchronizer.service.ts
│   │   │   │   ├── sessions-watcher.service.ts
│   │   │   │   ├── mcp.service.ts
│   │   │   │   ├── provider-auth.service.ts
│   │   │   │   └── skills.service.ts
│   │   │   └── shared/base/  # 基类
│   │   │       └── abstract.provider.ts
│   │   ├── database/         # SQLite
│   │   │   ├── init-db.js
│   │   │   └── repositories/
│   │   │       ├── users.js
│   │   │       ├── sessions.db.js
│   │   │       ├── projects.db.js
│   │   │       ├── api-keys.js
│   │   │       └── ...
│   │   └── routes/           # REST API 路由
│
├── src/                      # ── 前端 (React) ──
│   ├── App.tsx               # App Shell + Provider 嵌套
│   ├── index.css             # Tailwind + CSS 变量 + 全局样式
│   ├── constants/            # 配置常量
│   ├── contexts/             # React Context
│   │   ├── WebSocketContext.tsx
│   │   ├── ThemeContext.tsx
│   │   ├── PluginsContext.tsx
│   │   └── TaskMasterContext.tsx
│   ├── hooks/                # 全局 Hooks
│   ├── stores/               # Zustand Store
│   ├── components/
│   │   ├── app/              # App Shell
│   │   │   └── AppContent.tsx
│   │   ├── sidebar/          # 侧边栏 (项目/会话)
│   │   │   ├── view/Sidebar.tsx
│   │   │   ├── hooks/
│   │   │   └── subcomponents/
│   │   ├── main-content/     # 主内容区 (Tab 管理)
│   │   │   ├── view/MainContent.tsx
│   │   │   └── subcomponents/
│   │   ├── chat/             # 聊天 (核心)
│   │   │   ├── view/ChatInterface.tsx
│   │   │   ├── hooks/
│   │   │   │   ├── useChatProviderState.ts
│   │   │   │   ├── useChatSessionState.ts
│   │   │   │   ├── useChatRealtimeHandlers.ts
│   │   │   │   └── useChatComposerState.ts
│   │   │   ├── subcomponents/
│   │   │   │   ├── ChatMessagesPane.tsx
│   │   │   │   ├── ChatComposer.tsx
│   │   │   │   ├── MessageComponent.tsx
│   │   │   │   └── Markdown.tsx
│   │   │   ├── tools/        # 工具渲染器
│   │   │   │   └── ToolRenderer.tsx
│   │   │   └── utils/
│   │   ├── file-tree/        # 文件浏览器
│   │   ├── standalone-shell/ # Shell 终端
│   │   ├── git-panel/        # Git 面板
│   │   ├── code-editor/      # 代码编辑器 (CodeMirror)
│   │   ├── plugins/          # 插件系统
│   │   ├── task-master/      # TaskMaster
│   │   ├── command-palette/  # 命令面板 (Ctrl+K)
│   │   ├── llm-logo-provider/# Provider Logo
│   │   ├── quick-settings-panel/
│   │   └── auth/             # 认证组件
│   ├── shared/view/ui/       # 共享 UI 组件
│   │   ├── Reasoning.tsx     # Thinking 组件
│   │   ├── Markdown.tsx      # Markdown 渲染
│   │   └── ...
│   └── i18n/                 # 国际化
│       └── config.js
│
└── public/                   # 静态资源 + PWA manifest
```

---

## 9. 配置与环境变量

| 变量 | 用途 | 默认值 |
|---|---|---|
| `CLAUDE_CLI_PATH` | Claude CLI 可执行文件路径 | 自动检测 |
| `CONTEXT_WINDOW` | Token 预算窗口 | 160000 |
| `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS` | 工具审批超时 | 55000 |
| `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` | 流关闭超时 | 300000 (5min) |
| `ANTHROPIC_BASE_URL` | Anthropic API 地址 | 官方 API |
| `NODE_ENV` | 运行环境 | development |
| `JWT_SECRET` | JWT 签名密钥 | (必填) |



