/**
 * 决策接口的类型契约。
 *
 * 和 LLM 端口不一样：这里不传消息，传一份共享输入加一张问题表；
 * 回来的不是正文，是每个问题的校准概率。三种问题各自的答案形状不同，
 * 用 type 字段区分，调用方按 type 取字段。
 */

export interface NoulCriteria {
  /** TypeSafe System One 的写法。 */
  true?: string;
  false?: string;
  /** Google decisions 的写法；发送给 TypeSafe 时会换成 true/false。 */
  true_description?: string;
  false_description?: string;
}

/** 是/否问题。criteria 可选，用来写清什么样算「是」。 */
interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: NoulCriteria;
}

/** 从固定选项里挑一个。criteria 的键是选项 ID，值是这条选项的含义。 */
interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion;

/** 共享输入：纯文本，或者按顺序拼接的文本块。 */
export interface DecisionTextBlock {
  type: "text";
  text: string;
}

export interface NoulAnswer {
  type: "noul";
  /** 0.01 到 0.99 的校准概率。 */
  noul: number;
  /** Google 会返回；TypeSafe 的 noul 答案没有这个字段。 */
  confidence?: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer;

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
}

export interface DecisionRequest {
  /** 共享输入。文本块之间按顺序直接拼接，不加分隔符。 */
  input: DecisionTextBlock[];
  questions: Record<string, DecisionQuestion>;
  signal?: AbortSignal;
  /** 当前视频时长（毫秒），长视频放宽限流重试次数。 */
  videoDurationMs?: number;
}

export interface DecisionClient {
  decide(request: DecisionRequest): Promise<DecisionResult>;
}
