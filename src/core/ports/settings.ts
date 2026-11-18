import type { AnalysisPolicy, AnalysisPolicyPatch } from "../analysis/types";
import {
  LLM_PRESETS,
  normalizeLlmConfig,
  providerLabel,
  resolveConnection,
  type ConnectionEntry,
  type LlmConfig
} from "./llm/config";
import { DEFAULT_POLICY, normalizePolicy } from "../policy/policy";
import type { StorageAreaLike } from "./cache/store";
import { createSerializedQueue } from "./serialized-queue";
import { t } from "../i18n";
import {
  SITE_SWITCHES_STORAGE_KEY,
  normalizeSiteSwitches,
  type SiteSwitchConfig
} from "./site-switches";
import {
  DECISION_STORAGE_KEY,
  normalizeDecisionConfig,
  type DecisionConfig
} from "./decision/config";

const LLM_STORAGE_KEY = "llm";
const ANALYSIS_STORAGE_KEY = "analysis";
const serializePolicy = createSerializedQueue();

export async function readLlmConfig(area: StorageAreaLike): Promise<LlmConfig | undefined> {
  const stored = await area.get(LLM_STORAGE_KEY);
  return normalizeLlmConfig(stored[LLM_STORAGE_KEY]);
}

/** 缺省或存坏了都归一到默认策略；缓存能力位之类的差异不在这里处理。 */
function parseAnalysisPolicy(raw: unknown): AnalysisPolicy {
  return raw === undefined
    ? { ...DEFAULT_POLICY, perKind: { ...DEFAULT_POLICY.perKind } }
    : normalizePolicy(raw);
}

export async function readAnalysisPolicy(area: StorageAreaLike): Promise<AnalysisPolicy> {
  const stored = await area.get(ANALYSIS_STORAGE_KEY);
  return parseAnalysisPolicy(stored[ANALYSIS_STORAGE_KEY]);
}

/** 一次读全的四份设置：分四次 get 就是四次存储往返。 */
interface SettingsBundle {
  policy: AnalysisPolicy;
  llm: LlmConfig | undefined;
  siteSwitches: SiteSwitchConfig;
  decision: DecisionConfig;
}

export async function readSettingsBundle(area: StorageAreaLike): Promise<SettingsBundle> {
  const stored = await area.get([
    ANALYSIS_STORAGE_KEY,
    LLM_STORAGE_KEY,
    SITE_SWITCHES_STORAGE_KEY,
    DECISION_STORAGE_KEY
  ]);
  return {
    policy: parseAnalysisPolicy(stored[ANALYSIS_STORAGE_KEY]),
    llm: normalizeLlmConfig(stored[LLM_STORAGE_KEY]),
    siteSwitches: normalizeSiteSwitches(stored[SITE_SWITCHES_STORAGE_KEY]),
    decision: normalizeDecisionConfig(stored[DECISION_STORAGE_KEY])
  };
}

export async function writeAnalysisPolicy(
  area: StorageAreaLike,
  patch: AnalysisPolicyPatch
): Promise<AnalysisPolicy> {
  return serializePolicy(async () => {
    const current = await readAnalysisPolicy(area);
    const normalized = normalizePolicy({
      ...current,
      ...patch,
      ...(patch.perKind ? { perKind: { ...current.perKind, ...patch.perKind } } : {})
    });
    await area.set({ [ANALYSIS_STORAGE_KEY]: normalized });
    return normalized;
  });
}

/** 配置的读改写必须串行：两个设置页同时保存，或连接撞上模型自愈保存时，后写的会覆盖先写的。 */
const serializeConfig = createSerializedQueue();

/**
 * 写入一家服务商的连接并切成当前使用。
 * 别家的条目原样保留：换回来不用重新粘 Key。
 */
export function saveConnection(
  area: StorageAreaLike,
  providerId: string,
  entry: ConnectionEntry
): Promise<LlmConfig> {
  return serializeConfig(async () => {
    const current = await readLlmConfig(area);
    const config: LlmConfig = {
      active: providerId,
      byProvider: { ...(current?.byProvider ?? {}), [providerId]: entry }
    };
    await area.set({ [LLM_STORAGE_KEY]: config });
    return config;
  });
}

/** 断开当前这一家；一家都不剩时把整个键删掉，不留空壳。 */
export function clearActiveConnection(area: StorageAreaLike): Promise<LlmConfig | undefined> {
  return serializeConfig(async () => {
    const current = await readLlmConfig(area);
    if (!current) return undefined;
    const rest = { ...current.byProvider };
    delete rest[current.active];
    const remaining = Object.keys(rest);
    const next = remaining[0];
    if (next === undefined) {
      await area.remove(LLM_STORAGE_KEY);
      return undefined;
    }
    const config: LlmConfig = { active: next, byProvider: rest };
    await area.set({ [LLM_STORAGE_KEY]: config });
    return config;
  });
}

interface LlmSummary {
  configured: boolean;
  providerId?: string;
  providerLabel?: string;
  model?: string;
  endpointOrigin?: string;
}

/** 只给界面用的摘要：没有 Key，只有「连的是谁、用的哪个模型」。 */
export function describeLlmConfig(config: LlmConfig | undefined): LlmSummary {
  if (!config) return { configured: false };
  const resolved = resolveConnection(config);
  if (!resolved) return { configured: false };
  const label = resolved.preset ? providerLabel(resolved.preset) : t("connection.customProvider");
  return {
    configured: true,
    providerId: resolved.providerId,
    providerLabel: label,
    model: resolved.model,
    endpointOrigin: new URL(resolved.baseUrl).origin
  };
}

/** 设置页读「这一家上次存了什么」，用于换回来时回填。 */
export function entryFor(config: LlmConfig | undefined, providerId: string): ConnectionEntry | undefined {
  return config?.byProvider[providerId];
}

export function labelFor(providerId: string): string {
  const preset = LLM_PRESETS.find((item) => item.id === providerId);
  return preset ? providerLabel(preset) : t("connection.customProvider");
}
