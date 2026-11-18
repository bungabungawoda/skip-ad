import { useCallback, useEffect, useReducer, useState } from "react";
import type { JSX } from "react";
import { CUSTOM_PROVIDER_ID, presetById } from "../../core/ports/llm/config";
import { t } from "../../core/i18n";
import { readRuntimeSettings, sendRuntime } from "../../core/ports/runtime-client";
import { endpointPattern, requestEndpointAuthorization } from "../../core/ports/endpoint-auth";
import { readLlmConfig, entryFor } from "../../core/ports/settings";
import { chromeStorageArea } from "../../core/ports/chrome-storage";
import type { ConnectResultSummary } from "../../core/ports/messages";
import { errorText } from "../../core/lib/error";
import { logWarn } from "../../core/lib/log";
import { Button } from "../../components/ui/button";
import { Separator } from "../../components/ui/separator";
import { DecisionSection } from "./DecisionSection";
import { humanError } from "./connection-errors";
import {
  connectionDraftReducer,
  draftActionForField,
  initialConnectionDraft,
  resolveConnectionTarget
} from "./connection-draft";
import {
  ConnectedCard,
  ConnectionErrorAlert,
  ConnectionForm,
  type SavedConnection
} from "./ConnectionViews";

/** 连接页只管状态与动作；表单、已连接卡片和错误提示都在 ConnectionViews。 */
export function ConnectionPage(): JSX.Element {
  const [saved, setSaved] = useState<SavedConnection | null>(null);
  const [switching, setSwitching] = useState(false);
  const [draft, dispatch] = useReducer(
    connectionDraftReducer,
    undefined,
    initialConnectionDraft
  );
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<{ message: string; detail: string } | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<{ ok: boolean; message: string } | null>(
    null
  );
  const [cacheBusy, setCacheBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const settings = await readRuntimeSettings();
        const config = await readLlmConfig(chromeStorageArea());
        if (settings.llmConfigured && settings.providerId && settings.providerLabel) {
          const entry = entryFor(config, settings.providerId);
          setSaved({
            providerId: settings.providerId,
            providerLabel: settings.providerLabel,
            model: settings.model ?? "",
            baseUrl: entry?.baseUrl ?? presetById(settings.providerId)?.baseUrl
          });
        }
        const custom = entryFor(config, CUSTOM_PROVIDER_ID);
        if (custom) {
          dispatch({
            type: "restore-custom",
            baseUrl: custom.baseUrl ?? "",
            model: custom.model ?? ""
          });
        }
      } catch (error) {
        logWarn("读取连接状态失败", errorText(error));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const chooseProvider = useCallback((id: string) => {
    dispatch({ type: "choose-provider", id });
    setError(null);
    setNotes([]);
  }, []);

  const commitAddress = useCallback(() => {
    dispatch({ type: "commit-address" });
  }, []);

  const onConnect = useCallback(async (): Promise<void> => {
    const target = resolveConnectionTarget(draft);
    if (target.kind === "error") {
      dispatch({ type: "set-address-error", message: target.message });
      return;
    }
    if (target.providerId !== draft.providerId) {
      dispatch({
        type: "apply-target",
        providerId: target.providerId,
        baseUrl: target.baseUrl
      });
      dispatch({
        type: "set-address-error",
        message: t("connection.addressOtherProvider")
      });
      return;
    }
    dispatch({
      type: "apply-target",
      providerId: target.providerId,
      baseUrl: target.baseUrl
    });

    setError(null);
    setNotes([]);
    setBusy(true);
    try {
      // 自定义地址要的权限必须在这个点击手势里同步发起，前面不能有 await。
      if (target.providerId === CUSTOM_PROVIDER_ID) {
        const auth = await requestEndpointAuthorization({
          url: target.baseUrl,
          authorizedPattern: null,
          request: (pattern) => chrome.permissions.request({ origins: [pattern] })
        });
        if (!auth.authorized) {
          // 只记权限模式（协议 + 主机），不把用户填的完整地址写进日志。
          logWarn(
            "自定义端点未授权，继续尝试直连",
            endpointPattern(target.baseUrl) ?? "地址无法解析"
          );
        }
      }
      const result = await sendRuntime<ConnectResultSummary>({
        type: "connection.connect",
        input: {
          providerId: target.providerId,
          apiKey: draft.apiKey,
          ...(target.providerId === CUSTOM_PROVIDER_ID
            ? { baseUrl: target.baseUrl, model: draft.model }
            : {})
        }
      });
      setSaved({
        providerId: result.providerId,
        providerLabel: result.providerLabel,
        model: result.model,
        baseUrl: target.baseUrl
      });
      setNotes(result.notes);
      dispatch({ type: "input-key", value: "" });
      setSwitching(false);
    } catch (caught) {
      setError({ message: humanError(caught), detail: errorText(caught) });
    } finally {
      setBusy(false);
    }
  }, [draft]);

  const onDisconnect = useCallback(async (): Promise<void> => {
    try {
      await sendRuntime({ type: "connection.disconnect" });
      setSaved(null);
      setNotes([]);
      setSwitching(true);
    } catch (caught) {
      setError({ message: humanError(caught), detail: errorText(caught) });
    }
  }, []);

  const onClearCache = useCallback(async (): Promise<void> => {
    setCacheStatus(null);
    setCacheBusy(true);
    try {
      await sendRuntime({ type: "cache.clear" });
      setCacheStatus({ ok: true, message: t("connection.cacheCleared") });
    } catch (caught) {
      setCacheStatus({ ok: false, message: t("connection.cacheClearFailed") });
      logWarn("清空缓存失败", errorText(caught));
    } finally {
      setCacheBusy(false);
    }
  }, []);

  if (loading) {
    return <p className="text-caption text-muted-foreground">{t("connection.loading")}</p>;
  }

  return (
    <div className="flex flex-col gap-5">
      {saved && !switching ? (
        <ConnectedCard
          saved={saved}
          notes={notes}
          onSwitch={() => {
            setSwitching(true);
            dispatch({
              type: "choose-provider",
              id: presetById(saved.providerId) ? saved.providerId : CUSTOM_PROVIDER_ID
            });
            setError(null);
          }}
          onDisconnect={() => void onDisconnect()}
        />
      ) : (
        <ConnectionForm
          form={{
            providerId: draft.providerId,
            apiKey: draft.apiKey,
            baseUrl: draft.baseUrl,
            model: draft.model
          }}
          busy={busy}
          hasSaved={saved !== null}
          addressError={draft.addressError}
          onChooseProvider={chooseProvider}
          onChange={(field, value) => dispatch(draftActionForField(field, value))}
          onCommitAddress={commitAddress}
          onAction={(action) => {
            if (action === "connect") void onConnect();
            else {
              setSwitching(false);
              dispatch({ type: "set-address-error", message: null });
            }
          }}
        />
      )}

      {error && (
        <ConnectionErrorAlert
          error={error}
          showDetail={showDetail}
          onToggle={() => setShowDetail((value) => !value)}
        />
      )}

      <DecisionSection />

      <Separator />
      <div className="flex flex-col gap-1">
        <Button
          variant="outline"
          className="min-h-9 w-fit px-3"
          disabled={cacheBusy}
          onClick={() => void onClearCache()}
        >
          {cacheBusy ? t("connection.cacheClearing") : t("connection.cacheClear")}
        </Button>
        {cacheStatus && (
          <p
            role="status"
            className={`text-caption ${cacheStatus.ok ? "text-muted-foreground" : "text-danger"}`}
          >
            {cacheStatus.message}
          </p>
        )}
      </div>
    </div>
  );
}
