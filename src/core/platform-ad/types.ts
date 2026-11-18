/** 平台广告即时快进的端口契约。核心只依赖这些稳定形状，站点机制留在各站目录。 */

/** 一次广告状态观察结果。 */
export interface PlatformAdObservation {
  /** 播放器当前是否处于平台广告状态。 */
  showingAd: boolean;
}

/** 一次快进动作的结果；秒数是这次动作让用户少等的时间。 */
export interface PlatformAdAction {
  /** 是否执行了动作（seek 或首次挂倍速）。 */
  acted: boolean;
  /**
   * 本次动作省下的秒数，取广告剩余时长。
   * 已经接近片尾、省不下什么的时候不写，避免同一条广告被重复累计。
   */
  seconds?: number;
}

export interface PlatformAdAdapter {
  /** 读一次当前广告状态；读不到（播放器不存在）返回 null 表示状态未知。 */
  observe(): PlatformAdObservation | null;
  /**
   * 快进当前广告；无可执行动作返回 acted=false，不抛错。
   * 具体策略由站点实现（YouTube：seek 优先、16 倍速兜底）。
   */
  fastForward(): PlatformAdAction;
  /** 播放器容器根节点，DOM 观察范围限定在它内部；无 DOM 环境返回 null。 */
  container(): Element | null;
  /** 释放站点端口持有的全局监听；核心状态机停止时调用。 */
  dispose?(): void;
}

export type PlatformAdPhase =
  | "no_ad"
  | "fast_forwarding"
  | "waiting"
  | "given_up";

/** 状态机快照：诊断与测试断言用。 */
export interface PlatformAdSnapshot {
  phase: PlatformAdPhase;
  /** 本次广告出现期间已执行的快进动作次数。 */
  attempts: number;
  /** 本次广告出现（appearance）的序号，从 1 开始。 */
  appearance: number;
}
