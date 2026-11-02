/** 把 SDK 的包装错误拆开，露出底层真实原因。 */
export function formatError(err: unknown): string {
  const e = err as Error & { status?: number; cause?: { code?: string } };
  const code = e.cause?.code ?? '';
  const lines: string[] = [];

  if (code.includes('CONNECT_TIMEOUT') || code.includes('ENOTFOUND')) {
    lines.push('无法连接到 API 服务（网络层失败）。');
    lines.push(`当前 baseURL：${process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}`);
    lines.push('排查：1) 能否访问该地址 2) 是否需要配 HTTPS_PROXY 3) 是否该换成可用的中转服务');
  } else if (e.status === 401) {
    lines.push('认证失败（401）：OPENAI_API_KEY 无效或与 baseURL 不匹配。');
  } else if (e.status === 404) {
    lines.push('接口不存在（404）：baseURL 或 MODEL 名称有误。');
  } else if (e.status === 400) {
    lines.push('请求被拒（400）：常见于模型不支持 function calling，或消息格式不合法。');
    lines.push(`原始信息：${e.message}`);
  } else if (e.status === 429) {
    lines.push('请求被拒（429）。常见原因有两种，请按原始信息判断：');
    lines.push('  1) 请求过于频繁，触发 QPS 限流 —— 放慢节奏即可；');
    lines.push('  2) API 套餐或访问权限被停用 —— 需联系服务商。');
    lines.push(`原始信息：${e.message}`);
  } else {
    lines.push(`出错：${e.message}`);
    if (code) lines.push(`底层原因：${code}`);
  }

  return lines.join('\n');
}
