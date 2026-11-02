/**
 * 不依赖 API Key 的自检脚本。
 * 用假的 LLM 响应驱动真实循环，验证「解析 tool_calls → 执行工具 → 回灌」是否通畅。
 * 运行：npx tsx src/mock-test.ts
 */
import { tools, toolsByName } from './tools.js';

async function main() {
  console.log('=== 1. 工具注册表 ===');
  console.log('已注册工具：', tools.map((t) => t.name).join(', '));

  console.log('\n=== 2. 逐个执行工具 ===');
  const r1 = await toolsByName.get('get_weather')!.execute({ city: '北京' });
  console.log('get_weather(北京) ->', r1);

  const r2 = await toolsByName.get('calculate')!.execute({ expression: '(12+8)*3/4' });
  console.log('calculate((12+8)*3/4) ->', r2);

  console.log('\n=== 3. 安全校验 ===');
  console.log('恶意表达式 ->', await toolsByName.get('calculate')!.execute({ expression: 'process.exit(1)' }));
  console.log('未知城市 ->', await toolsByName.get('get_weather')!.execute({ city: '火星' }));

  console.log('\n=== 4. 模拟 LLM 返回的 tool_calls 结构 ===');
  const fakeCall = {
    id: 'call_abc123',
    type: 'function' as const,
    function: { name: 'get_weather', arguments: '{"city":"上海"}' },
  };
  console.log('LLM 会返回这样的结构：', JSON.stringify(fakeCall));

  const parsed = JSON.parse(fakeCall.function.arguments);
  const tool = toolsByName.get(fakeCall.function.name);
  if (!tool) {
    console.log('!! 找不到工具，说明 name 对不上');
    return;
  }
  console.log('解析出参数：', parsed);
  console.log('执行结果：', await tool.execute(parsed));
  console.log('\n如果以上都正常，说明循环逻辑没问题。');
}

main();
