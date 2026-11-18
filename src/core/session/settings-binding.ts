import type { AnalysisPolicy } from "../analysis/types";
import type { RuntimeSettings } from "../ports/messages";
import { siteSwitchesFor, type SiteSwitches } from "../ports/site-switches";
import { DEFAULT_POLICY } from "../policy/policy";

const DISABLED_SWITCHES: SiteSwitches = {
  enabled: false,
  platformAdSkip: false,
  segmentAnalysis: false
};

/**
 * 会话里的设置视图：站点开关、类型策略与「是否配置了模型」。
 * 未读到设置前一律按关闭处理，避免默认全开误点；分析是例外，
 * 第一次 tick 允许先读设置再判定。
 */
export class SettingsBinding {
  private switches: SiteSwitches | null = null;
  private currentPolicy: AnalysisPolicy = DEFAULT_POLICY;
  private llmConfigured = false;
  private decisionConfigured = false;

  constructor(private readonly siteId: string) {}

  apply(settings: RuntimeSettings): void {
    this.switches = siteSwitchesFor(settings.siteSwitches, this.siteId);
    this.currentPolicy = settings.policy;
    this.llmConfigured = settings.llmConfigured;
    this.decisionConfigured = settings.decisionConfigured === true;
  }

  get policy(): AnalysisPolicy {
    return this.currentPolicy;
  }

  get configured(): boolean {
    return this.llmConfigured || this.decisionConfigured;
  }

  get siteSwitches(): SiteSwitches {
    return this.switches ?? DISABLED_SWITCHES;
  }

  analysisEnabled(): boolean {
    const switches = this.switches;
    return switches ? switches.enabled && switches.segmentAnalysis : true;
  }
}
