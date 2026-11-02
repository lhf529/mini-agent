import OpenAI from 'openai';
import { tools, toolsByName } from './tools.js';
import { trimHistory, splitTurns, summarize } from './memory.js';
import { DEFAULT_TOOL_TIMEOUT } from './types.js';
import type { Message, Tool } from './types.js';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const MODEL = process.env.MODEL ?? 'gpt-4o-mini';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 800;

/**
 * 带指数退避的调用封装。
 * 只重试「可恢复」的错误：限流(429)、服务端错误(5xx)、网络超时。
 * 认证失败(401)、参数错误(400) 属于配置问题，重试没有意义，直接抛出。
 */
async function callModel(messages: Message[], round: number) {
  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await client.chat.completions.create({
        model: MODEL,
        messages,
        tools: toolSchemas,
      });
    } catch (err) {
      lastErr = err;
      const e = err as { status?: number; cause?: { code?: string } };
      const code = e.cause?.code ?? '';
      const retryable =
        e.status === 429 ||
        (typeof e.status === 'number' && e.status >= 500) ||
        code.includes('TIMEOUT') ||
        code.includes('ECONNRESET');

      if (!retryable || attempt === MAX_RETRIES - 1) throw err;

      // 指数退避：800ms, 1600ms, ...
      const delay = RETRY_BASE_DELAY * 2 ** attempt;
      console.log(
        `  [重试] 第 ${round + 1} 轮请求失败（${e.status ?? code}），${delay}ms 后重试（${attempt + 1}/${MAX_RETRIES - 1}）`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastErr;
}

/** 单次工具调用的审计记录，方便调试 */
export interface StepLog {
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

export interface RunResult {
  answer: string;
  steps: StepLog[];
  /** 本轮新增的消息（含工具调用的中间消息），追加进 history 即可获得记忆 */
  messages: Message[];
}

/** 把内部 Tool 定义转成 OpenAI 需要的 function 格式 */
const toolSchemas = tools.map((t) => ({
  type: 'function' as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));

const SYSTEM_PROMPT = [
  '你是一个严谨的助手。',
  '需要外部信息或计算时，必须调用提供的工具，不要凭记忆编造。',
  '拿到工具结果后，用简洁的中文回答用户。',
  '',
  '【能力边界，必须严格遵守】',
  '1. 你只能通过提供的工具获取信息。工具查不到的内容，就是不知道。',
  '2. 禁止编造工具返回之外的事实，包括但不限于：手机号、地址、金额、时间、政策、他人隐私。',
  '3. 若用户询问的信息没有对应工具，或工具明确返回「未找到」，必须直接说明「我无法查询该信息」，',
  '   并简要说明需要什么工具才能做到。禁止用常识或推测补全答案。',
  '4. 禁止臆测对话之外的情境（例如声称自己"无法读取本地代码"之类用户从未提及的内容）。',
  '5. 区分「工具告诉我的」和「我自己的建议」：前者需有工具结果支撑，后者要明确标注为建议。',
  '',
  '【输出格式】',
  '回答用纯文本，不要使用 Markdown 语法：不要用 ** 加粗、不要用 # 标题、不要用 ``` 代码块。',
  '需要分点时用「- 」开头换行列举即可。',
].join('\n');

const MAX_ROUNDS = 8;
/** 历史消息的 token 预算，超出则从最早的轮开始丢弃。可用 MAX_HISTORY_TOKENS 覆盖 */
const MAX_HISTORY_TOKENS = Number(process.env.MAX_HISTORY_TOKENS) || 3000;

/**
 * 执行工具并施加超时。
 * 超时不会中断底层操作，但会立刻返回给 LLM 一个明确的失败信号，
 * 避免整个 Agent 卡在某个挂起的接口上。
 */
async function runWithTimeout(
  tool: Tool,
  args: Record<string, unknown>,
): Promise<string> {
  const limit = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(
      () => resolve(`工具 ${tool.name} 执行超时（超过 ${limit}ms），请稍后重试或换个思路。`),
      limit,
    );
  });

  try {
    // 即使超时先返回，也要吞掉迟到的异常，避免 unhandled rejection
    const execution = tool
      .execute(args)
      .catch((err) => `工具执行异常：${(err as Error).message}`);

    return await Promise.race([execution, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Agent 核心循环。
 * 每一轮：把历史消息发给 LLM → 若它要求调工具就执行并追加结果 → 否则返回最终回答。
 */
export async function runAgent(
  userInput: string,
  history: Message[] = [],
): Promise<RunResult> {
  // 先按预算裁剪历史，只保留最近的若干轮
  const { messages: kept, droppedTurns, tokens } = trimHistory(
    history,
    MAX_HISTORY_TOKENS,
  );

  if (process.env.DEBUG && droppedTurns > 0) {
    console.log(
      `  [调试] 历史裁剪：丢弃最早 ${droppedTurns} 轮，保留约 ${tokens} tokens`,
    );
  }

  // 被丢掉的早期对话压缩成摘要，挂在 system 提示后面，避免完全断片
  const dropped = droppedTurns > 0 ? summarize(splitTurns(history).slice(0, droppedTurns).flat()) : '';
  const systemContent = dropped
    ? `${SYSTEM_PROMPT}\n\n【早期对话摘要（已从上下文中移除）】\n${dropped}`
    : SYSTEM_PROMPT;

  const messages: Message[] = [
    { role: 'system', content: systemContent },
    ...kept,
    { role: 'user', content: userInput },
  ];

  // 本轮消息的起始下标：system(1) + 裁剪后历史长度
  const turnStart = 1 + kept.length;
  const steps: StepLog[] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const completion = await callModel(messages, round);

    const msg = completion.choices[0].message;
    // 关键：把助手这条消息原样追加进历史，包含 tool_calls 字段
    messages.push(msg);

    if (process.env.DEBUG) {
      console.log(
        `  [调试] 第 ${round + 1} 轮 LLM 返回: finish_reason=${completion.choices[0].finish_reason}` +
          `, tool_calls=${msg.tool_calls?.length ?? 0}` +
          `, content=${JSON.stringify(msg.content)}`,
      );
    }

    const calls = msg.tool_calls;
    if (!calls || calls.length === 0) {
      return {
        answer: msg.content ?? '',
        steps,
        messages: messages.slice(turnStart),
      };
    }

    const functionCalls = calls.filter((c) => c.type === 'function');

    // 并发执行本轮所有工具，每个工具各自独立超时、独立捕获异常
    const outcomes = await Promise.all(
      functionCalls.map(async (call) => {
        const name = call.function.name;
        let args: Record<string, unknown> = {};

        const tool = toolsByName.get(name);
        if (!tool) {
          return { call, name, args, result: `错误：不存在名为 ${name} 的工具` };
        }

        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          return { call, name, args, result: '错误：参数不是合法 JSON' };
        }

        console.log(
          `  [第 ${round + 1} 轮] 调用 ${name}(${JSON.stringify(args)})`,
        );

        const started = Date.now();
        const result = await runWithTimeout(tool, args);
        const cost = Date.now() - started;

        if (process.env.DEBUG) {
          console.log(`  [调试] ${name} 耗时 ${cost}ms`);
        }

        return { call, name, args, result };
      }),
    );

    // 按 LLM 给出的原始顺序回灌，保证 tool_call_id 一一对应
    for (const { call, name, args, result } of outcomes) {
      steps.push({ tool: name, args, result });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  
  return {
    answer: '已达到最大轮次仍未得出结论，请简化问题后重试。',
    steps,
    messages: messages.slice(turnStart),
  };
}
