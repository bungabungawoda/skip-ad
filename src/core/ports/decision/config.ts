/**
 * 决策模型的配置：完整接口地址、Key 与模型名。
 *
 * 地址留空表示不使用决策模型。两个模型都配置时，由 preferLlm 选择一条链。
 */

import type { StorageAreaLike } from "../cache/store";
import { isEndpointUrl } from "../llm/endpoint";
import { isRecord } from "../../lib/record";

export const DECISION_STORAGE_KEY = "decision";

export const DEFAULT_DECISION_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/decisions";
export const DEFAULT_DECISION_MODEL = "gemini-decision-1";

export interface DecisionConfig {
  /** 完整接口地址；空字符串表示不启用决策模型。 */
  endpoint: string;
  apiKey: string;
  model: string;
  /** 两个模型都配置时，是否优先用 LLM；默认优先决策模型。 */
  preferLlm: boolean;
}

const EMPTY_DECISION_CONFIG: DecisionConfig = {
  endpoint: "",
  apiKey: "",
  model: DEFAULT_DECISION_MODEL,
  preferLlm: false
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeDecisionConfig(raw: unknown): DecisionConfig {
  const source = isRecord(raw) ? raw : null;
  const endpoint = readString(source?.endpoint);
  return {
    endpoint: isEndpointUrl(endpoint) ? endpoint : "",
    apiKey: readString(source?.apiKey),
    model: readString(source?.model) || DEFAULT_DECISION_MODEL,
    preferLlm: source?.preferLlm === true
  };
}

export function decisionReady(config: DecisionConfig): boolean {
  return isEndpointUrl(config.endpoint) && config.model.length > 0;
}

export async function readDecisionConfig(area: StorageAreaLike): Promise<DecisionConfig> {
  const stored = await area.get(DECISION_STORAGE_KEY);
  return normalizeDecisionConfig(stored[DECISION_STORAGE_KEY]);
}

export async function writeDecisionConfig(
  area: StorageAreaLike,
  patch: Partial<DecisionConfig>
): Promise<DecisionConfig> {
  const current = await readDecisionConfig(area);
  const next = normalizeDecisionConfig({ ...current, ...patch });
  await area.set({ [DECISION_STORAGE_KEY]: next });
  return next;
}

export { EMPTY_DECISION_CONFIG };
