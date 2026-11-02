# 本地 Web 对话框 + 会话持久化 设计文档

- 日期：2026-10-29
- 状态：已确认，待实施

## 一、背景与目标

现有 Agent 通过 `src/index.ts` 的命令行（`readline`）交互，存在两个问题：

1. **没有界面**：只能在终端里用，体验受限。
2. **重启即失忆**：`history` 是 `index.ts` 里的局部变量，进程退出后对话全部丢失。

本次要达成：

- 在浏览器里通过本地页面与 Agent 对话
- 对话历史持久化到磁盘，刷新页面或重启进程后仍可继续
- 不引入任何前端框架与新增运行时依赖

## 二、范围

**做：**

- 单会话续聊（全局一份历史，不做多会话管理）
- 本地 Web 页面（原生 HTML/CSS/JS）
- 会话持久化（单文件 JSON + 原子写）
- 工具调用轨迹的展示
- CLI 入口保留，与 Web 共享同一份存储

**不做（YAGNI）：**

- 流式输出（SSE）——留作后续，`runAgent` 加 `onEvent` 回调即可升级
- 多会话 / 会话列表 / 会话命名
- 用户体系、鉴权、远程访问
- 数据库（SQLite 等）
- Markdown 富文本渲染、代码高亮

## 三、架构

```
浏览器  public/index.html + app.js + style.css
   │    POST /api/chat      发送消息
   │    GET  /api/history   页面加载时取历史
   │    POST /api/clear     清空会话
   ▼
server.ts   Node 内置 http，零新增依赖
   │        路由 + 静态文件 + 请求体解析 + 串行队列
   ▼
store.ts    唯一持有 history 的模块
   │        内存一份，与磁盘同步（原子写）
   ▼
agent.ts    runAgent() 原样复用，不做改动
   ▼
tools.ts / memory.ts   不动
```

### 分层约定

- **`store.ts` 是 history 的唯一所有者。** CLI 与 Server 都只能通过它读写，避免两处各存一份导致不一致。
- **`agent.ts` 不感知持久化。** 它只接收 `history` 数组、返回新增消息，职责不变。
- **存储模型与视图模型分离。** 磁盘保真存储原始 `Message[]`；接口返回渲染用的投影结构。

## 四、数据模型与持久化

### 核心决策：磁盘存全量，裁剪只发生在构造 prompt 时

| 层 | 内容 | 是否裁剪 |
|---|---|---|
| 磁盘 `history.json` | 全量、完整、含工具中间消息 | 永不裁剪 |
| 内存 `history` 数组 | 与磁盘一致 | 永不裁剪 |
| 发给 LLM 的 messages | `trimHistory` + 摘要后的视图 | 每轮裁剪 |

理由：若存裁剪后的历史，被裁掉的对话永久消失；且 `MAX_HISTORY_TOKENS` 可调，调小再调大后无法找回内容。

现有代码已天然符合该模型——`runAgent` 内的 `trimHistory` 只影响构造出的 `messages`，从不修改传入的 `history`。

### 文件结构

```json
{
  "version": 1,
  "updatedAt": "2026-10-29T10:00:00.000Z",
  "messages": []
}
```

- 默认路径 `data/history.json`，可用环境变量 `HISTORY_FILE` 覆盖
- `version` 为将来格式迁移预留

### 写入策略

1. 每轮对话成功后写入
2. **原子写**：先写 `history.json.tmp`，再 `rename` 覆盖目标文件
3. 写入失败（权限、磁盘满）**只告警，不阻断对话**——内存继续可用
4. 读取时 JSON 解析失败：备份为 `.corrupt-<时间戳>`，以空历史启动并提示

### 保真要求

`Message` 是 OpenAI SDK 的联合类型，序列化再反序列化必须完全保真，尤其：

- `tool_calls` 数组及其 `id` / `function.name` / `function.arguments`
- `content: null`（带工具调用的 assistant 消息常见）
- `tool` 消息的 `tool_call_id`

任一字段丢失或变形，回放时消息结构不合法，API 会返回 400。

## 五、API 契约

| 方法 | 路径 | 入参 | 返回 |
|---|---|---|---|
| POST | `/api/chat` | `{ "message": string }` | `{ answer, toolTrace, count }` |
| GET | `/api/history` | — | `{ turns: [{ question, toolTrace, answer }] }` |
| POST | `/api/clear` | — | `{ ok: true }` |
| GET | `/` 及静态资源 | — | `public/` 下的文件 |

### 视图模型

```ts
interface ToolTraceItem {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

interface TurnView {
  question: string;
  toolTrace: ToolTraceItem[];
  answer: string;
}
```

`GET /api/history` **不返回原始 `Message[]`**：`tool_calls`、`tool_call_id` 属于内部结构，不应泄漏给前端。

### 请求体限制

请求体上限 64KB，超出返回 413。

## 六、并发模型

### 问题

用户双击回车或快速连发，会有两个请求同时进入。二者基于同一份 `history` 各自执行，后完成者覆盖先完成者，导致：

- 历史顺序错乱
- 若某一请求仍在等待工具结果，而另一请求已写入新消息，`tool_calls` 与 `tool` 结果配对错位 → 400

### 方案：服务端串行队列

```ts
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => {}); // 单次失败不阻断队列
  return run;
}
```

要点：`queue` 更新为 `run.catch(() => {})`，否则一次失败会让后续请求永久挂起。

前端按钮置灰只是体验优化，**服务端必须兜底**。

## 七、前端

### 文件

- `public/index.html` — 结构
- `public/style.css` — 样式
- `public/app.js` — 逻辑

### 交互

- `Enter` 发送，`Shift+Enter` 换行
- 请求进行中：发送按钮置灰，显示"正在思考…"
- 工具轨迹用 `<details>` 折叠，默认收起
- 新消息自动滚动到底部
- 清空按钮调用 `/api/clear`，需二次确认
- 页面加载时调用 `/api/history` 恢复历史

### 安全

**渲染一律使用 `textContent`，禁止 `innerHTML`。**

LLM 输出属于外部不可信内容，可能包含 `<img onerror=...>` 之类文本。使用 `innerHTML` 等于引入 XSS。站点零第三方脚本，无需为格式化牺牲安全。

## 八、错误处理

| 失败点 | 策略 |
|---|---|
| LLM 调用失败 | 返回 500 + 可读原因（复用 `index.ts` 的 `formatError`），前端渲染为醒目系统消息，不静默失败 |
| 磁盘写入失败 | 仅告警（stderr），不阻断对话 |
| `history.json` 损坏 | 备份为 `.corrupt-<时间戳>`，空历史启动并提示 |
| 静态文件路径穿越 | `path.normalize` 后校验仍在 `public/` 内，否则 403 |

### 服务端绑定

绑定 `127.0.0.1` 而非 `0.0.0.0`。本地工具不应暴露到局域网。

端口默认 3000，可用 `PORT` 覆盖。

## 九、测试

全部离线，不消耗 API 额度。

### `store-test.ts`

- **序列化保真**：`Message[]` 写入再读回，深比较必须完全相等（重点覆盖 `tool_calls`、`content: null`、`tool_call_id`）
- 原子写：临时文件不残留
- 损坏文件：被正确备份，返回空历史
- 清空：文件内容归零

### `server-test.ts`

将 `runAgent` 设计为可注入依赖，用假实现测试：

- 三个路由的正常路径
- 并发队列的串行性（同时发两个请求，断言不交叉执行）
- 单次任务失败后队列仍可用
- 路径穿越（`/../package.json`）被拦截
- 请求体超限返回 413

### 回归

现有 `mock-test.ts`、`memory-test.ts`、`timeout-test.ts` 保持通过。

## 十、文件清单

| 文件 | 动作 |
|---|---|
| `src/server.ts` | 新增：HTTP 服务、路由、静态文件、串行队列 |
| `src/store.ts` | 新增：`load` / `append` / `clear` / 视图投影 |
| `public/index.html` | 新增 |
| `public/style.css` | 新增 |
| `public/app.js` | 新增 |
| `src/store-test.ts` | 新增 |
| `src/server-test.ts` | 新增 |
| `src/index.ts` | 修改：改为通过 `store` 读写 history |
| `src/agent.ts` | 不改 |
| `src/tools.ts` / `src/memory.ts` | 不改 |
| `package.json` | 修改：新增 `dev:web` 脚本 |
| `data/history.json` | 运行时生成 |

## 十一、后续可选项

按价值排序，本轮不做：

1. **流式输出**：`runAgent` 增加 `onEvent` 回调，配 SSE 推送"正在调用某工具"
2. **LLM 生成摘要**：替换 `memory.ts` 中的机械拼接
3. **多会话管理**：引入会话 ID 与索引
4. **工具分类路由**：支撑几十个工具时的动态筛选
