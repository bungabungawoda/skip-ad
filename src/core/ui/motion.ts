import { useReducedMotion } from "motion/react";
import { useMemo } from "react";
import type { Variants } from "motion/react";

/**
 * 全部动效只定义这三个变体。
 * prefers-reduced-motion: reduce 时三个变体全部直接显示，不播放位移。
 */

const EASE_TOAST_IN: [number, number, number, number] = [0.2, 0.8, 0.2, 1];

/** toastIn：180ms，从下方 8px 淡入。 */
const toastVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.18, ease: EASE_TOAST_IN } },
  exit: { opacity: 0, y: 4, transition: { duration: 0.14, ease: "easeIn" } }
};

/** panelSwitch：160ms 淡入，不位移。 */
const panelVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.16, ease: "easeOut" } },
  exit: { opacity: 0, transition: { duration: 0.08, ease: "easeIn" } }
};

const reducedVariantsForBoth: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0 } },
  exit: { opacity: 0, transition: { duration: 0 } }
};

interface UiMotionVariants {
  toast: Variants;
  panel: Variants;
}

const reducedVariants: UiMotionVariants = {
  toast: reducedVariantsForBoth,
  panel: reducedVariantsForBoth
};

const fullVariants: UiMotionVariants = {
  toast: toastVariants,
  panel: panelVariants
};

/** 组件里统一用这个 hook 取变体，reduced 时直接显示。 */
export function useUiMotion(): UiMotionVariants {
  const reduced = useReducedMotion() ?? false;
  return useMemo(() => (reduced ? reducedVariants : fullVariants), [reduced]);
}
