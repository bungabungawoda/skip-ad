const LOG_PREFIX = "[skip-ad]";

/** 统一日志出口：内容脚本、后台与 Options/Popup 都带同一前缀，便于控制台过滤。 */
export function logInfo(scope: string, ...details: unknown[]): void {
  console.info(LOG_PREFIX, scope, ...details);
}

export function logWarn(scope: string, ...details: unknown[]): void {
  console.warn(LOG_PREFIX, scope, ...details);
}
