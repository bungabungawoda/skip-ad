import {
  CUSTOM_PROVIDER_ID,
  DEFAULT_PROVIDER_ID,
  classifyProviderUrl,
  presetById
} from "../../core/ports/llm/config";
import { parseEndpointInput } from "../../core/ports/llm/endpoint";
import { t } from "../../core/i18n";

export interface ConnectionDraft {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  customBaseUrl: string;
  model: string;
  addressError: string | null;
  lastOrigin: string | null;
}

export type ConnectionDraftField = "apiKey" | "baseUrl" | "model";

export type ConnectionDraftAction =
  | { type: "choose-provider"; id: string }
  | { type: "input-address"; value: string }
  | { type: "commit-address" }
  | { type: "input-key"; value: string }
  | { type: "input-model"; value: string }
  | { type: "restore-custom"; baseUrl: string; model: string }
  | { type: "apply-target"; providerId: string; baseUrl: string }
  | { type: "set-address-error"; message: string | null };

function originOf(url: string): string | null {
  return parseEndpointInput(url)?.origin ?? null;
}

export function initialConnectionDraft(): ConnectionDraft {
  const baseUrl = presetById(DEFAULT_PROVIDER_ID)?.baseUrl ?? "";
  return {
    providerId: DEFAULT_PROVIDER_ID,
    apiKey: "",
    baseUrl,
    customBaseUrl: "",
    model: "",
    addressError: null,
    lastOrigin: originOf(baseUrl)
  };
}

function chooseProvider(state: ConnectionDraft, id: string): ConnectionDraft {
  const baseUrl = presetById(id)?.baseUrl ?? state.customBaseUrl;
  return {
    ...state,
    providerId: id,
    baseUrl,
    apiKey: "",
    addressError: null,
    lastOrigin: originOf(baseUrl)
  };
}

function inputAddress(state: ConnectionDraft, value: string): ConnectionDraft {
  const match = classifyProviderUrl(value);
  const nextProviderId =
    match.kind === "preset"
      ? match.preset.id
      : match.kind === "custom"
        ? CUSTOM_PROVIDER_ID
        : state.providerId;
  const nextOrigin = originOf(value);
  const originChanged = Boolean(
    state.lastOrigin && nextOrigin && state.lastOrigin !== nextOrigin
  );
  const providerChanged = nextProviderId !== state.providerId;

  return {
    ...state,
    providerId: nextProviderId,
    baseUrl: value,
    customBaseUrl: match.kind === "custom" ? match.baseUrl : state.customBaseUrl,
    apiKey: originChanged || providerChanged ? "" : state.apiKey,
    lastOrigin: nextOrigin ?? state.lastOrigin,
    addressError: null
  };
}

function commitAddress(state: ConnectionDraft): ConnectionDraft {
  const match = classifyProviderUrl(state.baseUrl);
  if (match.kind === "preset") {
    return {
      ...state,
      providerId: match.preset.id,
      baseUrl: match.baseUrl,
      apiKey: state.providerId === match.preset.id ? state.apiKey : "",
      lastOrigin: originOf(match.baseUrl),
      addressError: null
    };
  }
  if (match.kind === "custom") {
    return {
      ...state,
      providerId: CUSTOM_PROVIDER_ID,
      baseUrl: match.baseUrl,
      customBaseUrl: match.baseUrl,
      apiKey: state.providerId === CUSTOM_PROVIDER_ID ? state.apiKey : "",
      lastOrigin: originOf(match.baseUrl),
      addressError: null
    };
  }

  const preset = presetById(state.providerId);
  if (preset && state.baseUrl.trim() === "") {
    return { ...state, baseUrl: preset.baseUrl, addressError: null };
  }
  return {
    ...state,
    addressError:
      state.baseUrl.trim() === ""
        ? t("connection.addressRequired")
        : t("connection.addressInvalid")
  };
}

function applyTarget(
  state: ConnectionDraft,
  providerId: string,
  baseUrl: string
): ConnectionDraft {
  return {
    ...state,
    providerId,
    baseUrl,
    customBaseUrl: providerId === CUSTOM_PROVIDER_ID ? baseUrl : state.customBaseUrl,
    apiKey: providerId === state.providerId ? state.apiKey : "",
    lastOrigin: originOf(baseUrl),
    addressError: null
  };
}

export function connectionDraftReducer(
  state: ConnectionDraft,
  action: ConnectionDraftAction
): ConnectionDraft {
  switch (action.type) {
    case "choose-provider":
      return chooseProvider(state, action.id);
    case "input-address":
      return inputAddress(state, action.value);
    case "commit-address":
      return commitAddress(state);
    case "input-key":
      return { ...state, apiKey: action.value };
    case "input-model":
      return { ...state, model: action.value };
    case "restore-custom":
      return {
        ...state,
        customBaseUrl: action.baseUrl,
        model: action.model
      };
    case "apply-target":
      return applyTarget(state, action.providerId, action.baseUrl);
    case "set-address-error":
      return { ...state, addressError: action.message };
  }
  return state;
}

export function draftActionForField(
  field: ConnectionDraftField,
  value: string
): ConnectionDraftAction {
  if (field === "apiKey") return { type: "input-key", value };
  if (field === "baseUrl") return { type: "input-address", value };
  return { type: "input-model", value };
}

export type ConnectionTarget =
  | { kind: "ready"; providerId: string; baseUrl: string }
  | { kind: "error"; message: string };

/** 点击连接时再识别一次地址，避免只依赖失焦事件的时序。 */
export function resolveConnectionTarget(state: ConnectionDraft): ConnectionTarget {
  const match = classifyProviderUrl(state.baseUrl);
  if (match.kind === "preset") {
    return { kind: "ready", providerId: match.preset.id, baseUrl: match.baseUrl };
  }
  if (match.kind === "custom") {
    return { kind: "ready", providerId: CUSTOM_PROVIDER_ID, baseUrl: match.baseUrl };
  }
  const preset = presetById(state.providerId);
  if (preset && state.baseUrl.trim() === "") {
    return { kind: "ready", providerId: preset.id, baseUrl: preset.baseUrl };
  }
  return {
    kind: "error",
    message:
      state.baseUrl.trim() === ""
        ? t("connection.addressRequired")
        : t("connection.addressInvalid")
  };
}
