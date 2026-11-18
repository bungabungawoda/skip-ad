import type { CacheStore, StorageAreaLike } from "../core/ports/cache/store";
import { createSerializedQueue } from "../core/ports/serialized-queue";
import type { LlmMessage } from "../core/ports/llm/types";
import type {
  ConnectResultSummary,
  RuntimeRequest,
  RuntimeResponse,
  RuntimeSettings
} from "../core/ports/messages";
import { createLlmClient, LlmError } from "../core/ports/llm/client";
import { connect } from "../core/ports/llm/connect";
import { resolveConnection } from "../core/ports/llm/config";
import type { LlmAbortRegistry } from "../core/ports/llm-abort";
import {
  clearActiveConnection,
  describeLlmConfig,
  labelFor,
  readLlmConfig,
  readSettingsBundle,
  saveConnection,
  writeAnalysisPolicy
} from "../core/ports/settings";
import { writeSiteSwitches } from "../core/ports/site-switches";
import {
  decisionReady,
  readDecisionConfig,
  writeDecisionConfig
} from "../core/ports/decision/config";
import { createDecisionClient } from "../core/ports/decision/client";
import type { MetricsStore } from "../core/metrics/store";
import { settingsChangeTargets } from "./notify-targets";
import { errorText } from "../core/lib/error";
import { logWarn } from "../core/lib/log";
import { t } from "../core/i18n";

/** 后台请求分派：按 type 前缀交给对应的处理函数，每个函数只管一件事。 */

export interface HandlerContext {
  area: StorageAreaLike;
  cache: CacheStore;
  aborts: LlmAbortRegistry;
  metrics: MetricsStore;
  senderTabId: number | undefined;
}

type CacheRequest = Extract<
  RuntimeRequest,
  { type: "cache.get" | "cache.set" | "cache.delete" | "cache.clear" | "cache.trim" }
>;
type LlmRequest = Extract<RuntimeRequest, { type: "llm.complete" | "llm.abort" }>;
type SettingsRequest = Extract<
  RuntimeRequest,
  {
    type:
      | "settings.get"
      | "settings.setPolicy"
      | "settings.setSiteSwitches"
      | "settings.getDecisionConfig"
      | "settings.setDecisionConfig";
  }
>;
type ConnectionRequest = Extract<
  RuntimeRequest,
  { type: "connection.connect" | "connection.disconnect" }
>;
type MetricsRequest = Extract<
  RuntimeRequest,
  { type: "metrics.skip" | "metrics.undo" | "metrics.get" | "metrics.clear" }
>;
type BadgeRequest = Extract<RuntimeRequest, { type: "badge.set" }>;
type DecisionRequest = Extract<
  RuntimeRequest,
  { type: "decision.decide" | "decision.abort" }
>;
type IgnoreRequest = Extract<RuntimeRequest, { type: "ignore.get" | "ignore.add" }>;

const IGNORE_PREFIX = "skipad-ignored:";

/** 「不是广告」标记的读改写串行执行，避免两个标签页同时写时互相覆盖。 */
const serializeIgnore = createSerializedQueue();
/** 决策设置的读改写串行执行，避免两个设置页同时保存时互相覆盖。 */
const serializeDecisionConfig = createSerializedQueue();
/** 站点开关的读改写串行执行，避免两个设置页按旧值整份写回互相覆盖。 */
const serializeSiteSwitches = createSerializedQueue();

function ignoreStorageKey(videoKey: string): string {
  return `${IGNORE_PREFIX}${videoKey}`;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function handleIgnore(
  request: IgnoreRequest,
  area: StorageAreaLike
): Promise<RuntimeResponse<unknown>> {
  return serializeIgnore(async () => {
    const storageKey = ignoreStorageKey(request.videoKey);
    const stored = await area.get(storageKey);
    const keys = readStringList(stored[storageKey]);
    if (request.type === "ignore.get") return { ok: true, value: keys };
    if (keys.includes(request.segmentKey)) return { ok: true, value: keys };
    // 只保留最近 200 条，避免长视频反复标记把 storage 撑大。
    const next = [...keys, request.segmentKey].slice(-200);
    await area.set({ [storageKey]: next });
    return { ok: true, value: next };
  });
}

function errorResponse(error: unknown): RuntimeResponse<never> {
  const kind = error instanceof LlmError ? error.kind : "internal";
  const message = errorText(error);
  logWarn("后台请求失败", { kind, message });
  return { ok: false, error: { kind, message } };
}

/**
 * 类型上走不到这里；扩展更新后旧内容脚本发来已删除的消息类型时才会命中。
 * 只记消息类型，不记请求体（连接请求里带 Key）。
 */
function unknownRequest(value: never): RuntimeResponse<never> {
  logWarn("收到未知的后台请求", (value as { type?: unknown }).type);
  return { ok: false, error: { kind: "unknown_request", message: t("background.unknownRequest") } };
}

function notConfigured(): RuntimeResponse<never> {
  return {
    ok: false,
    error: { kind: "not_configured", message: t("background.noProvider") }
  };
}

async function settingsSnapshot(area: StorageAreaLike): Promise<RuntimeSettings> {
  // 一次 get 读完设置：内容脚本每次分析、Popup 每次轮询都会走这里。
  const { policy, llm, siteSwitches, decision } = await readSettingsBundle(area);
  const info = describeLlmConfig(llm);
  const decisionConfigured = decisionReady(decision);
  // 缓存能力位随连接走：分析器据此决定对话历史压缩还是全量保留。
  const resolved = llm ? resolveConnection(llm) : undefined;
  return {
    policy,
    llmConfigured: info.configured,
    decisionConfigured,
    preferLlm: decision.preferLlm,
    analysisConfigured: info.configured || decisionConfigured,
    ...(decisionConfigured
      ? {
          decisionModel: decision.model,
          decisionEndpointOrigin: new URL(decision.endpoint).origin
        }
      : {}),
    ...(info.providerId ? { providerId: info.providerId } : {}),
    ...(info.providerLabel ? { providerLabel: info.providerLabel } : {}),
    ...(info.model ? { model: info.model } : {}),
    ...(info.endpointOrigin ? { endpointOrigin: info.endpointOrigin } : {}),
    llmPrefixCache: resolved?.autoPrefixCache === true,
    siteSwitches
  };
}

/**
 * 设置写完后通知各站点标签页重读。
 * storage.local 设了 TRUSTED_CONTEXTS，内容脚本收不到 onChanged 事件；
 * 不主动推一条，改类型策略或站点开关要等下一次分析才生效。
 *
 * 只查内容脚本能运行的地址：其余标签页发过去必定失败，查询也把面缩小了。
 * 没有 tabs 权限读不到 URL 的平台（或查询报错）时退回全量查询。
 */
async function notifySettingsChanged(): Promise<void> {
  const tabsApi = (globalThis as { chrome?: typeof chrome }).chrome?.tabs;
  if (!tabsApi) return;
  try {
    const { contentUrls, optionsUrl } = settingsChangeTargets();
    const contentTabs =
      contentUrls.length > 0
        ? await tabsApi.query({ url: contentUrls }).catch(() => tabsApi.query({}))
        : await tabsApi.query({});
    const optionsTabs = await tabsApi.query({ url: optionsUrl }).catch(() => []);
    const seen = new Set<number>();
    const tabs = [...contentTabs, ...optionsTabs].filter((tab) => {
      if (tab.id === undefined || seen.has(tab.id)) return false;
      seen.add(tab.id);
      return true;
    });
    await Promise.all(
      tabs.map((tab) =>
        tab.id === undefined
          ? undefined
          : tabsApi
              .sendMessage(tab.id, { type: "settings.changed" })
              .catch(() => undefined)
      )
    );
  } catch (error) {
    logWarn("通知内容脚本重读设置失败", errorText(error));
  }
}

async function completeLlm(
  area: StorageAreaLike,
  messages: LlmMessage[],
  signal?: AbortSignal,
  videoDurationMs?: number
): Promise<RuntimeResponse<unknown>> {
  const config = await readLlmConfig(area);
  const resolved = config ? resolveConnection(config) : undefined;
  if (!config || !resolved) return notConfigured();
  try {
    const value = await createLlmClient(resolved, {
      fetchImpl: fetch,
      ...(videoDurationMs !== undefined ? { videoDurationMs } : {})
    }).complete(messages, { signal });
    return { ok: true, value };
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCache(
  request: CacheRequest,
  cache: CacheStore
): Promise<RuntimeResponse<unknown>> {
  switch (request.type) {
    case "cache.get":
      return { ok: true, value: await cache.get(request.key) };
    case "cache.set":
      await cache.set(request.key, request.entry);
      return { ok: true, value: null };
    case "cache.delete":
      return { ok: true, value: await cache.delete(request.key) };
    case "cache.clear":
      return { ok: true, value: await cache.clear() };
    case "cache.trim":
      return { ok: true, value: await cache.trimExpired() };
  }
}

async function handleLlm(
  request: LlmRequest,
  area: StorageAreaLike,
  aborts: LlmAbortRegistry
): Promise<RuntimeResponse<unknown>> {
  if (request.type === "llm.abort") {
    return { ok: true, value: aborts.abort(request.requestId) };
  }
  const { requestId } = request;
  const run = (signal?: AbortSignal): Promise<RuntimeResponse<unknown>> =>
    completeLlm(area, request.messages, signal, request.videoDurationMs);
  if (!requestId) return run();
  const controller = aborts.create(requestId);
  try {
    return await run(controller.signal);
  } finally {
    aborts.release(requestId);
  }
}

async function handleMetrics(
  request: MetricsRequest,
  metrics: MetricsStore
): Promise<RuntimeResponse<unknown>> {
  switch (request.type) {
    case "metrics.skip":
      return { ok: true, value: await metrics.recordSkip(request.seconds) };
    case "metrics.undo":
      return { ok: true, value: await metrics.recordUndo() };
    case "metrics.get":
      return { ok: true, value: await metrics.read() };
    case "metrics.clear":
      await metrics.clear();
      return { ok: true, value: null };
  }
}

async function handleSettings(
  request: SettingsRequest,
  area: StorageAreaLike
): Promise<RuntimeResponse<unknown>> {
  switch (request.type) {
    case "settings.get":
      return { ok: true, value: await settingsSnapshot(area) };
    case "settings.setPolicy": {
      const saved = await writeAnalysisPolicy(area, request.patch);
      await notifySettingsChanged();
      return { ok: true, value: saved };
    }
    case "settings.setSiteSwitches": {
      const saved = await serializeSiteSwitches(() => writeSiteSwitches(area, request.patch));
      await notifySettingsChanged();
      return { ok: true, value: saved };
    }
    case "settings.getDecisionConfig":
      return { ok: true, value: await readDecisionConfig(area) };
    case "settings.setDecisionConfig": {
      const saved = await serializeDecisionConfig(() =>
        writeDecisionConfig(area, request.patch)
      );
      await notifySettingsChanged();
      return { ok: true, value: saved };
    }
  }
}

/** 建立或断开连接：把「拉模型、选模型、探能力」全部关在后台里。 */
async function handleConnection(
  request: ConnectionRequest,
  area: StorageAreaLike
): Promise<RuntimeResponse<unknown>> {
  if (request.type === "connection.disconnect") {
    const config = await clearActiveConnection(area);
    await notifySettingsChanged();
    return { ok: true, value: describeLlmConfig(config) };
  }
  try {
    const result = await connect(request.input, {
      fetchImpl: fetch
    });
    await saveConnection(area, request.input.providerId, result.entry);
    await notifySettingsChanged();
    const summary: ConnectResultSummary = {
      providerId: request.input.providerId,
      providerLabel: labelFor(request.input.providerId),
      model: result.entry.model,
      notes: result.notes
    };
    return { ok: true, value: summary };
  } catch (error) {
    return errorResponse(error);
  }
}

function handleBadge(request: BadgeRequest, senderTabId: number | undefined): void {
  if (senderTabId === undefined) return;
  void chrome.action.setBadgeText({ tabId: senderTabId, text: request.text }).catch(
    (error: unknown) => logWarn("角标写入失败", errorText(error))
  );
}

/**
 * 决策接口代发：Key 只在这里读，内容脚本拿不到。
 * 和 LLM 共用一个中止登记表，取消分析时两条链一起断。
 */
async function handleDecision(
  request: DecisionRequest,
  area: StorageAreaLike,
  aborts: LlmAbortRegistry
): Promise<RuntimeResponse<unknown>> {
  if (request.type === "decision.abort") {
    return { ok: true, value: aborts.abort(request.requestId) };
  }
  const config = await readDecisionConfig(area);
  if (!decisionReady(config)) {
    return {
      ok: false,
      error: { kind: "not_configured", message: t("background.noDecision") }
    };
  }
  const requestId = request.requestId ?? `decision-${Date.now().toString(36)}`;
  const controller = aborts.create(requestId);
  try {
    const client = createDecisionClient(
      { endpoint: config.endpoint, apiKey: config.apiKey, model: config.model },
      {
        fetchImpl: fetch,
        ...(request.videoDurationMs !== undefined
          ? { videoDurationMs: request.videoDurationMs }
          : {})
      }
    );
    const result = await client.decide({
      input: request.input,
      questions: request.questions,
      signal: controller.signal
    });
    return { ok: true, value: result };
  } catch (error) {
    return errorResponse(error);
  } finally {
    aborts.release(requestId);
  }
}

export async function handleRequest(
  request: RuntimeRequest,
  context: HandlerContext
): Promise<RuntimeResponse<unknown>> {
  switch (request.type) {
    case "cache.get":
    case "cache.set":
    case "cache.delete":
    case "cache.clear":
    case "cache.trim":
      return handleCache(request, context.cache);
    case "llm.complete":
    case "llm.abort":
      return handleLlm(request, context.area, context.aborts);
    case "settings.get":
    case "settings.setPolicy":
    case "settings.setSiteSwitches":
    case "settings.getDecisionConfig":
    case "settings.setDecisionConfig":
      return handleSettings(request, context.area);
    case "connection.connect":
    case "connection.disconnect":
      return handleConnection(request, context.area);
    case "badge.set":
      handleBadge(request, context.senderTabId);
      return { ok: true, value: null };
    case "ignore.get":
    case "ignore.add":
      return handleIgnore(request, context.area);
    case "decision.decide":
    case "decision.abort":
      return handleDecision(request, context.area, context.aborts);
    case "metrics.skip":
    case "metrics.undo":
    case "metrics.get":
    case "metrics.clear":
      return handleMetrics(request, context.metrics);
    default:
      // 新增消息类型必须在这条 switch 里接线，否则编译报错（request 收窄成 never）。
      return unknownRequest(request);
  }
}

/** 消息入口：任何未捕获异常都转成 ok:false，调用方永远拿到结构化结果。 */
export async function handleMessage(
  request: RuntimeRequest,
  context: HandlerContext
): Promise<RuntimeResponse<unknown>> {
  try {
    return await handleRequest(request, context);
  } catch (error) {
    return errorResponse(error);
  }
}
