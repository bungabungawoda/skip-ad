/**
 * 决策客户端：把一份共享输入和一张问题表变成一次或多次 HTTP 请求。
 *
 * 和 LLM 客户端的区别：响应是 answers 映射，没有正文，也没有「结束原因」。
 * 所以这里不复用协议适配器，只共用错误分类。
 *
 * 用户填的是完整接口地址，请求原样发到那里；本地网关与代理不必再改代码。
 * 地址里带 typesafe 或路径以 /systemone 结尾时走 TypeSafe 格式；
 * 其余地址保持 Google decisions 格式。API Key 可空，本地网关通常不需要 Key。
 */

import { safeEndpoint, type FetchLike } from "../../lib/http";
import { errorText } from "../../lib/error";
import { logWarn } from "../../lib/log";
import { isRecord } from "../../lib/record";
import { classifyHttpStatus, retryAfterFromDetail, retryAfterMs } from "../http-status";
import { LlmError, ReplyShapeError } from "../llm/errors";
import {
  classifyThrown,
  defaultSleep,
  readErrorDetail,
  retryDelayMs,
  remainingRetryWaitMs,
  shouldRetry,
  shouldRetryTimeout,
  sleepUnlessAborted,
  type RequestLabels
} from "../llm/request-control";
import { decisionProtocol, type DecisionProtocol } from "./protocol";
import type {
  ChoiceAnswer,
  DecisionAnswer,
  DecisionClient,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  NoulAnswer,
  NoulCriteria
} from "./types";

export { LlmError } from "../llm/errors";

interface DecisionConnection {
  /** 完整接口地址，例如 /v1beta/decisions 或 /v1/systemone。 */
  endpoint: string;
  apiKey: string;
  model: string;
}

interface DecisionClientDeps {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /**
   * 单次请求超时。粗扫/细扫通常 1–3 秒，但边界阶段一次会问几十句，
   * 实测可到 20–60 秒；30 秒会把长商单的边界请求误判成超时。
   */
  timeoutMs?: number;
  retry?: boolean;
  /** 当前视频时长（毫秒），长视频按它放宽限流重试次数。 */
  videoDurationMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 1_000;

const DECISION_LABELS: RequestLabels = {
  cancelled: "决策请求已取消",
  timeout: "决策请求超时",
  network: "决策请求网络错误"
};
/** 只去掉末尾斜杠，不再补路径：设置页填什么接口，就请求什么接口。 */
export function decisionEndpoint(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireProbability(value: unknown, field: string): number {
  const parsed = readNumber(value);
  if (parsed === undefined || parsed < 0 || parsed > 1) {
    throw new ReplyShapeError(`决策答案的 ${field} 不是 0 到 1 的概率`);
  }
  return parsed;
}

function readProbabilities(value: unknown, field: string): Record<string, number> {
  if (!isRecord(value)) throw new ReplyShapeError(`决策答案缺少 ${field}`);
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    out[key] = requireProbability(raw, `${field}.${key}`);
  }
  return out;
}

function readOptionalProbability(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireProbability(value, field);
}

function readAnswer(key: string, raw: unknown, question: DecisionQuestion): DecisionAnswer {
  if (!isRecord(raw)) throw new ReplyShapeError(`问题 ${key} 的答案不是对象`);
  const type = raw.type;
  if (type === "noul" && question.type === "noul") {
    const confidence = readOptionalProbability(raw.confidence, "confidence");
    const answer: NoulAnswer = {
      type: "noul",
      noul: requireProbability(raw.noul, "noul"),
      ...(confidence === undefined ? {} : { confidence })
    };
    return answer;
  }
  if (type === "choice" && question.type === "choice") {
    if (typeof raw.choice !== "string" || !raw.choice) {
      throw new ReplyShapeError(`问题 ${key} 没有选出选项`);
    }
    if (!(raw.choice in question.criteria)) {
      // 选项是本地给的，模型返回表外的键说明响应被改过或串了请求。
      throw new ReplyShapeError(`问题 ${key} 选出了不存在的选项 ${raw.choice}`);
    }
    const answer: ChoiceAnswer = {
      type: "choice",
      choice: raw.choice,
      probabilities: readProbabilities(raw.probabilities, "probabilities"),
      confidence: requireProbability(raw.confidence, "confidence")
    };
    return answer;
  }
  throw new ReplyShapeError(`问题 ${key} 的答案类型 ${String(type)} 与问题类型 ${question.type} 不一致`);
}

/** 按问题表逐个校验答案；缺一个就算形状错误，不静默当 0 分。 */
function readAnswers(
  payload: Record<string, unknown>,
  questions: Record<string, DecisionQuestion>
): Record<string, DecisionAnswer> {
  const raw = payload.answers;
  if (!isRecord(raw)) throw new ReplyShapeError("决策响应里没有 answers");
  const answers: Record<string, DecisionAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const answer = raw[key];
    if (answer === undefined) throw new ReplyShapeError(`决策响应缺少问题 ${key} 的答案`);
    answers[key] = readAnswer(key, answer, question);
  }
  return answers;
}

/** TypeSafe 的问题表只认 true/false，不认 Google 的 true_description/false_description。 */
function typesafeCriteria(criteria: NoulCriteria | undefined): NoulCriteria | undefined {
  if (!criteria) return undefined;
  const yes = criteria.true ?? criteria.true_description;
  const no = criteria.false ?? criteria.false_description;
  if (yes === undefined && no === undefined) return undefined;
  return {
    ...(yes === undefined ? {} : { true: yes }),
    ...(no === undefined ? {} : { false: no })
  };
}

function wireQuestions(
  questions: Record<string, DecisionQuestion>,
  protocol: DecisionProtocol
): Record<string, DecisionQuestion> {
  if (protocol !== "typesafe") return questions;
  return Object.fromEntries(
    Object.entries(questions).map(([key, question]) => {
      if (question.type !== "noul" || question.criteria === undefined) {
        return [key, question];
      }
      const criteria = typesafeCriteria(question.criteria);
      return [
        key,
        criteria === undefined
          ? { type: "noul", instructions: question.instructions }
          : { ...question, criteria }
      ];
    })
  );
}

function requestBody(
  connection: DecisionConnection,
  request: DecisionRequest,
  protocol: DecisionProtocol
): Record<string, unknown> {
  if (protocol === "typesafe") {
    return {
      model: connection.model,
      state: request.input.map((block) => block.text).join(""),
      questions: wireQuestions(request.questions, protocol)
    };
  }
  return {
    model: connection.model,
    input: request.input,
    questions: request.questions
  };
}

function authHeaders(
  connection: DecisionConnection,
  protocol: DecisionProtocol
): Record<string, string> {
  if (!connection.apiKey) return {};
  return protocol === "typesafe"
    ? { Authorization: `Bearer ${connection.apiKey}` }
    : { "x-goog-api-key": connection.apiKey };
}

interface AttemptInput {
  connection: DecisionConnection;
  request: DecisionRequest;
  timeoutMs: number;
  fetchImpl: FetchLike;
}

type AttemptOutcome =
  | { ok: true; result: DecisionResult }
  | { ok: false; error: LlmError; retryAfter?: number };

async function attempt(input: AttemptInput): Promise<AttemptOutcome> {
  const { connection, request } = input;
  // 原生 fetch 当对象方法调用会抛 Illegal invocation，先取局部变量。
  const fetchImpl = input.fetchImpl;
  const url = safeEndpoint(decisionEndpoint(connection.endpoint));
  const protocol = decisionProtocol(connection.endpoint);
  const bodyText = JSON.stringify(requestBody(connection, request, protocol));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  request.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (request.signal?.aborted) controller.abort();

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(connection, protocol)
      },
      body: bodyText,
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await readErrorDetail(response, "读取决策接口错误响应体失败");
      const truncated = detail.slice(0, 300);
      const kind = classifyHttpStatus(response.status, truncated);
      const headerDelay = retryAfterMs(response);
      const bodyDelay = retryAfterFromDetail(detail);
      const error = new LlmError(
        `决策请求失败（${response.status}）${truncated ? `：${truncated}` : ""}`,
        kind,
        response.status
      );
      return {
        ok: false,
        error,
        retryAfter: headerDelay ?? bodyDelay
      };
    }
    const rawText = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(rawText) as unknown;
    } catch (error) {
      throw new ReplyShapeError(`决策响应不是合法 JSON：${errorText(error)}`);
    }
    if (!isRecord(payload)) throw new ReplyShapeError("决策响应不是对象");
    const answers = readAnswers(payload, request.questions);
    return { ok: true, result: { answers } };
  } catch (error) {
    const classified = classifyThrown(error, timedOut, request.signal, DECISION_LABELS);
    return { ok: false, error: classified };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onExternalAbort);
  }
}

export function createDecisionClient(
  connection: DecisionConnection,
  deps: DecisionClientDeps = {}
): DecisionClient {
  const sleep = deps.sleep ?? defaultSleep;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const retry = deps.retry !== false;
  const videoDurationMs = deps.videoDurationMs;

  return {
    async decide(request) {
      // 超时翻倍只对本次决策的重试生效：写在闭包外会让一次超时永久抬走后续所有请求的上限。
      let timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let waitedMs = 0;
      let timeoutAttempts = 0;
      for (let index = 0; ; index += 1) {
        const outcome = await attempt({
          connection,
          request,
          timeoutMs,
          fetchImpl
        });
        if (outcome.ok) return outcome.result;
        if (!retry || !shouldRetry(outcome.error.kind)) {
          throw outcome.error;
        }
        if (outcome.error.kind === "timeout") {
          if (!shouldRetryTimeout(timeoutAttempts)) throw outcome.error;
          timeoutAttempts += 1;
          timeoutMs *= 2;
          continue;
        }
        const waitMs = retryDelayMs(outcome.retryAfter, RETRY_DELAY_MS);
        const remaining = remainingRetryWaitMs(waitedMs, videoDurationMs);
        if (waitMs > remaining) throw outcome.error;
        waitedMs += waitMs;
        logWarn("决策请求失败，等待后重试", {
          kind: outcome.error.kind,
          attempt: index + 1,
          waitMs,
          waitedMs,
          budgetMs: remaining + waitMs
        });
        await sleepUnlessAborted(waitMs, request.signal, sleep, DECISION_LABELS.cancelled);
      }
    }
  };
}
