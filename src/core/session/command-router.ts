import type { Segment } from "../plugin/types";
import type { UiRequest } from "../ui/messages";
import { logInfo } from "../lib/log";
import { t } from "../i18n";
import type { SkipController } from "./skip-controller";

export interface CommandFailure {
  ok: false;
  message: string;
}

type ToastMode = "skipped" | "undone" | "info";

interface CommandHost {
  skip(): SkipController;
  publish(): void;
  showToast(
    segment: Segment,
    mode: ToastMode,
    options?: { manual?: boolean; end?: number; undoTo?: number }
  ): void;
  onSkipRecorded(segment: Segment, skippedEnd?: number): void;
  onUndoRecorded(): void;
  findSegmentByKey(key: string | undefined): Segment | undefined;
  markNotAd(key: string | undefined): Promise<boolean | void>;
  cancelAnalysis(): void;
  reanalyze(): Promise<CommandFailure | void>;
}

/** Popup 命令的路由：把「哪个键对应哪个动作」从会话生命周期里拿出来。 */
export class CommandRouter {
  constructor(private readonly host: CommandHost) {}

  private manualSkip(segment: Segment): void {
    if (!this.host.skip().manualSkip(segment)) return;
    this.host.showToast(segment, "skipped", { manual: true });
    this.host.onSkipRecorded(segment);
    logInfo(`手动跳过片段 ${segment.start.toFixed(1)}s-${segment.end.toFixed(1)}s`);
  }

  private undoByKey(key: string | undefined): void {
    const segment = this.host.findSegmentByKey(key);
    if (!segment) return;
    const to = this.host.skip().undo(segment);
    if (to === null) return;
    this.host.onUndoRecorded();
    this.host.showToast(segment, "undone", { undoTo: to });
    logInfo(`撤销跳过，回到 ${to.toFixed(1)}s`);
  }

  private skipToEndByKey(key: string | undefined): void {
    const segment = this.host.findSegmentByKey(key);
    if (segment) this.manualSkip(segment);
  }

  undo(key: string | undefined): void {
    this.undoByKey(key);
  }

  skipToEnd(key: string | undefined): void {
    this.skipToEndByKey(key);
  }

  async handle(request: Extract<UiRequest, { type: "ui.command" }>): Promise<void> {
    const result = await this.commands[request.command](request);
    if (result === false) throw new Error(t("ui.commandFailed"));
    if (typeof result === "object" && result !== null && !result.ok) {
      throw new Error(result.message);
    }
    this.host.publish();
  }

  private readonly commands: Record<
    Extract<UiRequest, { type: "ui.command" }>["command"],
    (
      request: Extract<UiRequest, { type: "ui.command" }>
    ) => Promise<boolean | CommandFailure | void> | boolean | CommandFailure | void
  > = {
    skipToEnd: (request) => this.skipToEndByKey(request.key),
    markNotAd: (request) => this.host.markNotAd(request.key),
    undoSkip: (request) => this.undoByKey(request.key),
    cancelAnalysis: () => this.host.cancelAnalysis(),
    reanalyze: () => this.host.reanalyze()
  };
}
