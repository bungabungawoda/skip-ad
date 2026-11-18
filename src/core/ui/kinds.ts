import type { CSSProperties } from "react";
import type { SegmentKind } from "../plugin/types";
import type { SegmentPolicy } from "../analysis/types";
import { t, type MessageKey } from "../i18n";

/**
 * 六种片段类型的展示元数据：颜色变量、图案与证据说明。
 * 中文名走 core/policy/kinds 的 kindLabel，可选策略走
 * core/policy/policy 的 allowedPolicies，这里只放展示用的字段。
 * 颜色变量对应 globals.css 里的 --seg-* token，组件里不要写十六进制颜色。
 */
interface KindMeta {
  kind: SegmentKind;
  cssVar: string;
  pattern: "solid" | "stripe" | "dots" | "outline";
  /** Options 类型策略页每行的证据说明。 */
  descriptionKey: MessageKey;
}

export const KIND_META: Record<SegmentKind, KindMeta> = {
  sponsor: {
    kind: "sponsor",
    cssVar: "--seg-sponsor",
    pattern: "solid",
    descriptionKey: "policy.kind.sponsorDesc"
  },
  insert: {
    kind: "insert",
    cssVar: "--seg-insert",
    pattern: "stripe",
    descriptionKey: "policy.kind.insertDesc"
  },
  promo: {
    kind: "promo",
    cssVar: "--seg-promo",
    pattern: "dots",
    descriptionKey: "policy.kind.promoDesc"
  },
  self_promo: {
    kind: "self_promo",
    cssVar: "--seg-self-promo",
    pattern: "outline",
    descriptionKey: "policy.kind.selfPromoDesc"
  },
  topic: {
    kind: "topic",
    cssVar: "--seg-topic",
    pattern: "solid",
    descriptionKey: "policy.kind.topicDesc"
  },
  unknown: {
    kind: "unknown",
    cssVar: "--seg-unknown",
    pattern: "stripe",
    descriptionKey: "policy.kind.unknownDesc"
  }
};

export function kindDescription(kind: SegmentKind): string {
  const meta = KIND_META[kind];
  return t(meta?.descriptionKey ?? "policy.kind.unknownDesc");
}

/**
 * 16 像素图案色块的样式。浅色成分用 color-mix 混入 --background，
 * 同一段代码在浅色和深色主题下都成立。
 */
export function kindSwatchStyle(kind: SegmentKind): CSSProperties {
  const meta = KIND_META[kind];
  const color = `var(${meta?.cssVar ?? "--seg-unknown"})`;
  const soft = `color-mix(in srgb, ${color} 30%, var(--background))`;
  const softer = `color-mix(in srgb, ${color} 16%, var(--background))`;
  const strong = `color-mix(in srgb, ${color} 70%, var(--foreground))`;
  switch (meta?.pattern) {
    case "stripe":
      return {
        background: `repeating-linear-gradient(45deg, ${color}, ${color} 3px, ${soft} 3px, ${soft} 6px)`
      };
    case "dots":
      return {
        backgroundColor: softer,
        backgroundImage: `radial-gradient(circle, ${color} 2px, transparent 2px)`,
        backgroundSize: "6px 6px"
      };
    case "outline":
      return {
        border: `2px solid ${strong}`,
        backgroundColor: softer
      };
    case "solid":
    default:
      return { backgroundColor: color };
  }
}

/** 策略的界面文案。 */
export function policyText(policy: SegmentPolicy): string {
  if (policy === "auto") return t("policy.auto");
  if (policy === "mark") return t("policy.mark");
  return t("policy.off");
}
