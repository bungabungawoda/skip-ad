import type { SegmentKind } from "../plugin/types";
import { t, type MessageKey } from "../i18n";

/** 六种片段类型的展示名。领域语义，UI 与提示词共用同一份。 */
const KIND_LABEL_KEYS: Record<SegmentKind, MessageKey> = {
  sponsor: "policy.kind.sponsor",
  insert: "policy.kind.insert",
  promo: "policy.kind.promo",
  self_promo: "policy.kind.self_promo",
  topic: "policy.kind.topic",
  unknown: "policy.kind.unknown"
};

export function kindLabel(kind: SegmentKind): string {
  return t(KIND_LABEL_KEYS[kind] ?? "policy.kind.unknown");
}
