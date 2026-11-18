import { useCallback, useRef, useState } from "react";
import { createSerializedQueue } from "../../core/ports/serialized-queue";
import { errorText } from "../../core/lib/error";
import { logWarn } from "../../core/lib/log";

/**
 * 设置页通用的乐观写 + 串行保存 + 乱序回滚。
 * 调用方提供类型化的保存函数和「写界面 / 回滚」回调，本 hook 只负责排队、
 * 只认最后一次写入、失败时把上一次落盘的值交回调用方。
 */
export function usePersistedSave<TValue>(
  send: (patch: unknown) => Promise<TValue>,
  apply: (value: TValue) => void,
  rollback: (lastSaved: TValue | null) => void,
  scope: string,
  initialSaved: TValue
): {
  save: (patch: unknown, optimistic: TValue) => Promise<void>;
  saveError: string | null;
  lastSavedRef: { current: TValue | null };
} {
  const [saveError, setSaveError] = useState<string | null>(null);
  const lastSavedRef = useRef<TValue | null>(initialSaved);
  const queue = useRef(createSerializedQueue()).current;
  const saveSeq = useRef(0);

  const save = useCallback(
    async (patch: unknown, optimistic: TValue): Promise<void> => {
      if (lastSavedRef.current === null) return;
      apply(optimistic);
      saveSeq.current += 1;
      const seq = saveSeq.current;
      await queue(async () => {
        try {
          const saved = await send(patch);
          lastSavedRef.current = saved;
          if (seq === saveSeq.current) {
            apply(saved);
            setSaveError(null);
          }
        } catch (error) {
          logWarn(scope, errorText(error));
          if (seq === saveSeq.current) {
            rollback(lastSavedRef.current);
            setSaveError(errorText(error));
          }
        }
      });
    },
    [apply, queue, rollback, scope, send]
  );

  return { save, saveError, lastSavedRef };
}
