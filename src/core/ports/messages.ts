import type { AnalysisPolicy, AnalysisPolicyPatch } from "../analysis/types";
import type { LlmMessage } from "./llm/types";
import type { DecisionQuestion, DecisionTextBlock } from "./decision/types";
import type { DecisionConfig } from "./decision/config";
import type { CacheEntry } from "./cache/store";
import type { SiteSwitchConfig } from "./site-switches";

/** 建立连接时用户提供的东西：服务商、Key，以及「其他」的地址与模型。 */
interface ConnectRequestInput {
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export type RuntimeRequest =
  | {
      type: "llm.complete";
      messages: LlmMessage[];
      requestId?: string;
      /** 当前视频时长（毫秒），长视频放宽限流重试次数。 */
      videoDurationMs?: number;
    }
  | { type: "llm.abort"; requestId: string }
  | {
      type: "decision.decide";
      input: DecisionTextBlock[];
      questions: Record<string, DecisionQuestion>;
      requestId?: string;
      /** 当前视频时长（毫秒），长视频放宽限流重试次数。 */
      videoDurationMs?: number;
    }
  | { type: "decision.abort"; requestId: string }
  | { type: "cache.get"; key: string }
  | { type: "cache.set"; key: string; entry: CacheEntry }
  | { type: "cache.delete"; key: string }
  | { type: "cache.clear" }
  | { type: "cache.trim" }
  | { type: "settings.get" }
  | { type: "settings.setPolicy"; patch: AnalysisPolicyPatch }
  | { type: "settings.setSiteSwitches"; patch: Record<string, Partial<SiteSwitchConfig[string]>> }
  | { type: "settings.getDecisionConfig" }
  | { type: "settings.setDecisionConfig"; patch: Partial<DecisionConfig> }
  | { type: "connection.connect"; input: ConnectRequestInput }
  | { type: "connection.disconnect" }
  | { type: "metrics.skip"; seconds: number }
  | { type: "metrics.undo" }
  | { type: "metrics.get" }
  | { type: "metrics.clear" }
  | { type: "ignore.get"; videoKey: string }
  | { type: "ignore.add"; videoKey: string; segmentKey: string }
  | { type: "badge.set"; text: string };

export interface RuntimeSettings {
  policy: AnalysisPolicy;
  /** 是否已经有一份可用的连接。 */
  llmConfigured: boolean;
  /** 是否填了决策模型接口地址。 */
  decisionConfigured: boolean;
  /** 两个模型都配置时，用户是否选择优先用 LLM；缺省按决策优先。 */
  preferLlm?: boolean;
  /** 决策模型或 LLM 任意一个可用，就能分析。 */
  analysisConfigured: boolean;
  /** 决策模型名，只用于展示。 */
  decisionModel?: string;
  /** 决策模型端点 origin，设置页与 Popup 用来检查权限。 */
  decisionEndpointOrigin?: string;
  providerId?: string;
  providerLabel?: string;
  model?: string;
  endpointOrigin?: string;
  /** 当前服务商是否自动按请求前缀缓存；决定对话历史要不要压缩。 */
  llmPrefixCache?: boolean;
  /** 每站启用开关；未配置的站点按默认（全开）处理。 */
  siteSwitches: SiteSwitchConfig;
}

/** 连接成功后返回给设置页的东西；界面上只显示其中一行。 */
export interface ConnectResultSummary {
  providerId: string;
  providerLabel: string;
  model: string;
  notes: string[];
}

export type RuntimeResponse<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        kind: string;
        message: string;
      };
    };
