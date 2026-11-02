import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Message } from './types.js';

/** 默认历史文件路径，可用 HISTORY_FILE 覆盖 */
export const DEFAULT_HISTORY_FILE =
  process.env.HISTORY_FILE ?? join('data', 'history.json');

const VERSION = 1;

interface HistoryFile {
  version: number;
  updatedAt: string;
  messages: Message[];
}

export interface LoadResult {
  messages: Message[];
  /** 若原文件损坏并被备份，这里是备份路径 */
  backupPath?: string;
}

export interface ToolTraceItem {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

export interface TurnView {
  question: string;
  toolTrace: ToolTraceItem[];
  answer: string;
}

/** 读取历史。文件缺失视为空；内容损坏则备份后返回空。 */
export function loadHistory(file = DEFAULT_HISTORY_FILE): LoadResult {
  if (!existsSync(file)) return { messages: [] };

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    // 路径不可读（例如本身是目录、权限不足）：空历史启动，不崩溃
    console.warn(`[警告] 无法读取历史文件（${file}）：${(err as Error).message}`);
    return { messages: [] };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<HistoryFile>;
    if (!Array.isArray(parsed.messages)) throw new Error('messages 字段缺失');
    return { messages: parsed.messages };
  } catch {
    const backupPath = `${file}.corrupt-${Date.now()}`;
    writeFileSync(backupPath, raw, 'utf8');
    return { messages: [], backupPath };
  }
}

/** 原子写入：先写临时文件，再覆盖目标，避免中途被中断留下半个文件。 */
export function saveHistory(
  messages: Message[],
  file = DEFAULT_HISTORY_FILE,
): void {
  mkdirSync(dirname(file), { recursive: true });

  const payload: HistoryFile = {
    version: VERSION,
    updatedAt: new Date().toISOString(),
    messages,
  };

  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  try {
    renameSync(tmp, file);
  } catch (err) {
    // 覆盖失败时清掉临时文件，避免残留
    try {
      unlinkSync(tmp);
    } catch {
      /* 忽略清理失败 */
    }
    throw err;
  }
}

/** 清空历史，但保留文件结构 */
export function clearHistory(file = DEFAULT_HISTORY_FILE): void {
  saveHistory([], file);
}

export interface HistoryStore {
  /** 内存中的全量历史，永不裁剪 */
  readonly messages: Message[];
  /** 从磁盘加载，返回备份信息（若文件损坏） */
  load(): LoadResult;
  /** 追加消息：先更新内存，再尝试落盘。写盘失败只告警，不阻断对话 */
  append(messages: Message[]): void;
  /** 清空会话 */
  clear(): void;
  /** 投影成前端渲染用的视图 */
  turns(): TurnView[];
}

/**
 * 创建唯一的 history 持有者。
 * CLI 与 HTTP 服务都通过它读写，避免两处各存一份导致不一致。
 */
export function createHistoryStore(file = DEFAULT_HISTORY_FILE): HistoryStore {
  let messages: Message[] = [];

  const persist = (context: string) => {
    try {
      saveHistory(messages, file);
    } catch (err) {
      console.warn(
        `[警告] ${context}：历史写入失败，仅保留在内存中（${(err as Error).message}）`,
      );
    }
  };

  return {
    get messages() {
      return messages;
    },
    load() {
      const result = loadHistory(file);
      messages = result.messages;
      return result;
    },
    append(msgs) {
      messages = [...messages, ...msgs];
      persist('追加历史');
    },
    clear() {
      messages = [];
      persist('清空历史');
    },
    turns() {
      return toTurns(messages);
    },
  };
}

interface RawToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

/**
 * 把原始消息投影成前端渲染用的视图模型。
 * 内部字段（tool_calls、tool_call_id）不外泄。
 */
export function toTurns(messages: Message[]): TurnView[] {
  const turns: TurnView[] = [];
  let current: TurnView | null = null;
  const pending = new Map<string, { name: string; args: Record<string, unknown> }>();

  for (const msg of messages) {
    if (msg.role === 'user') {
      current = {
        question: typeof msg.content === 'string' ? msg.content : '',
        toolTrace: [],
        answer: '',
      };
      turns.push(current);
      pending.clear();
      continue;
    }

    if (!current) continue;

    if (msg.role === 'assistant') {
      const m = msg as { content?: unknown; tool_calls?: RawToolCall[] };

      if (Array.isArray(m.tool_calls)) {
        for (const call of m.tool_calls) {
          if (call.type !== 'function') continue;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || '{}');
          } catch {
            args = {};
          }
          pending.set(call.id, { name: call.function.name, args });
        }
      }

      if (typeof m.content === 'string' && m.content) {
        current.answer = m.content;
      }
      continue;
    }

    if (msg.role === 'tool') {
      const call = pending.get(msg.tool_call_id);
      if (call) {
        current.toolTrace.push({
          name: call.name,
          args: call.args,
          result: typeof msg.content === 'string' ? msg.content : '',
        });
      }
    }
  }

  return turns;
}
