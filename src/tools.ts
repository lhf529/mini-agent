import type { Tool } from './types.js';

/** 工具一：查询天气（模拟数据，重点是演示参数 schema） */
export const getWeather: Tool = {
  name: 'get_weather',
  description: '查询指定城市的当前天气。当用户询问天气相关问题时使用。',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名称，例如「北京」' },
    },
    required: ['city'],
  },
  execute: async (args) => {
    const city = String(args.city);
    // 真实场景这里应该调第三方天气 API
    const mock: Record<string, string> = {
      北京: '晴，18°C，西北风 3 级',
      上海: '多云，22°C，东南风 2 级',
      深圳: '雷阵雨，27°C，南风 4 级',
    };
    return mock[city] ?? `${city}：暂无数据（模拟数据仅支持北京/上海/深圳）`;
  },
};

/** 工具二：数学计算，演示「用代码替代 LLM 算数」这一原则 */
export const calculate: Tool = {
  name: 'calculate',
  description: '计算一个数学表达式并返回结果。涉及任何算术时都应该用它，不要自己心算。',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: '要计算的表达式，例如 "(12 + 8) * 3 / 4"',
      },
    },
    required: ['expression'],
  },
  execute: async (args) => {
    const expr = String(args.expression);
    // 只允许数字和运算符，防止注入任意代码
    if (!/^[\d\s+\-*/().]+$/.test(expr)) {
      return `非法表达式：${expr}`;
    }
    try {
      // eslint-disable-next-line no-new-func
      const result = Function(`"use strict"; return (${expr});`)();
      return `${expr} = ${result}`;
    } catch (err) {
      return `计算失败：${(err as Error).message}`;
    }
  },
};

/**
 * 工具三：按用户名查订单号。
 * 注意它的返回里只有订单号，没有物流信息 —— 逼着 LLM 必须再调一次。
 */
export const getOrder: Tool = {
  name: 'get_order',
  description:
    '根据用户姓名查询其最近的订单编号。' +
    '当用户提到「快递」「包裹」「订单」「买了什么」「发货了吗」等需要先定位订单的场景时，' +
    '都应先调用本工具拿到订单号。' +
    '重要：本工具只返回订单号，不包含任何物流状态或是否签收的信息，' +
    '必须再用返回的订单号调用 get_logistics 才能得到物流详情。',
  parameters: {
    type: 'object',
    properties: {
      userName: { type: 'string', description: '用户姓名，例如「张三」' },
    },
    required: ['userName'],
  },
  execute: async (args) => {
    const name = String(args.userName);
    const orders: Record<string, string> = {
      张三: 'ORD-20241015-8842',
      李四: 'ORD-20241014-3310',
    };
    const orderId = orders[name];
    if (!orderId) {
      return `未找到用户「${name}」的订单。`;
    }
    return `用户「${name}」最近订单号：${orderId}`;
  },
};

/**
 * 工具四：按订单号查物流。
 * 它的入参必须是 get_order 的输出，单独调用毫无意义。
 */
export const getLogistics: Tool = {
  name: 'get_logistics',
  description:
    '根据订单号查询物流详情，包括运输状态、当前所在位置、是否已签收、预计送达时间。' +
    '当用户询问「快递到哪了」「包裹签收了吗」「什么时候到」「物流状态」等问题时必须使用本工具。' +
    '前提：本工具的入参是订单号，必须先调用 get_order 取得订单号后再调用本工具。',
  parameters: {
    type: 'object',
    properties: {
      orderId: { type: 'string', description: '订单号，例如「ORD-20241015-8842」' },
    },
    required: ['orderId'],
  },
  execute: async (args) => {
    const id = String(args.orderId);
    const logistics: Record<string, string> = {
      'ORD-20241015-8842': '已发货，当前在【北京转运中心】，预计明天送达',
      'ORD-20241014-3310': '已签收，签收时间 10月15日 09:23',
    };
    return logistics[id] ?? `订单 ${id}：暂无物流信息。`;
  },
};

/**
 * 工具五：汇率查询，故意模拟一个缓慢的外部接口。
 * 用于演示超时保护 —— 真实项目里的 HTTP 接口随时可能变慢。
 */
export const getExchangeRate: Tool = {
  name: 'get_exchange_rate',
  description: '查询两种货币之间的汇率。支持 CNY/USD/EUR/JPY。',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '源货币代码，例如 CNY' },
      to: { type: 'string', description: '目标货币代码，例如 USD' },
    },
    required: ['from', 'to'],
  },
  // 给这个工具单独设一个很短的超时，方便演示超时效果
  timeoutMs: 1500,
  execute: async (args) => {
    const from = String(args.from).toUpperCase();
    const to = String(args.to).toUpperCase();

    // 模拟慢接口：汇率服务响应慢
    await new Promise((r) => setTimeout(r, 4000));

    const rates: Record<string, number> = { 'CNY-USD': 0.138, 'CNY-EUR': 0.127, 'USD-CNY': 7.24 };
    const rate = rates[`${from}-${to}`];
    return rate ? `1 ${from} = ${rate} ${to}` : `${from} 到 ${to} 的汇率暂无数据。`;
  },
};

/** 注册表：新增工具只需往这里加一项 */
export const tools: Tool[] = [
  getWeather,
  calculate,
  getOrder,
  getLogistics,
  getExchangeRate,
];

export const toolsByName = new Map(tools.map((t) => [t.name, t]));
