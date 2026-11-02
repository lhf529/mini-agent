/**
 * 工具超时与并发的离线测试，不消耗 API 额度。
 * 运行：npx tsx src/timeout-test.ts
 */
import type { Tool } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 复制 agent.ts 里的超时逻辑，便于独立测试 */
async function runWithTimeout(
  tool: Tool,
  args: Record<string, unknown>,
  defaultLimit = 10_000,
): Promise<string> {
  const limit = tool.timeoutMs ?? defaultLimit;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(
      () => resolve(`工具 ${tool.name} 执行超时（超过 ${limit}ms），请稍后重试或换个思路。`),
      limit,
    );
  });
  try {
    const execution = tool
      .execute(args)
      .catch((err) => `工具执行异常：${(err as Error).message}`);
    return await Promise.race([execution, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const fast: Tool = {
  name: 'fast',
  description: '',
  parameters: {},
  timeoutMs: 1000,
  execute: async () => {
    await sleep(100);
    return '快速工具完成';
  },
};

const slow: Tool = {
  name: 'slow',
  description: '',
  parameters: {},
  timeoutMs: 500,
  execute: async () => {
    await sleep(3000);
    return '慢工具完成';
  },
};

const crash: Tool = {
  name: 'crash',
  description: '',
  parameters: {},
  timeoutMs: 1000,
  execute: async () => {
    await sleep(50);
    throw new Error('内部故障');
  },
};

/** 超时后迟到的异常，用于验证不会变成 unhandled rejection */
const lateCrash: Tool = {
  name: 'lateCrash',
  description: '',
  parameters: {},
  timeoutMs: 200,
  execute: async () => {
    await sleep(800);
    throw new Error('迟到的异常');
  },
};

async function main() {
  console.log('=== 1. 正常工具（应成功）===');
  console.log(await runWithTimeout(fast, {}));

  console.log('\n=== 2. 慢工具（应超时）===');
  const t2 = Date.now();
  console.log(await runWithTimeout(slow, {}));
  console.log(`实际耗时 ${Date.now() - t2}ms（应接近 500ms，而不是 3000ms）`);

  console.log('\n=== 3. 崩溃工具（应捕获异常，不中断）===');
  console.log(await runWithTimeout(crash, {}));

  console.log('\n=== 4. 并发执行三个工具 ===');
  const t4 = Date.now();
  const results = await Promise.all([
    runWithTimeout(fast, {}),
    runWithTimeout(slow, {}),
    runWithTimeout(crash, {}),
  ]);
  const cost = Date.now() - t4;
  results.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  console.log(`并发总耗时 ${cost}ms`);
  console.log(`（串行会是 100+500+50=650ms 起，并发受最慢者限制约 500ms）`);

  console.log('\n=== 5. 迟到异常不会导致进程崩溃 ===');
  console.log(await runWithTimeout(lateCrash, {}));
  console.log('已立即返回超时结果，等待 1 秒观察是否崩溃…');
  await sleep(1000);
  console.log('进程存活，未出现 unhandled rejection。');
}

main();
