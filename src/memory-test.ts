/**
 * 记忆裁剪的离线测试，不消耗 API 额度。
 * 运行：npx tsx src/memory-test.ts
 */
import { splitTurns, trimHistory, messageTokens, summarize } from './memory.js';
import type { Message } from './types.js';

/** 造一轮带工具调用的对话 */
function makeTurn(i: number): Message[] {
  return [
    { role: 'user', content: `第 ${i} 个问题：北京天气怎么样？这是一段用来占位的中文文本` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: `call_${i}`,
          type: 'function',
          function: { name: 'get_weather', arguments: `{"city":"北京"}` },
        },
      ],
    },
    { role: 'tool', tool_call_id: `call_${i}`, content: `晴，18°C，这是第 ${i} 轮的工具返回结果` },
    { role: 'assistant', content: `第 ${i} 轮回答：北京当前天气晴朗，气温 18 度。` },
  ];
}

function main() {
  const history: Message[] = [];
  for (let i = 1; i <= 8; i++) history.push(...makeTurn(i));

  console.log('=== 1. 轮次切分 ===');
  const turns = splitTurns(history);
  console.log(`总消息 ${history.length} 条 -> 切成 ${turns.length} 轮`);
  console.log(`每轮消息数：${turns.map((t) => t.length).join(', ')}`);

  console.log('\n=== 2. token 估算 ===');
  const total = history.reduce((s, m) => s + messageTokens(m), 0);
  console.log(`历史总量约 ${total} tokens`);

  console.log('\n=== 3. 裁剪（预算 300 tokens，至少留 2 轮）===');
  const r = trimHistory(history, 300, 2);
  console.log(`丢弃 ${r.droppedTurns} 轮，保留约 ${r.tokens} tokens，剩 ${r.messages.length} 条`);

  console.log('\n=== 4. 完整性校验（最关键）===');
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of r.messages) {
    const mm = m as { tool_calls?: { id: string }[]; tool_call_id?: string };
    mm.tool_calls?.forEach((c) => callIds.add(c.id));
    if (mm.tool_call_id) resultIds.add(mm.tool_call_id);
  }
  const orphanResults = [...resultIds].filter((id) => !callIds.has(id));
  const orphanCalls = [...callIds].filter((id) => !resultIds.has(id));

  console.log(`tool_calls 消息数：${callIds.size}`);
  console.log(`tool 结果消息数：${resultIds.size}`);
  if (orphanResults.length) {
    console.log(`!! 孤儿 tool 结果（会导致 400 报错）：${orphanResults.join(', ')}`);
  } else if (orphanCalls.length) {
    console.log(`!! 孤儿 tool_calls（会导致 400 报错）：${orphanCalls.join(', ')}`);
  } else {
    console.log('通过：tool_calls 与 tool 结果严格配对，未出现孤儿消息');
  }

  console.log('\n=== 5. 首条消息角色检查 ===');
  const firstRole = r.messages[0]?.role;
  console.log(`裁剪后首条消息角色：${firstRole}${firstRole === 'user' ? '（正确）' : '（异常，应以 user 开头）'}`);

  console.log('\n=== 6. 摘要生成 ===');
  const dropped = splitTurns(history).slice(0, r.droppedTurns).flat();
  console.log(summarize(dropped).split('\n').slice(0, 4).join('\n'));

  console.log('\n=== 7. 极端情况：预算极小 ===');
  const tiny = trimHistory(history, 1, 2);
  console.log(`预算 1 token -> 仍保留 ${splitTurns(tiny.messages).length} 轮（minTurns 兜底生效）`);
}

main();
