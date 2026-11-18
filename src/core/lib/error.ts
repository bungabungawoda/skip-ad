/** 把任意抛出值转成一行可展示文本；fallback 用于需要固定提示的场景。 */
export function errorText(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  return fallback ?? String(error);
}
