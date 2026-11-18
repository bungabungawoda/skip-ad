import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { RefreshCw, Timer, Trash2 } from "lucide-react";
import { EMPTY_SKIP_TOTALS, type SkipTotals } from "../../core/metrics/types";
import { clearMetrics, readSkipTotals } from "../../core/ports/runtime-client";
import { errorText } from "../../core/lib/error";
import { logWarn } from "../../core/lib/log";
import { Button } from "../../components/ui/button";
import { formatNumber, formatSavedDetail, formatSavedTime } from "./format";
import { t } from "../../core/i18n";

function Stat(props: { label: string; value: string; detail: string }): JSX.Element {
  return (
    <section className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-surface p-4">
      <span className="text-overline text-muted-foreground">{props.label}</span>
      <span className="font-mono text-title font-semibold text-foreground">{props.value}</span>
      <span className="text-caption text-muted-foreground">{props.detail}</span>
    </section>
  );
}

/** 本机累计的跳过统计：段数、时长与撤销次数。 */
export function MetricsPage(): JSX.Element {
  const [totals, setTotals] = useState<SkipTotals>({ ...EMPTY_SKIP_TOTALS });
  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void readSkipTotals().then((value) => {
      if (!active) return;
      setTotals(value);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setTotals(await readSkipTotals());
    setLoading(false);
  }, []);

  const onClear = async (): Promise<void> => {
    try {
      await clearMetrics();
      setTotals({ ...EMPTY_SKIP_TOTALS });
      setConfirmClear(false);
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
      logWarn("清空跳过统计失败", errorText(caught));
    }
  };

  const saved = formatSavedTime(totals.savedSeconds);

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-wrap items-end justify-between gap-4 rounded-md border border-brand/40 bg-brand-soft px-5 py-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-overline text-brand-ink">
            <Timer aria-hidden className="size-3.5" />
            {t("metrics.savedTitle")}
          </span>
          <span className="flex items-baseline gap-1.5" title={formatSavedDetail(totals.savedSeconds)}>
            <span className="font-mono text-display text-brand-ink">{saved.value}</span>
            <span className="text-section text-brand-ink">{saved.unit}</span>
          </span>
          <span className="text-caption text-brand-ink/80">{t("metrics.localOnly")}</span>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw aria-hidden />
          {t("common.refresh")}
        </Button>
      </section>

      {loading ? (
        <p className="text-caption text-muted-foreground">{t("metrics.loading")}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            label={t("metrics.skippedSegments")}
            value={t("metrics.skippedSegmentsValue", {
              count: formatNumber(totals.skippedSegments)
            })}
            detail={t("metrics.skippedSegmentsDetail")}
          />
          <Stat
            label={t("metrics.savedTime")}
            value={formatSavedDetail(totals.savedSeconds)}
            detail={t("metrics.savedTimeDetail")}
          />
          <Stat
            label={t("metrics.undo")}
            value={t("metrics.undoValue", { count: formatNumber(totals.undoCount) })}
            detail={t("metrics.undoDetail")}
          />
        </div>
      )}

      <section className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-4">
        <span className="text-caption text-muted-foreground">
          {t("metrics.clearHint")}
        </span>
        <Button
          variant={confirmClear ? "destructive" : "outline"}
          size="sm"
          className="ml-auto"
          onClick={() => (confirmClear ? void onClear() : setConfirmClear(true))}
        >
          <Trash2 aria-hidden />
          {confirmClear ? t("metrics.confirmClear") : t("metrics.clear")}
        </Button>
        {error && (
          <p role="alert" className="basis-full text-caption text-danger">
            {t("metrics.clearError", { message: error })}
          </p>
        )}
      </section>
    </div>
  );
}
