import { useState } from "react";
import type { JSX } from "react";
import { Play, Settings } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { PopupBody } from "./PopupBody";
import { badgeText, resolvePhase } from "./phase";
import { usePopupState } from "./use-popup-state";
import { t } from "../../core/i18n";

export default function App(): JSX.Element {
  const { ui, settings, issue, siteAuthorized, endpointAuthorized, commandError, runCommand } =
    usePopupState();
  const [showList, setShowList] = useState(false);
  const phase = resolvePhase(ui, settings, siteAuthorized, endpointAuthorized);
  const openSettings = (): void => {
    void chrome.runtime.openOptionsPage();
  };

  return (
    <div className="flex h-[600px] w-[380px] flex-col overflow-hidden rounded-lg border border-border bg-background">
      <header className="flex h-14 flex-none items-center gap-2.5 border-b border-border px-4">
        <div className="flex size-7 flex-none items-center justify-center rounded-md bg-brand text-white">
          <Play aria-hidden className="size-4 fill-current" />
        </div>
        <span className="text-body font-semibold grow">{t("app.name")}</span>
        <Badge variant="outline" className="font-mono text-overline">
          {badgeText(phase, ui?.segments.length ?? 0)}
        </Badge>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t("popup.openSettings")}
          onClick={openSettings}
        >
          <Settings aria-hidden />
        </Button>
      </header>
      {commandError && (
        <p className="flex-none border-b border-border bg-surface px-4 py-2 text-caption text-danger">
          {t("popup.commandFailed", { message: commandError })}
        </p>
      )}
      {/* 中部整块可滚动：固定 600px 的弹窗里，状态与片段列表会随结果变高。 */}
      <div className="flex min-h-0 grow flex-col overflow-y-auto">
        <PopupBody
          phase={phase}
          ui={ui}
          issue={issue}
          showList={showList}
          onShowList={() => setShowList(true)}
          onCommand={runCommand}
          onOpenSettings={openSettings}
        />
      </div>
    </div>
  );
}
