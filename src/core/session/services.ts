import type { AnalysisServices } from "../plugin/types";
import {
  createRuntimeCache,
  createRuntimeDecisionClient,
  createRuntimeLlmClient,
  readRuntimeSettings
} from "../ports/runtime-client";

/**
 * 内容脚本使用的分析服务组合：LLM 与缓存都走后台代理，Key 不落到页面。
 * 放在独立文件，避免入口从会话控制器反向导入服务工厂。
 */
export function createRuntimeAnalysisServices(): AnalysisServices {
  return {
    llm: createRuntimeLlmClient(),
    decision: createRuntimeDecisionClient(),
    cache: createRuntimeCache(),
    readSettings: readRuntimeSettings
  };
}
