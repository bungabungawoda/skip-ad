/**
 * 主分析器的选择：默认决策模型优先，用户也可以在设置里选 LLM 优先。
 * 只按配置选一条链；选中的链失败就报错，不再自动改用另一条。
 */

import type { SegmentAnalyzer } from "../plugin/types";
import type { RuntimeSettings } from "../ports/messages";

interface ModelAnalyzerDeps {
  llm: SegmentAnalyzer | null;
  decision: SegmentAnalyzer | null;
  readSettings(): Promise<RuntimeSettings>;
}

export function createModelAnalyzer(deps: ModelAnalyzerDeps): SegmentAnalyzer | null {
  if (!deps.llm && !deps.decision) return null;
  return {
    async analyze(run) {
      const settings = await deps.readSettings();
      const preferred = settings.preferLlm ? deps.llm : deps.decision;
      const preferredConfigured = settings.preferLlm
        ? settings.llmConfigured
        : settings.decisionConfigured;
      const fallback = settings.preferLlm ? deps.decision : deps.llm;
      const analyzer = preferredConfigured && preferred ? preferred : fallback ?? preferred;
      if (!analyzer) throw new Error("没有可用的分析模型");
      return analyzer.analyze(run);
    }
  };
}
