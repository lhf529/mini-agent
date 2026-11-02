import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { HistoryStore } from './store.js';
import type { RunResult } from './agent.js';
import { formatError } from './errors.js';
import type { Message } from './types.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const DEFAULT_MAX_BODY = 64 * 1024;

export interface ServerOptions {
  store: HistoryStore;
  runAgent: (input: string, history: Message[]) => Promise<RunResult>;
  publicDir: string;
  /** 请求体上限，默认 64KB */
  maxBodyBytes?: number;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 读取请求体，超过上限时以 code='TOO_LARGE' 拒绝 */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(Object.assign(new Error('请求体过大'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (done) return;
      done = true;
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

/** 提供 public 目录下的静态文件，含路径穿越防护 */
function serveStatic(
  publicRoot: string,
  pathname: string,
  res: ServerResponse,
): void {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(publicRoot, rel);

  // 必须仍在 public 目录内
  if (target !== publicRoot && !target.startsWith(publicRoot + sep)) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }

  if (!existsSync(target) || !statSync(target).isFile()) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }

  const content = readFileSync(target);
  res.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': content.length,
  });
  res.end(content);
}

export function createServer(opts: ServerOptions): Server {
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const publicRoot = resolve(opts.publicDir);

  // 串行队列：同一时刻只处理一个对话请求，避免并发写乱 history
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    // 单次失败不能阻断后续请求
    queue = run.catch(() => {});
    return run;
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, maxBody);
    } catch (err) {
      if ((err as { code?: string }).code === 'TOO_LARGE') {
        sendJson(res, 413, { error: `请求体超过 ${maxBody} 字节上限` });
        return;
      }
      sendJson(res, 400, { error: '读取请求体失败' });
      return;
    }

    let message: string;
    try {
      const parsed = JSON.parse(raw) as { message?: unknown };
      if (typeof parsed.message !== 'string') throw new Error('message 必须是字符串');
      message = parsed.message.trim();
      if (!message) throw new Error('message 不能为空');
    } catch (err) {
      sendJson(res, 400, { error: `参数不合法：${(err as Error).message}` });
      return;
    }

    try {
      const result = await enqueue(() => opts.runAgent(message, opts.store.messages));

      opts.store.append(result.messages);

      sendJson(res, 200, {
        answer: result.answer,
        toolTrace: result.steps.map((s) => ({
          name: s.tool,
          args: s.args,
          result: s.result,
        })),
        count: opts.store.messages.length,
      });
    } catch (err) {
      sendJson(res, 500, { error: formatError(err) });
    }
  }

  return createHttpServer((req, res) => {
    void (async () => {
      const url = req.url ?? '/';

      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
      } catch {
        sendJson(res, 400, { error: '非法路径' });
        return;
      }

      const method = req.method ?? 'GET';

      if (pathname === '/api/chat') {
        if (method !== 'POST') {
          sendJson(res, 405, { error: '请使用 POST' });
          return;
        }
        await handleChat(req, res);
        return;
      }

      if (pathname === '/api/history') {
        if (method !== 'GET') {
          sendJson(res, 405, { error: '请使用 GET' });
          return;
        }
        sendJson(res, 200, {
          turns: opts.store.turns(),
          count: opts.store.messages.length,
        });
        return;
      }

      if (pathname === '/api/clear') {
        if (method !== 'POST') {
          sendJson(res, 405, { error: '请使用 POST' });
          return;
        }
        opts.store.clear();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: '接口不存在' });
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: '不支持的方法' });
        return;
      }

      serveStatic(publicRoot, pathname, res);
    })().catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: formatError(err) });
      else res.end();
    });
  });
}
