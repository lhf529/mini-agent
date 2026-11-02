/**
 * store.ts 的测试。全部使用真实文件 IO，位于系统临时目录，不触碰项目数据。
 * 运行：npx tsx src/store-test.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, run, deepStrictEqual, strictEqual, ok } from './testkit.js';
import { loadHistory, saveHistory, clearHistory, toTurns, createHistoryStore } from './store.js';
import type { Message } from './types.js';

const dir = mkdtempSync(join(tmpdir(), 'agent-store-'));
let seq = 0;
/** 每个用例用独立文件，避免相互污染 */
const newFile = () => join(dir, `history-${++seq}.json`);

/** 含工具调用的一轮对话，重点验证序列化保真 */
const sampleTurn: Message[] = [
  { role: 'user', content: '张三的快递到哪了' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_order', arguments: '{"userName":"张三"}' },
      },
    ],
  },
  { role: 'tool', tool_call_id: 'call_1', content: '用户「张三」最近订单号：ORD-1' },
  { role: 'assistant', content: '已发货，预计明天送达' },
];

test('文件不存在时返回空历史', () => {
  const result = loadHistory(newFile());
  deepStrictEqual(result.messages, []);
  strictEqual(result.backupPath, undefined);
});

test('saveHistory 后 loadHistory 完全保真（含 tool_calls 与 content: null）', () => {
  const f = newFile();
  saveHistory(sampleTurn, f);

  const loaded = loadHistory(f);
  deepStrictEqual(loaded.messages, sampleTurn);
});

test('保真后仍可直接作为 messages 回放（关键字段未丢失）', () => {
  const f = newFile();
  saveHistory(sampleTurn, f);
  const loaded = loadHistory(f);

  const assistant = loaded.messages[1] as { tool_calls?: { id: string }[]; content?: unknown };
  ok(assistant.tool_calls, 'assistant 消息应保留 tool_calls');
  strictEqual(assistant.tool_calls!.length, 1);
  strictEqual(assistant.tool_calls![0].id, 'call_1');
  strictEqual(assistant.content, null, 'content 应保持 null 而非 undefined');

  const toolMsg = loaded.messages[2] as { tool_call_id?: string };
  strictEqual(toolMsg.tool_call_id, 'call_1');
});

test('保存时不残留临时文件（原子写）', () => {
  const f = newFile();
  saveHistory(sampleTurn, f);
  const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  deepStrictEqual(leftovers, []);
});

test('保存结果包含 version 与 updatedAt', () => {
  const f = newFile();
  saveHistory(sampleTurn, f);
  const raw = JSON.parse(readFileSync(f, 'utf8'));

  strictEqual(raw.version, 1);
  ok(typeof raw.updatedAt === 'string' && raw.updatedAt.length > 0, 'updatedAt 应为非空字符串');
  deepStrictEqual(raw.messages, sampleTurn);
});

test('文件损坏时备份并以空历史启动', () => {
  const f = newFile();
  writeFileSync(f, '{ 这不是合法 JSON', 'utf8');

  const result = loadHistory(f);
  deepStrictEqual(result.messages, []);
  ok(result.backupPath, '应返回备份路径');
  ok(existsSync(result.backupPath!), '备份文件应真实存在');
  ok(result.backupPath!.includes('.corrupt-'), '备份文件名应带 .corrupt- 标记');
});

test('clearHistory 后历史为空且文件保留结构', () => {
  const f = newFile();
  saveHistory(sampleTurn, f);
  clearHistory(f);

  const loaded = loadHistory(f);
  deepStrictEqual(loaded.messages, []);

  const raw = JSON.parse(readFileSync(f, 'utf8'));
  strictEqual(raw.version, 1);
  deepStrictEqual(raw.messages, []);
});

test('toTurns 把一轮带工具的对话投影为视图模型', () => {
  const turns = toTurns(sampleTurn);

  strictEqual(turns.length, 1);
  strictEqual(turns[0].question, '张三的快递到哪了');
  strictEqual(turns[0].answer, '已发货，预计明天送达');
  strictEqual(turns[0].toolTrace.length, 1);
  strictEqual(turns[0].toolTrace[0].name, 'get_order');
  deepStrictEqual(turns[0].toolTrace[0].args, { userName: '张三' });
  strictEqual(turns[0].toolTrace[0].result, '用户「张三」最近订单号：ORD-1');
});

test('toTurns 支持多轮且保持顺序', () => {
  const multi: Message[] = [
    ...sampleTurn,
    { role: 'user', content: '那李四呢' },
    { role: 'assistant', content: '李四的包裹已签收' },
  ];

  const turns = toTurns(multi);
  strictEqual(turns.length, 2);
  strictEqual(turns[0].question, '张三的快递到哪了');
  strictEqual(turns[1].question, '那李四呢');
  strictEqual(turns[1].answer, '李四的包裹已签收');
  strictEqual(turns[1].toolTrace.length, 0);
});

test('toTurns 不泄漏内部字段给前端', () => {
  const turns = toTurns(sampleTurn);
  const json = JSON.stringify(turns);

  ok(!json.includes('tool_call_id'), '视图模型不应包含 tool_call_id');
  ok(!json.includes('"tool_calls"'), '视图模型不应包含 tool_calls');
});

test('createHistoryStore 启动时从磁盘加载既有历史', () => {
  const f = newFile();
  saveHistory(sampleTurn, f);

  const store = createHistoryStore(f);
  const result = store.load();

  deepStrictEqual(store.messages, sampleTurn);
  strictEqual(result.backupPath, undefined);
});

test('createHistoryStore.append 同时更新内存与磁盘', () => {
  const f = newFile();
  const store = createHistoryStore(f);
  store.load();

  store.append(sampleTurn);
  strictEqual(store.messages.length, sampleTurn.length);

  const onDisk = loadHistory(f);
  deepStrictEqual(onDisk.messages, sampleTurn);
});

test('createHistoryStore.clear 同步清空磁盘', () => {
  const f = newFile();
  saveHistory(sampleTurn, f);
  const store = createHistoryStore(f);
  store.load();

  store.clear();

  deepStrictEqual(store.messages, []);
  deepStrictEqual(loadHistory(f).messages, []);
});

test('磁盘写入失败时只告警，内存照常更新（不阻断对话）', () => {
  // 让目标路径本身是一个目录，写入必然失败
  const badFile = join(dir, `blocked-${++seq}.json`);
  mkdirSync(badFile);

  const store = createHistoryStore(badFile);
  store.load();

  let threw = false;
  try {
    store.append(sampleTurn);
  } catch {
    threw = true;
  }

  strictEqual(threw, false, '写盘失败不应抛出异常');
  strictEqual(store.messages.length, sampleTurn.length, '内存中的历史应照常保留');
});

test('createHistoryStore.turns 返回投影后的视图', () => {
  const f = newFile();
  saveHistory(sampleTurn, f);
  const store = createHistoryStore(f);
  store.load();

  const turns = store.turns();
  strictEqual(turns.length, 1);
  strictEqual(turns[0].question, '张三的快递到哪了');
});

run();
