import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/** 工具定义：给 LLM 看的说明书 + 真正执行的函数 */
export interface Tool {
  /** 工具名，LLM 用它来引用这个工具 */
  name: string;
  /** 描述，写得越清楚 LLM 越会用对 */
  description: string;
  /** JSON Schema 描述参数，LLM 靠它生成合法入参 */
  parameters: Record<string, unknown>;
  /** 实际执行逻辑，入参是 LLM 生成的参数对象 */
  execute: (args: Record<string, unknown>) => Promise<string>;
  /** 单个工具的超时毫秒数，默认 DEFAULT_TOOL_TIMEOUT */
  timeoutMs?: number;
}

/** 工具默认超时：10 秒 */
export const DEFAULT_TOOL_TIMEOUT = 10_000;

/** 对话消息，直接复用 OpenAI 的消息类型 */
export type Message = ChatCompletionMessageParam;
