import './config.js';
import { resolve } from 'node:path';
import { createHistoryStore, DEFAULT_HISTORY_FILE } from './store.js';
import { createServer } from './server.js';
import { runAgent } from './agent.js';

function main(): void {
  if (!process.env.OPENAI_API_KEY) {
    console.error('缺少 OPENAI_API_KEY，请先复制 .env.example 为 .env 并填写。');
    process.exit(1);
  }

  const store = createHistoryStore();
  const { backupPath } = store.load();

  if (backupPath) {
    console.warn(`[提示] 历史文件损坏，已备份到 ${backupPath}，以空历史启动。`);
  }

  const port = Number(process.env.PORT) || 3000;
  const server = createServer({
    store,
    runAgent,
    publicDir: resolve('public'),
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Agent Web 已启动：http://127.0.0.1:${port}`);
    console.log(`历史文件：${DEFAULT_HISTORY_FILE}（已加载 ${store.messages.length} 条消息）`);
    console.log('按 Ctrl+C 退出。');
  });
}

main();
