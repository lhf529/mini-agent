/**
 * server.ts 的测试。用真实 HTTP 请求打本地端口，只把 runAgent 换成假实现。
 * 运行：npx tsx src/server-test.ts
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { test, run, deepStrictEqual, strictEqual, ok } from './testkit.js';
import { createHistoryStore } from './store.js';
import { createServer } from './server.js';
import type { Message } from './types.js';

const dir = mkdtempSync(join(tmpdir(), 'agent-server-'));
let seq = 0;

/** 造一个带静态文件的临时 public 目录 */
function makePublic(files: Record<string, string> = { 'index.html': '<h1>hi</h1>' }) {
  const p = join(dir, `public-${++seq}`);
  mkdirSync(p, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(p, name), content, 'utf8');
  }
  return p;
}

interface Harness {
  base: string;
  close(): Promise<void>;
}

/** 启动服务并在用完后关闭 */
async function withServer(
  runAgent: (input: string, history: Message[]) => Promise<any>,
  fn: (h: Harness) => Promise<void>,
  opts: { publicDir?: string; maxBodyBytes?: number } = {},
): Promise<void> {
  const store = createHistoryStore(join(dir, `history-${++seq}.json`));
  store.load();

  const server = createServer({
    store,
    runAgent,
    publicDir: opts.publicDir ?? makePublic(),
    maxBodyBytes: opts.maxBodyBytes,
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  try {
    await fn({ base: `http://127.0.0.1:${port}`, close: async () => {} });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const okAgent = async (input: string): Promise<any> => ({
  answer: `收到：${input}`,
  steps: [],
  messages: [
    { role: 'user', content: input },
    { role: 'assistant', content: `收到：${input}` },
  ],
});

test('GET /api/history 初始为空', async () => {
  await withServer(okAgent, async ({ base }) => {
    const res = await fetch(`${base}/api/history`);
    strictEqual(res.status, 200);
    const body = (await res.json()) as { turns: unknown[] };
    deepStrictEqual(body.turns, []);
  });
});

test('POST /api/chat 返回回答并写入历史', async () => {
  await withServer(okAgent, async ({ base }) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好' }),
    });
    strictEqual(res.status, 200);

    const body = (await res.json()) as { answer: string; count: number };
    strictEqual(body.answer, '收到：你好');
    strictEqual(body.count, 2);

    const hist = (await (await fetch(`${base}/api/history`)).json()) as {
      turns: { question: string; answer: string }[];
    };
    strictEqual(hist.turns.length, 1);
    strictEqual(hist.turns[0].question, '你好');
    strictEqual(hist.turns[0].answer, '收到：你好');
  });
});

test('POST /api/chat 空消息返回 400', async () => {
  await withServer(okAgent, async ({ base }) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    strictEqual(res.status, 400);
  });
});

test('POST /api/chat 非法 JSON 返回 400', async () => {
  await withServer(okAgent, async ({ base }) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{不是JSON',
    });
    strictEqual(res.status, 400);
  });
});

test('请求体超过上限返回 413', async () => {
  await withServer(
    okAgent,
    async ({ base }) => {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'x'.repeat(2000) }),
      });
      strictEqual(res.status, 413);
    },
    { maxBodyBytes: 500 },
  );
});

test('POST /api/clear 清空历史', async () => {
  await withServer(okAgent, async ({ base }) => {
    await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好' }),
    });

    const res = await fetch(`${base}/api/clear`, { method: 'POST' });
    strictEqual(res.status, 200);

    const hist = (await (await fetch(`${base}/api/history`)).json()) as { turns: unknown[] };
    deepStrictEqual(hist.turns, []);
  });
});

test('并发请求被串行化，不会交叉执行', async () => {
  let active = 0;
  let maxActive = 0;

  const slowAgent = async (input: string): Promise<any> => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 40));
    active--;
    return { answer: input, steps: [], messages: [{ role: 'user', content: input }, { role: 'assistant', content: input }] };
  };

  await withServer(slowAgent, async ({ base }) => {
    const send = (message: string) =>
      fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });

    const [a, b] = await Promise.all([send('第一条'), send('第二条')]);
    strictEqual(a.status, 200);
    strictEqual(b.status, 200);
    strictEqual(maxActive, 1, '同时执行的 runAgent 数量必须为 1');
  });
});

test('一次请求失败后队列仍可用', async () => {
  let calls = 0;
  const flaky = async (input: string): Promise<any> => {
    calls++;
    if (calls === 1) throw new Error('模拟故障');
    return { answer: `ok:${input}`, steps: [], messages: [] };
  };

  await withServer(flaky, async ({ base }) => {
    const send = (message: string) =>
      fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });

    const first = await send('第一次');
    strictEqual(first.status, 500);

    const second = await send('第二次');
    strictEqual(second.status, 200, '失败后后续请求应正常处理');
    const body = (await second.json()) as { answer: string };
    strictEqual(body.answer, 'ok:第二次');
  });
});

test('失败响应包含可读的错误原因', async () => {
  const failAgent = async (): Promise<any> => {
    throw new Error('模型挂了');
  };

  await withServer(failAgent, async ({ base }) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好' }),
    });
    strictEqual(res.status, 500);
    const body = (await res.json()) as { error: string };
    ok(body.error.includes('模型挂了'), '错误信息应传给前端');
  });
});

test('静态文件正常返回且带正确 Content-Type', async () => {
  const publicDir = makePublic({
    'index.html': '<h1>hi</h1>',
    'app.js': 'console.log(1)',
    'style.css': 'body{}',
  });

  await withServer(
    okAgent,
    async ({ base }) => {
      const html = await fetch(`${base}/`);
      strictEqual(html.status, 200);
      ok(html.headers.get('content-type')?.includes('text/html'), 'html 的 Content-Type 应正确');

      const js = await fetch(`${base}/app.js`);
      strictEqual(js.status, 200);
      ok(js.headers.get('content-type')?.includes('javascript'), 'js 的 Content-Type 应正确');

      const css = await fetch(`${base}/style.css`);
      ok(css.headers.get('content-type')?.includes('text/css'), 'css 的 Content-Type 应正确');
    },
    { publicDir },
  );
});

test('路径穿越被拦截，无法读取 public 之外的文件', async () => {
  const publicDir = makePublic({ 'index.html': '<h1>hi</h1>' });
  // 在 public 的上一级放一个秘密文件
  writeFileSync(join(dir, 'secret.txt'), 'TOP_SECRET', 'utf8');

  await withServer(
    okAgent,
    async ({ base }) => {
      const res = await fetch(`${base}/%2e%2e/secret.txt`);
      const text = await res.text();

      ok(res.status === 403 || res.status === 404, `应为 403/404，实际 ${res.status}`);
      ok(!text.includes('TOP_SECRET'), '绝不能返回 public 之外的文件内容');
    },
    { publicDir },
  );
});

test('不存在的静态资源返回 404', async () => {
  await withServer(okAgent, async ({ base }) => {
    const res = await fetch(`${base}/nope.html`);
    strictEqual(res.status, 404);
  });
});

test('GET /api/chat 返回 405', async () => {
  await withServer(okAgent, async ({ base }) => {
    const res = await fetch(`${base}/api/chat`);
    strictEqual(res.status, 405);
  });
});

run();
