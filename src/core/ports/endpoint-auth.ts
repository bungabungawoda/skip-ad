/**
 * 端点授权：首次连接自定义地址时，按主机申请可选 host 权限。
 *
 * Chrome 的权限模式不允许写端口（`http://127.0.0.1:3425/*` 是非法模式），
 * 所以模式只由协议与主机名组成，端口靠 CSP 的 `http://127.0.0.1:*` 覆盖。
 * 拒绝时不能把模式记成已授权，否则第二次点连接会跳过授权、误报成功。
 */
import { errorText } from "../lib/error";
import { logWarn } from "../lib/log";

interface EndpointAuthorizationInput {
  /** 端点地址；URL 非法时为 null。 */
  url: string | null;
  /** 上次已成功授权的权限模式。 */
  authorizedPattern: string | null;
  request: (pattern: string) => Promise<boolean>;
}

interface EndpointAuthorizationResult {
  authorized: boolean;
  authorizedPattern: string | null;
}

/** 地址 → Chrome 权限模式；端口必须丢掉，否则模式非法、request 直接抛错。 */
export function endpointPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

export async function requestEndpointAuthorization(
  input: EndpointAuthorizationInput
): Promise<EndpointAuthorizationResult> {
  const pattern = input.url ? endpointPattern(input.url) : null;
  if (!pattern) return { authorized: true, authorizedPattern: null };
  if (input.authorizedPattern === pattern) {
    return { authorized: true, authorizedPattern: pattern };
  }
  try {
    const granted = await input.request(pattern);
    return granted
      ? { authorized: true, authorizedPattern: pattern }
      : { authorized: false, authorizedPattern: null };
  } catch (error) {
    // 没有用户手势、权限 API 不可用等：按拒绝处理，下次点击可重试。
    logWarn("申请端点授权失败，按未授权处理", { pattern, error: errorText(error) });
    return { authorized: false, authorizedPattern: null };
  }
}
