import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { BrainCircuit } from "lucide-react";
import {
  DEFAULT_DECISION_MODEL,
  type DecisionConfig
} from "../../core/ports/decision/config";
import {
  readDecisionSettings,
  readRuntimeSettings,
  writeDecisionSettings
} from "../../core/ports/runtime-client";
import { isEndpointUrl } from "../../core/ports/llm/endpoint";
import { isSettingsChangedMessage } from "../../core/ui/messages";
import { endpointPattern, requestEndpointAuthorization } from "../../core/ports/endpoint-auth";
import { errorText } from "../../core/lib/error";
import { logWarn } from "../../core/lib/log";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Separator } from "../../components/ui/separator";
import { Switch } from "../../components/ui/switch";
import { t } from "../../core/i18n";

/**
 * 决策模型设置：填了完整接口地址就优先用决策模型，留空就用上面配置的模型。
 * 两个都配时由「优先用上面配置的模型」开关决定用哪一条，选中的那条失败就报错。
 */
export function DecisionSection(): JSX.Element {
  const [config, setConfig] = useState<DecisionConfig | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(DEFAULT_DECISION_MODEL);
  const [preferLlm, setPreferLlm] = useState(false);
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await readDecisionSettings();
        setConfig(loaded);
        setEndpoint(loaded.endpoint);
        setApiKey(loaded.apiKey);
        setModel(loaded.model);
        setPreferLlm(loaded.preferLlm);
      } catch (cause) {
        setError(t("decision.readError"));
        logWarn("读取决策模型设置失败", errorText(cause));
      }
    })();
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void readRuntimeSettings()
        .then((settings) => {
          if (active) setLlmConfigured(settings.llmConfigured);
        })
        .catch((cause: unknown) => {
          logWarn("读取 LLM 连接状态失败", errorText(cause));
        });
    };
    refresh();
    const listener = (message: unknown): void => {
      if (isSettingsChangedMessage(message)) refresh();
    };
    chrome.runtime.onMessage?.addListener(listener);
    return () => {
      active = false;
      chrome.runtime.onMessage?.removeListener(listener);
    };
  }, []);

  const save = useCallback(async (): Promise<void> => {
    setError(null);
    setSaved(false);
    const nextEndpoint = endpoint.trim();
    if (nextEndpoint && !isEndpointUrl(nextEndpoint)) {
      setError(t("decision.invalidEndpoint"));
      return;
    }
    setBusy(true);
    try {
      // 权限申请必须在这个点击手势里同步发起，前面不能有 await。
      const auth = nextEndpoint
        ? await requestEndpointAuthorization({
            url: nextEndpoint,
            authorizedPattern: null,
            request: (pattern) => chrome.permissions.request({ origins: [pattern] })
          })
        : { authorized: true };
      const next = await writeDecisionSettings({
        endpoint: nextEndpoint,
        apiKey: apiKey.trim(),
        model: model.trim() || DEFAULT_DECISION_MODEL,
        preferLlm
      });
      setConfig(next);
      setEndpoint(next.endpoint);
      setApiKey(next.apiKey);
      setModel(next.model);
      setPreferLlm(next.preferLlm);
      setSaved(true);
      if (!auth.authorized) {
        // 只记权限模式（协议 + 主机），不把用户填的完整地址写进日志。
        logWarn("决策接口未授权", endpointPattern(nextEndpoint) ?? "地址无法解析");
        setError(t("decision.unauthorized"));
      }
    } catch (cause) {
      setError(errorText(cause, t("decision.saveFailed")));
    } finally {
      setBusy(false);
    }
  }, [endpoint, apiKey, model, preferLlm]);

  const decisionConfigured = (config?.endpoint ?? "").length > 0;
  const stateText = decisionConfigured
    ? preferLlm && llmConfigured
      ? t("decision.state.llmFirst")
      : t("decision.state.decisionFirst")
    : t("decision.state.llmOnly");

  return (
    <>
      <Separator />
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-body font-medium">
            <BrainCircuit aria-hidden className="size-4" />
            {t("decision.title")}
          </span>
          <span className="text-caption text-muted-foreground">
            {t("decision.description")}
          </span>
        </div>

        <p className="text-caption text-warning">
          {t("decision.usedByBoth")}
        </p>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="decision-endpoint">{t("decision.endpoint")}</Label>
          <Input
            id="decision-endpoint"
            className="font-mono"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="https://generativelanguage.googleapis.com/v1beta/decisions"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <span className="text-caption text-muted-foreground">
            {t("decision.endpointHint")}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="decision-key">{t("decision.key")}</Label>
            <Input
              id="decision-key"
              type="password"
              className="font-mono"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={t("decision.keyPlaceholder")}
              autoComplete="off"
              disabled={busy}
            />
            <span className="text-caption text-muted-foreground">
              {t("decision.keyHint")}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="decision-model">{t("decision.model")}</Label>
            <Input
              id="decision-model"
              className="font-mono"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={DEFAULT_DECISION_MODEL}
              disabled={busy}
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex min-w-0 grow flex-col gap-0.5">
            <span className="text-caption font-medium">{t("decision.preferLlm")}</span>
            <span className="text-overline text-muted-foreground">
              {t("decision.preferLlmHint")}
            </span>
          </div>
          <Switch
            checked={preferLlm}
            onCheckedChange={setPreferLlm}
            disabled={busy}
            aria-label={t("decision.preferLlm")}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            className="min-h-9 px-4"
            disabled={busy || config === null}
            onClick={() => void save()}
          >
            {busy ? t("decision.saving") : t("decision.save")}
          </Button>
          <span className="text-overline text-muted-foreground">
            {stateText}
            {saved ? ` · ${t("decision.saved")}` : ""}
          </span>
        </div>

        <p className="text-caption text-muted-foreground">
          {t("decision.privacyNote")}
        </p>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </section>
    </>
  );
}
