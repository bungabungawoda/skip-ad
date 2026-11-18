import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { GripVertical } from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { sendRuntime } from "../../core/ports/runtime-client";
import { isSettingsChangedMessage } from "../../core/ui/messages";
import { errorText } from "../../core/lib/error";
import { logWarn } from "../../core/lib/log";
import { chromeStorageArea } from "../../core/ports/chrome-storage";
import { readAnalysisPolicy } from "../../core/ports/settings";
import {
  DEFAULT_POLICY,
  KIND_PROMPT_MAX_LENGTH,
  allowedPolicies,
  normalizePolicy
} from "../../core/policy/policy";
import type { AnalysisPolicy, AnalysisPolicyPatch, SegmentPolicy } from "../../core/analysis/types";
import { SEGMENT_KINDS, type SegmentKind } from "../../core/plugin/types";
import {
  kindDescription,
  kindSwatchStyle,
  policyText
} from "../../core/ui/kinds";
import { kindLabel } from "../../core/policy/kinds";
import { usePersistedSave } from "./use-persisted-setting";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../../components/ui/select";
import { t } from "../../core/i18n";


/** 策略读取、保存与排序/改写回调集中在这里，组件只负责渲染。 */
function usePolicyConfig() {
  const [policy, setPolicy] = useState<AnalysisPolicy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const sendSave = useCallback(
    (patch: unknown) =>
      sendRuntime<AnalysisPolicy>({
        type: "settings.setPolicy",
        patch: patch as AnalysisPolicyPatch
      }),
    []
  );
  const applySaved = useCallback((next: AnalysisPolicy) => {
    setPolicy(next);
  }, []);
  const rollback = useCallback((lastSaved: AnalysisPolicy | null) => {
    setPolicy(lastSaved);
  }, []);
  const { save: persist, saveError, lastSavedRef } = usePersistedSave<AnalysisPolicy>(
    sendSave,
    applySaved,
    rollback,
    t("policy.saveScope"),
    DEFAULT_POLICY
  );

  useEffect(() => {
    const reload = (): void => {
      void readAnalysisPolicy(chromeStorageArea())
        .then((loaded) => {
          lastSavedRef.current = loaded;
          setPolicy(loaded);
          setLoadError(null);
        })
        .catch((error: unknown) => {
          setLoadError(errorText(error));
          logWarn("读取类型策略失败", errorText(error));
        });
    };
    const listener = (message: unknown): void => {
      if (isSettingsChangedMessage(message)) reload();
    };
    reload();
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [lastSavedRef, setPolicy, setLoadError]);

  const savePatch = useCallback(
    (patch: AnalysisPolicyPatch): void => {
      const current = lastSavedRef.current;
      if (!current) return;
      const next = normalizePolicy({
        ...current,
        ...patch,
        ...(patch.perKind ? { perKind: { ...current.perKind, ...patch.perKind } } : {})
      });
      void persist(patch, next);
    },
    [lastSavedRef, persist]
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const { active, over } = event;
      if (!over || active.id === over.id || !policy) return;
      const current = policy.kindOrder;
      const from = current.indexOf(active.id as SegmentKind);
      const to = current.indexOf(over.id as SegmentKind);
      if (from < 0 || to < 0) return;
      savePatch({ kindOrder: arrayMove(current, from, to) });
    },
    [policy, savePatch]
  );

  const onPolicyChange = useCallback(
    (kind: SegmentKind, value: SegmentPolicy): void => {
      if (!policy) return;
      savePatch({ perKind: { [kind]: value } });
    },
    [policy, savePatch]
  );

  const onDescriptionChange = useCallback(
    (kind: SegmentKind, text: string): void => {
      if (!policy) return;
      const currentOverrides = lastSavedRef.current?.kindPromptOverrides;
      const overrides = { ...(currentOverrides ?? {}) };
      if (text) overrides[kind] = text;
      else delete overrides[kind];
      savePatch({
        kindPromptOverrides: Object.keys(overrides).length > 0 ? overrides : undefined
      });
    },
    [policy, savePatch, lastSavedRef]
  );
  return { policy, loadError, saveError, onDragEnd, onPolicyChange, onDescriptionChange };
}

function PolicyTable(props: {
  policy: AnalysisPolicy;
  kindOrder: SegmentKind[];
  onDragEnd: (event: DragEndEvent) => void;
  onPolicyChange: (kind: SegmentKind, value: SegmentPolicy) => void;
  onDescriptionChange: (kind: SegmentKind, text: string) => void;
}): JSX.Element {
  const { policy, kindOrder, onDragEnd, onPolicyChange, onDescriptionChange } = props;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={kindOrder} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2">
          {kindOrder.map((kind) => (
            <SortableRow
              key={kind}
              kind={kind}
              value={policy.perKind[kind] ?? DEFAULT_POLICY.perKind[kind]}
              override={policy.kindPromptOverrides?.[kind]}
              onValueChange={(value) => onPolicyChange(kind, value)}
              onDescriptionChange={(text) => onDescriptionChange(kind, text)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function RowContent(props: {
  kind: SegmentKind;
  value: SegmentPolicy;
  override?: string;
  onValueChange: (value: SegmentPolicy) => void;
  onDescriptionChange: (text: string) => void;
}): JSX.Element {
  const { kind, value, override, onValueChange, onDescriptionChange } = props;
  const defaultText = kindDescription(kind);
  const [draft, setDraft] = useState(override ?? "");

  const commit = (): void => {
    const next = draft.trim().slice(0, KIND_PROMPT_MAX_LENGTH);
    if (!next || next === defaultText) {
      setDraft("");
      onDescriptionChange("");
      return;
    }
    if (next !== override) {
      setDraft(next);
      onDescriptionChange(next);
    }
  };

  return (
    <>
      <span
        aria-hidden
        className="size-4 flex-none rounded-[4px]"
        style={kindSwatchStyle(kind)}
      />
      <span className="w-[76px] flex-none text-label font-semibold">{kindLabel(kind)}</span>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        placeholder={defaultText}
        aria-label={t("policy.descriptionAria", { kind: kindLabel(kind) })}
        maxLength={KIND_PROMPT_MAX_LENGTH}
        className="h-8 min-w-0 flex-1 rounded-sm border-none bg-transparent px-1.5 text-caption text-muted-foreground outline-none placeholder:text-muted-foreground/70 hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex w-[96px] flex-none flex-col">
        <Label htmlFor={`policy-${kind}`} className="sr-only">
          {t("policy.strategyAria", { kind: kindLabel(kind) })}
        </Label>
        <Select value={value} onValueChange={(next) => onValueChange(next as SegmentPolicy)}>
          <SelectTrigger id={`policy-${kind}`} size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {allowedPolicies(kind).map((option) => (
              <SelectItem key={option} value={option}>
                {policyText(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}

export function PolicyPage(): JSX.Element {
  const { policy, loadError, saveError, onDragEnd, onPolicyChange, onDescriptionChange } =
    usePolicyConfig();
  if (!policy) {
    return (
      <p className="text-caption text-muted-foreground">
        {loadError ? t("policy.loadErrorDetail", { message: loadError }) : t("policy.loading")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-muted-foreground">
        {t("policy.intro")}
      </p>
      <PolicyTable
        policy={policy}
        kindOrder={policy.kindOrder.length > 0 ? policy.kindOrder : [...SEGMENT_KINDS]}
        onDragEnd={onDragEnd}
        onPolicyChange={onPolicyChange}
        onDescriptionChange={onDescriptionChange}
      />
      {saveError && (
        <p role="alert" className="text-caption text-danger">
          {t("policy.saveError", { message: saveError })}
        </p>
      )}
      <section className="rounded-md border border-border bg-surface p-3">
        <p className="text-caption text-muted-foreground">
          <span className="font-medium text-foreground">{t("policy.conditionsTitle")}</span>
          {t("policy.conditions")}
        </p>
      </section>
    </div>
  );
}

function SortableRow(props: {
  kind: SegmentKind;
  value: SegmentPolicy;
  override?: string;
  onValueChange: (value: SegmentPolicy) => void;
  onDescriptionChange: (text: string) => void;
}): JSX.Element {
  const { kind, value, override, onValueChange, onDescriptionChange } = props;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: kind });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`flex h-[52px] items-center gap-3 rounded-md border bg-surface-raised px-3 ${
        isDragging ? "border-brand shadow-popover" : "border-border"
      }`}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t("policy.priorityAria", { kind: kindLabel(kind) })}
        aria-describedby={undefined}
        className="flex size-11 flex-none cursor-grab items-center justify-center rounded-sm text-muted-foreground hover:bg-surface-sunken active:cursor-grabbing"
      >
        <GripVertical aria-hidden className="size-4" />
      </button>
      <RowContent
        key={override ?? ""}
        kind={kind}
        value={value}
        override={override}
        onValueChange={onValueChange}
        onDescriptionChange={onDescriptionChange}
      />
    </div>
  );
}
