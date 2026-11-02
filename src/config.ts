import { config } from 'dotenv';

/**
 * 统一加载配置。
 *
 * 关键点：override: true。
 * dotenv 默认不会覆盖已存在的环境变量，若终端里残留了旧的同名变量
 * （例如早前 export 过 OPENAI_BASE_URL），.env 的新配置就会被静默忽略，
 * 表现为"改了 .env 却不生效"。这里让 .env 成为唯一权威来源。
 */
config({ override: true });
