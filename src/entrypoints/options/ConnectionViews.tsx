import type { JSX } from "react";
import { Check, ChevronDown, KeyRound, Plug, Unplug } from "lucide-react";
import {
  CUSTOM_PROVIDER_ID,
  LLM_PRESETS,
  providerLabel
} from "../../core/ports/llm/config";
import { t } from "../../core/i18n";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Separator } from "../../components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../../components/ui/select";

export interface SavedConnection {
  providerId: string;
  providerLabel: string;
  model: string;
  /** 当前实际使用的接口地址；已连接时也直接展示，不藏在「换一家」后面。 */
  baseUrl?: string;
}

const PROVIDERS = [
  ...LLM_PRESETS.map((preset) => ({ id: preset.id, label: providerLabel(preset) })),
  { id: CUSTOM_PROVIDER_ID, label: t("connection.customProvider") }
];

export function ConnectedCard(props: {
  saved: SavedConnection;
  notes: string[];
  onSwitch: () => void;
  onDisconnect: () => void;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <Check aria-hidden className="size-4 text-success" />
        <span className="text-body font-semibold">
          {t("connection.connected", {
            provider: props.saved.providerLabel,
            model: props.saved.model
          })}
        </span>
      </div>
      {props.saved.baseUrl && (
        <div className="flex flex-col gap-0.5">
          <span className="text-overline text-muted-foreground">{t("connection.address")}</span>
          <span className="break-all font-mono text-caption text-muted-foreground">
            {props.saved.baseUrl}
          </span>
        </div>
      )}
      {props.notes.map((note) => (
        <span key={note} className="text-caption text-muted-foreground">
          {note === "models_unavailable" ? t("connection.note.modelsUnavailable") : note}
        </span>
      ))}
      <div className="mt-1 flex gap-3">
        <Button variant="outline" className="min-h-9 px-3" onClick={props.onSwitch}>
          {t("connection.changeProvider")}
        </Button>
        <Button variant="ghost" className="min-h-9 px-3" onClick={props.onDisconnect}>
          <Unplug aria-hidden />
          {t("connection.disconnect")}
        </Button>
      </div>
    </section>
  );
}

interface ConnectionFormValues {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

type ConnectionFormField = "apiKey" | "baseUrl" | "model";
type ConnectionFormAction = "connect" | "cancelSwitch";

export interface ConnectionFormProps {
  form: ConnectionFormValues;
  busy: boolean;
  hasSaved: boolean;
  addressError: string | null;
  onChooseProvider: (id: string) => void;
  onChange: (field: ConnectionFormField, value: string) => void;
  onCommitAddress: () => void;
  onAction: (action: ConnectionFormAction) => void;
}

/** 未连接时的表单：服务商、地址、Key，自定义端点再加模型名。状态由 ConnectionPage 持有。 */
export function ConnectionForm(props: ConnectionFormProps): JSX.Element {
  const custom = props.form.providerId === CUSTOM_PROVIDER_ID;
  const keyPlaceholder = custom
    ? t("connection.keyPlaceholderCustom")
    : t("connection.keyPlaceholder");
  return (
    <>
      <section className="flex flex-col gap-2.5">
        <Label htmlFor="provider">{t("connection.provider")}</Label>
        <Select
          value={props.form.providerId}
          disabled={props.busy}
          onValueChange={props.onChooseProvider}
        >
          <SelectTrigger id="provider" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            position="popper"
            className="min-w-[var(--radix-select-trigger-width)]"
          >
            {PROVIDERS.map((provider) => (
              <SelectItem
                key={provider.id}
                value={provider.id}
                data-provider-id={provider.id}
              >
                {provider.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-caption text-muted-foreground">
          {t("connection.providerHint")}
        </p>
      </section>

      <section className="flex flex-col gap-1.5">
        <Label htmlFor="base-url">{t("connection.address")}</Label>
        <Input
          id="base-url"
          className="font-mono"
          value={props.form.baseUrl}
          onChange={(event) => props.onChange("baseUrl", event.target.value)}
          onBlur={props.onCommitAddress}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            props.onCommitAddress();
          }}
          placeholder="https://api.deepseek.com"
          autoComplete="off"
          spellCheck={false}
          disabled={props.busy}
          aria-invalid={Boolean(props.addressError)}
        />
        <span className="text-overline text-muted-foreground">
          {custom
            ? t("connection.addressHintCustom")
            : t("connection.addressHintPreset")}
        </span>
        {props.addressError && (
          <span role="alert" className="text-overline text-danger">
            {props.addressError}
          </span>
        )}
      </section>

      {custom && (
        <section className="flex flex-col gap-1.5">
          <Label htmlFor="model">{t("connection.model")}</Label>
          <Input
            id="model"
            className="font-mono"
            value={props.form.model}
            onChange={(event) => props.onChange("model", event.target.value)}
            placeholder="qwen2.5:7b"
            disabled={props.busy}
          />
          <span className="text-overline text-muted-foreground">
            {t("connection.modelHint")}
          </span>
        </section>
      )}

      <Separator />

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="apikey">{t("connection.keyLabel")}</Label>
          <Input
            id="apikey"
            type="password"
            className="font-mono"
            value={props.form.apiKey}
            onChange={(event) => props.onChange("apiKey", event.target.value)}
            placeholder={keyPlaceholder}
            autoComplete="off"
            disabled={props.busy}
          />
          <span className="text-overline text-muted-foreground">
            {t("connection.keyHint")}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            className="min-h-10 px-4"
            disabled={props.busy || (!custom && !props.form.apiKey.trim())}
            onClick={() => props.onAction("connect")}
          >
            <Plug aria-hidden />
            {props.busy ? t("connection.connecting") : t("connection.connect")}
          </Button>
          {props.hasSaved && (
            <Button variant="ghost" className="min-h-10 px-3" onClick={() => props.onAction("cancelSwitch")}>
              {t("common.cancel")}
            </Button>
          )}
        </div>
        {props.busy && (
          <span className="text-caption text-muted-foreground">
            {t("connection.busyHint")}
          </span>
        )}
      </section>
    </>
  );
}

export function ConnectionErrorAlert(props: {
  error: { message: string; detail: string };
  showDetail: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <Alert variant="destructive">
      <KeyRound aria-hidden />
      <AlertDescription className="flex flex-col gap-1.5">
        <span>{props.error.message}</span>
        <button
          type="button"
          aria-expanded={props.showDetail}
          onClick={props.onToggle}
          className="flex w-fit items-center gap-1 text-overline text-muted-foreground"
        >
          <ChevronDown
            aria-hidden
            className={`size-3 transition-transform ${props.showDetail ? "rotate-180" : ""}`}
          />
          {t("common.errorDetail")}
        </button>
        {props.showDetail && (
          <span className="break-all font-mono text-overline text-muted-foreground">
            {props.error.detail}
          </span>
        )}
      </AlertDescription>
    </Alert>
  );
}
