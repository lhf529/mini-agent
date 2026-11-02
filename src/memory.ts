import type { Message } from './types.js';

/** 粗略估算 token：中文约 1 字 1 token，英文约 4 字符 1 token */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    tokens += /[\u4e00-\u9fa5]/.test(ch) ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

/** 估算单条消息的 token 数（含 tool_calls 等结构化字段） */
export function messageTokens(msg: Message): number {
  let total = 4; // 每条消息的固定开销
  const m = msg as { content?: unknown; tool_calls?: unknown };
  if (typeof m.content === 'string') total += estimateTokens(m.content);
  if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls));
  return total;
}

/**
 * 把消息数组按「轮」切分。
 * 一轮 = 一条 user 消息 + 其后的所有 assistant/tool 消息。
 * 这样切分才能保证 tool_calls 和对应的 tool 结果不被拆散。
 */
export function splitTurns(history: Message[]): Message[][] {
  const turns: Message[][] = [];
  let current: Message[] | null = null;

  for (const msg of history) {
    if (msg.role === 'user') {
      if (current) turns.push(current);
      current = [msg];
    } else if (current) {
      current.push(msg);
    } else {
      // 历史以非 user 消息开头（理论上不该发生），单独成组
      current = [msg];
    }
  }
  if (current) turns.push(current);

  return turns;
}

export interface TrimResult {
  messages: Message[];
  droppedTurns: number;
  tokens: number;
}

/**
 * 按 token 预算裁剪历史。
 * 从最早的一轮开始丢弃，直到总量落进预算；至少保留最近 minTurns 轮。
 */
export function trimHistory(
  history: Message[],
  maxTokens: number,
  minTurns = 2,
): TrimResult {
  const turns = splitTurns(history);
  const count = (list: Message[][]) =>
    list.reduce((sum, turn) => sum + turn.reduce((s, m) => s + messageTokens(m), 0), 0);

  let total = count(turns);
  let start = 0;

  // 从最早的轮开始丢，但始终保留最近 minTurns 轮
  while (start < turns.length - minTurns && total > maxTokens) {
    total -= turns[start].reduce((s, m) => s + messageTokens(m), 0);
    start++;
  }

  const kept = turns.slice(start).flat();
  return { messages: kept, droppedTurns: start, tokens: count(turns.slice(start)) };
}

/** 把历史压缩成一段文字摘要（用于丢掉的早期内容） */
export function summarize(history: Message[]): string {
  const lines: string[] = [];
  for (const msg of history) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      lines.push(`- 用户曾问：${msg.content}`);
    } else if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content) {
      lines.push(`  助手曾答：${msg.content.slice(0, 60)}${msg.content.length > 60 ? '…' : ''}`);
    }
  }
  return lines.join('\n');
}
