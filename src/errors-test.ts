import { test, run, ok } from './testkit.js';
import { formatError } from './errors.js';

test('429 时带上服务端原始信息，便于区分限流与套餐停用', () => {
  const err = Object.assign(new Error('user access to this plan has been disabled'), {
    status: 429,
  });

  const text = formatError(err);
  ok(text.includes('429'), '应说明是 429');
  ok(
    text.includes('user access to this plan has been disabled'),
    '必须原样带出服务端信息，否则无法判断真实原因',
  );
});

test('401 时给出认证排查方向', () => {
  const err = Object.assign(new Error('invalid api key'), { status: 401 });
  const text = formatError(err);

  ok(text.includes('401'));
  ok(text.includes('OPENAI_API_KEY'));
});

test('网络层错误给出 baseURL 与代理排查建议', () => {
  const err = Object.assign(new Error('Connection error.'), {
    cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
  });
  const text = formatError(err);

  ok(text.includes('网络层'), '应指出是网络层失败');
  ok(text.includes('HTTPS_PROXY'), '应提示代理排查');
});

run();
