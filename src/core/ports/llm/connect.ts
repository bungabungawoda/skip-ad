/**
 * 建立连接：拉模型列表、选模型、验证地址与 Key、探一次结构化输出能力。
 *
 * 用户只按一个按钮；这里替他把三件事做完，失败只留下一条人能看懂的错。
 * 预设服务商一次请求即可验证；自定义端点最多多发三次（换协议试）。
 */

import type { ConnectionEntry, ProviderPreset, ResolvedConnection } from "./config";
import { CUSTOM_PROVIDER_ID, isEndpointUrl, presetById } from "./config";
import { detectProtocolFromUrl, protocolById, type ProtocolId } from "./protocols";
import { resolveEndpoint } from "./protocols/shared";
import { pickModel, readModelList, type ModelEntry } from "./models";
import { createLlmClient, LlmError } from "./client";
import type { LlmMessage } from "./types";
import type { FetchLike } from "../../lib/http";
import { errorText } from "../../lib/error";
import { logWarn } from "../../lib/log";

interface ConnectInput {
  providerId: string;
  apiKey: string;
  /** 只有自定义端点需要。 */
  baseUrl?: string;
  /** 自定义端点必填；预设服务商可以覆盖解析结果。 */
  model?: string;
}

interface ConnectResult {
  entry: ConnectionEntry;
  /** 给界面看的一行说明，例如「读不到模型列表，用的是默认模型」。 */
  notes: string[];
}

interface ConnectDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
}

const PROBE_MESSAGES: LlmMessage[] = [
  { role: "system", content: '只回复 JSON：{"ok":true}' },
  { role: "user", content: "连接测试" }
];

const MODELS_TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 15_000;

/** 自定义端点的尝试顺序：OpenAI 兼容最常见，Anthropic 路径固定，Responses 最年轻。 */
const PROBE_ORDER: ProtocolId[] = ["openai-chat", "anthropic", "openai-responses"];

function modelListUrl(protocol: ProtocolId, baseUrl: string): string | null {
  return resolveEndpoint(baseUrl, "/models", protocol === "anthropic");
}

async function fetchModelList(
  connection: ResolvedConnection,
  fetchImpl: FetchLike
): Promise<ModelEntry[] | undefined> {
  const url = modelListUrl(connection.protocol, connection.baseUrl);
  if (!url) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: protocolById(connection.protocol).authHeaders(connection.apiKey),
      signal: controller.signal
    });
    if (!response.ok) {
      logWarn("读取模型列表失败", { status: response.status, url });
      return undefined;
    }
    const payload: unknown = await response.json();
    return readModelList(payload);
  } catch (error) {
    // 模型列表读不到时界面只显示「读不到列表」；这里留下真实原因，排障不再靠猜。
    logWarn("读取模型列表失败", { url, error: errorText(error) });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function probeClient(connection: ResolvedConnection, deps: ConnectDeps) {
  return createLlmClient(connection, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    retry: false,
    timeoutMs: PROBE_TIMEOUT_MS
  });
}

/** 发一次最小请求确认地址与 Key 可用，同时定下结构化输出能力位。 */
async function verifyCapability(
  connection: ResolvedConnection,
  deps: ConnectDeps
): Promise<boolean> {
  if (!connection.jsonObject) {
    await probeClient({ ...connection, jsonObject: false }, deps).complete(PROBE_MESSAGES);
    return false;
  }
  try {
    await probeClient({ ...connection, jsonObject: true }, deps).complete(PROBE_MESSAGES);
    return true;
  } catch (error) {
    if (error instanceof LlmError && error.kind === "bad_request") {
      await probeClient({ ...connection, jsonObject: false }, deps).complete(PROBE_MESSAGES);
      return false;
    }
    throw error;
  }
}

async function detectProtocol(
  baseUrl: string,
  model: string,
  apiKey: string,
  deps: ConnectDeps
): Promise<ProtocolId> {
  const known = detectProtocolFromUrl(baseUrl);
  if (known) return known;
  const errors: LlmError[] = [];
  for (const protocol of PROBE_ORDER) {
    const connection: ResolvedConnection = {
      providerId: CUSTOM_PROVIDER_ID,
      preset: undefined,
      protocol,
      baseUrl,
      model,
      apiKey,
      jsonObject: false,
      autoPrefixCache: false
    };
    try {
      await probeClient(connection, deps).complete(PROBE_MESSAGES);
      return protocol;
    } catch (error) {
      const classified =
        error instanceof LlmError ? error : new LlmError("连接失败", "network");
      errors.push(classified);
      // Key 不对、余额不足与协议无关：换一种协议只会再打两次无用请求，还可能触发限流。
      if (
        classified.kind === "auth" ||
        classified.kind === "quota" ||
        classified.kind === "cancelled"
      ) {
        throw classified;
      }
    }
  }
  const auth = errors.find((error) => error.kind === "auth");
  throw auth ?? errors[0] ?? new LlmError("连不上这个地址", "network");
}

async function connectPreset(
  preset: ProviderPreset,
  input: ConnectInput,
  deps: ConnectDeps
): Promise<ConnectResult> {
  const notes: string[] = [];
  const base: ResolvedConnection = {
    providerId: preset.id,
    preset,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    model: "",
    apiKey: input.apiKey,
    jsonObject: preset.jsonObject,
    autoPrefixCache: preset.autoPrefixCache
  };

  let model = input.model?.trim() ?? "";
  if (!model) {
    const entries = await fetchModelList(base, deps.fetchImpl ?? fetch);
    if (entries) {
      model = pickModel(entries, preset.fallbackModel);
    } else {
      model = preset.fallbackModel;
      notes.push("models_unavailable");
    }
  }

  const connection: ResolvedConnection = { ...base, model };
  const jsonObject = await verifyCapability(connection, deps);
  return {
    entry: {
      model,
      apiKey: input.apiKey,
      jsonObject,
      connectedAt: deps.now?.() ?? Date.now()
    },
    notes
  };
}

async function connectCustom(
  input: ConnectInput,
  deps: ConnectDeps
): Promise<ConnectResult> {
  const baseUrl = input.baseUrl?.trim() ?? "";
  if (!isEndpointUrl(baseUrl)) {
    throw new LlmError("端点地址格式不对：用 https://，本机网关可以用 http://127.0.0.1", "bad_request");
  }
  const model = input.model?.trim() ?? "";
  if (!model) throw new LlmError("请填写模型名", "bad_request");

  const protocol = await detectProtocol(baseUrl, model, input.apiKey, deps);
  const connection: ResolvedConnection = {
    providerId: CUSTOM_PROVIDER_ID,
    preset: undefined,
    protocol,
    baseUrl,
    model,
    apiKey: input.apiKey,
    jsonObject: true,
    autoPrefixCache: false
  };
  const jsonObject = await verifyCapability(connection, deps);

  return {
    entry: {
      model,
      apiKey: input.apiKey,
      jsonObject,
      connectedAt: deps.now?.() ?? Date.now(),
      baseUrl,
      protocol
    },
    notes: []
  };
}

export async function connect(input: ConnectInput, deps: ConnectDeps = {}): Promise<ConnectResult> {
  const preset = presetById(input.providerId);
  if (preset) return connectPreset(preset, input, deps);
  if (input.providerId === CUSTOM_PROVIDER_ID) return connectCustom(input, deps);
  throw new LlmError("未知的服务商", "bad_request");
}
