/**
 * LLM 配置：预设表与形状归一化。
 *
 * 用户只选一家服务商并粘一个 Key；协议、地址、默认模型都从这里查，不进用户界面。
 * 读取点做一次全量归一化，非法值不会进入请求层。
 */

import type { ProtocolId } from "./protocols";
import { detectProtocolFromUrl } from "./protocols";
import { isEndpointUrl, normalizeEndpointText, parseEndpointInput } from "./endpoint";
import { isRecord } from "../../lib/record";
import { currentLocale } from "../../i18n";

export interface ProviderPreset {
  id: string;
  /** 中文展示名。 */
  label: string;
  /** 英文展示名；没有时沿用 label。 */
  labelEn?: string;
  /** 展示顺序用：国产在前，国外在后。 */
  region: "domestic" | "foreign";
  /** 请求前缀；适配器负责补端点路径。 */
  baseUrl: string;
  protocol: ProtocolId;
  /** /models 不可用时的兜底模型名。 */
  fallbackModel: string;
  /** 预设已知的能力位：认不认 response_format: json_object。 */
  jsonObject: boolean;
  /**
   * 能力位：这家是否自动按请求前缀缓存（DeepSeek、OpenAI 自动，
   * Anthropic 由适配器打断点，其余按没有处理）。
   * 有自动缓存的服务商保留完整对话历史（改写历史会掐断缓存前缀），
   * 没有的继续压缩历史，限制上下文随轮数增长。
   */
  autoPrefixCache: boolean;
}

export const LLM_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    region: "domestic",
    baseUrl: "https://api.deepseek.com",
    protocol: "openai-chat",
    fallbackModel: "deepseek-chat",
    jsonObject: true,
    autoPrefixCache: true
  },
  {
    id: "moonshot",
    label: "Kimi",
    region: "domestic",
    baseUrl: "https://api.moonshot.cn/v1",
    protocol: "openai-chat",
    fallbackModel: "moonshot-v1-8k",
    jsonObject: true,
    autoPrefixCache: false
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    labelEn: "Zhipu GLM",
    region: "domestic",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai-chat",
    fallbackModel: "glm-4-flash",
    jsonObject: true,
    autoPrefixCache: false
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    labelEn: "SiliconFlow",
    region: "domestic",
    baseUrl: "https://api.siliconflow.cn/v1",
    protocol: "openai-chat",
    fallbackModel: "Qwen/Qwen2.5-7B-Instruct",
    jsonObject: true,
    autoPrefixCache: false
  },
  {
    id: "openai",
    label: "OpenAI",
    region: "foreign",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai-chat",
    fallbackModel: "gpt-4o-mini",
    jsonObject: true,
    autoPrefixCache: true
  },
  {
    id: "anthropic",
    label: "Claude",
    region: "foreign",
    baseUrl: "https://api.anthropic.com",
    protocol: "anthropic",
    fallbackModel: "claude-sonnet-4-5",
    jsonObject: false,
    autoPrefixCache: true
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    region: "foreign",
    baseUrl: "https://openrouter.ai/api/v1",
    protocol: "openai-chat",
    fallbackModel: "openai/gpt-4o-mini",
    jsonObject: true,
    autoPrefixCache: false
  }
];

const PRESET_BY_ORIGIN = new Map(
  LLM_PRESETS.map((preset) => [new URL(preset.baseUrl).origin, preset])
);

export type ProviderUrlMatch =
  | { kind: "preset"; preset: ProviderPreset; baseUrl: string }
  | { kind: "custom"; baseUrl: string }
  | { kind: "invalid" };

/**
 * 从用户填的地址反推服务商。
 *
 * 只认完整 URL，按 origin 比较，避免相似域名误命中。已知服务商返回预设里的
 * 基础地址；未知地址保留用户输入，按自定义端点处理。路径明确写了另一种协议时
 * 也不改写成预设协议，避免用户粘贴的地址与实际请求不一致。
 */
export function classifyProviderUrl(raw: string): ProviderUrlMatch {
  const text = raw.trim();
  const normalized = normalizeEndpointText(text);
  const url = parseEndpointInput(normalized);
  if (!url) return { kind: "invalid" };

  const preset = PRESET_BY_ORIGIN.get(url.origin);
  if (!preset) return { kind: "custom", baseUrl: normalized };

  const protocol = detectProtocolFromUrl(normalized);
  if (protocol !== undefined && protocol !== preset.protocol) {
    return { kind: "custom", baseUrl: normalized };
  }
  return { kind: "preset", preset, baseUrl: preset.baseUrl };
}

export const DEFAULT_PROVIDER_ID = "deepseek";
export const CUSTOM_PROVIDER_ID = "custom";

/** 一条连接：某家服务商上一次成功的模型、Key 与能力位。 */
export interface ConnectionEntry {
  model: string;
  apiKey: string;
  jsonObject: boolean;
  connectedAt: number;
  /** 只有自定义端点才存；预设服务商从预设表查。 */
  baseUrl?: string;
  protocol?: ProtocolId;
}

export interface LlmConfig {
  active: string;
  byProvider: Record<string, ConnectionEntry>;
}

export function presetById(id: string): ProviderPreset | undefined {
  return LLM_PRESETS.find((preset) => preset.id === id);
}

export function providerLabel(preset: ProviderPreset): string {
  return currentLocale() === "en" ? preset.labelEn ?? preset.label : preset.label;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readProtocol(value: unknown): ProtocolId | undefined {
  return value === "openai-chat" || value === "openai-responses" || value === "anthropic"
    ? value
    : undefined;
}

export { isEndpointUrl } from "./endpoint";

function baseEntry(raw: Record<string, unknown>, model: string): ConnectionEntry {
  return {
    model,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
    jsonObject: raw.jsonObject === true,
    connectedAt: readTime(raw.connectedAt)
  };
}

/** 自定义端点必须自带一个合法地址，协议能推就推、推不出先按 OpenAI 兼容。 */
function normalizeCustomEntry(
  raw: Record<string, unknown>,
  model: string
): ConnectionEntry | undefined {
  const baseUrl = readString(raw.baseUrl);
  if (!isEndpointUrl(baseUrl)) return undefined;
  return {
    ...baseEntry(raw, model),
    baseUrl,
    protocol: readProtocol(raw.protocol) ?? detectProtocolFromUrl(baseUrl) ?? "openai-chat"
  };
}

function normalizeEntry(providerId: string, raw: unknown): ConnectionEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const model = readString(raw.model);
  if (!model) return undefined;
  return providerId === CUSTOM_PROVIDER_ID
    ? normalizeCustomEntry(raw, model)
    : baseEntry(raw, model);
}

function normalizeEntries(raw: Record<string, unknown>): Record<string, ConnectionEntry> {
  const entries: Record<string, ConnectionEntry> = {};
  for (const [providerId, value] of Object.entries(raw)) {
    const entry = normalizeEntry(providerId, value);
    if (entry) entries[providerId] = entry;
  }
  return entries;
}

/** 读取点归一化：没有任何可用条目时返回 undefined（= 未连接）。 */
export function normalizeLlmConfig(raw: unknown): LlmConfig | undefined {
  if (!isRecord(raw)) return undefined;
  if (!isRecord(raw.byProvider)) return undefined;
  const byProvider = normalizeEntries(raw.byProvider as Record<string, unknown>);
  const ids = Object.keys(byProvider);
  if (ids.length === 0) return undefined;
  const active = typeof raw.active === "string" && byProvider[raw.active] ? raw.active : ids[0];
  if (!active) return undefined;
  return { active, byProvider };
}

/** 把配置翻成请求需要的全部参数；界面与客户端都从这里取，不各自拼。 */
export interface ResolvedConnection {
  providerId: string;
  preset: ProviderPreset | undefined;
  protocol: ProtocolId;
  baseUrl: string;
  model: string;
  apiKey: string;
  jsonObject: boolean;
  /** 这家是否自动按请求前缀缓存；自定义端点一律按没有处理。 */
  autoPrefixCache: boolean;
}

export function resolveConnection(config: LlmConfig): ResolvedConnection | undefined {
  const entry = config.byProvider[config.active];
  if (!entry) return undefined;
  const preset = presetById(config.active);
  if (!preset) {
    const baseUrl = entry.baseUrl ?? "";
    if (!isEndpointUrl(baseUrl)) return undefined;
    return {
      providerId: config.active,
      preset: undefined,
      protocol: entry.protocol ?? detectProtocolFromUrl(baseUrl) ?? "openai-chat",
      baseUrl,
      model: entry.model,
      apiKey: entry.apiKey,
      jsonObject: entry.jsonObject,
      // 自定义端点的缓存能力未知：按没有处理，压缩历史保住上下文上限。
      autoPrefixCache: false
    };
  }
  return {
    providerId: config.active,
    preset,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    model: entry.model,
    apiKey: entry.apiKey,
    jsonObject: entry.jsonObject,
    autoPrefixCache: preset.autoPrefixCache
  };
}
