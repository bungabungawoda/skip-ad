import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Tailwind 类名合并。只给 src/components/ui 里的组件用（shadcn 约定的 `@/lib/utils`）。
 * 与业务无关的通用函数放 core/lib，不要往这里加。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
