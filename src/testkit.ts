import { deepStrictEqual, strictEqual, ok } from 'node:assert/strict';

const cases: { name: string; fn: () => void | Promise<void> }[] = [];

/** 注册一个测试用例 */
export function test(name: string, fn: () => void | Promise<void>): void {
  cases.push({ name, fn });
}

export { deepStrictEqual, strictEqual, ok };

/** 依次执行所有用例，有失败则以退出码 1 结束 */
export async function run(): Promise<void> {
  let pass = 0;
  let fail = 0;

  for (const c of cases) {
    try {
      await c.fn();
      console.log(`  ✓ ${c.name}`);
      pass++;
    } catch (err) {
      console.log(`  ✗ ${c.name}`);
      const msg = (err as Error).message ?? String(err);
      console.log('    ' + msg.split('\n').join('\n    '));
      fail++;
    }
  }

  console.log(`\n${pass} 通过，${fail} 失败`);
  if (fail > 0) process.exit(1);
}
