import './config.js';
import { createInterface } from 'node:readline/promises';
import { runAgent } from './agent.js';
import { createHistoryStore } from './store.js';
import { formatError } from './errors.js';

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('缺少 OPENAI_API_KEY，请先复制 .env.example 为 .env 并填写。');
    process.exit(1);
  }

  const store = createHistoryStore();
  const { backupPath } = store.load();
  if (backupPath) {
    console.warn(`[提示] 历史文件损坏，已备份到 ${backupPath}，以空历史启动。`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Agent 已启动（带记忆，已加载 ${store.messages.length} 条历史）。`);
  console.log('命令：/clear 清空记忆，exit 退出。');
  console.log('可以试试：北京天气怎么样？ 然后接着问「那上海呢？」\n');

  while (true) {
    const input = (await rl.question('你 > ')).trim();
    if (!input) continue;
    if (input === 'exit' || input === 'quit') break;

    if (input === '/clear') {
      store.clear();
      console.log('已清空对话记忆。\n');
      continue;
    }

    try {
      const { answer, steps, messages } = await runAgent(input, store.messages);
      store.append(messages);

      console.log(`\nAgent > ${answer}`);
      const meta = [`记忆 ${store.messages.length} 条`];
      if (steps.length) meta.unshift(`调用工具 ${steps.length} 次`);
      console.log(`（${meta.join('，')}）\n`);
    } catch (err) {
      console.error(formatError(err) + '\n');
    }
  }

  rl.close();
}

main();
