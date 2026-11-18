import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { sendRuntime } from "../../core/ports/runtime-client";
import { isSettingsChangedMessage } from "../../core/ui/messages";
import { chromeStorageArea } from "../../core/ports/chrome-storage";
import { loadSitePlugins } from "../../core/plugin/registry";
import {
  DEFAULT_SITE_SWITCHES,
  readSiteSwitches,
  siteSwitchesFor,
  type SiteSwitchConfig,
  type SiteSwitches
} from "../../core/ports/site-switches";
import { Switch } from "../../components/ui/switch";
import { Button } from "../../components/ui/button";
import { siteName } from "./site-labels";
import { usePersistedSave } from "./use-persisted-setting";
import { errorText } from "../../core/lib/error";
import { logWarn } from "../../core/lib/log";
import { t } from "../../core/i18n";

/** 站点清单来自各站 site.json；展示名与统计页共用 siteName，这里只补适用范围。 */

const SITE_NOTES: Record<string, string> = {
  bilibili: t("sites.note.bilibili"),
  youtube: t("sites.note.youtube")
};

const TOGGLE_META: Record<
  keyof SiteSwitches,
  { label: string; hint: string; needsCapability?: "platform_ad" }
> = {
  enabled: {
    label: t("sites.toggle.enabled"),
    hint: t("sites.toggle.enabledHint")
  },
  platformAdSkip: {
    label: t("sites.toggle.platformAd"),
    hint: t("sites.toggle.platformAdHint"),
    needsCapability: "platform_ad"
  },
  segmentAnalysis: {
    label: t("sites.toggle.segmentAnalysis"),
    hint: t("sites.toggle.segmentAnalysisHint")
  }
};

const TOGGLE_ORDER: Array<keyof SiteSwitches> = [
  "enabled",
  "platformAdSkip",
  "segmentAnalysis"
];

export function SitesPage(): JSX.Element {
  const [config, setConfig] = useState<SiteSwitchConfig>({});
  /** 写操作用的乐观配置：同一帧内连点两个开关时，state 还没重渲染，不能拿闭包里的旧值。 */
  const configRef = useRef<SiteSwitchConfig>({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const sendSave = useCallback(
    (patch: unknown) =>
      sendRuntime<SiteSwitchConfig>({
        type: "settings.setSiteSwitches",
        patch: patch as Record<string, Partial<SiteSwitches>>
      }),
    []
  );
  const applySaved = useCallback((next: SiteSwitchConfig) => {
    configRef.current = next;
    setConfig(next);
  }, []);
  const rollback = useCallback((lastSaved: SiteSwitchConfig | null) => {
    configRef.current = lastSaved ?? configRef.current;
    setConfig(lastSaved ?? configRef.current);
  }, []);
  const { save, saveError, lastSavedRef } = usePersistedSave<SiteSwitchConfig>(
    sendSave,
    applySaved,
    rollback,
    t("sites.saveScope"),
    {}
  );
  const sites = loadSitePlugins();

  useEffect(() => {
    const reload = (): void => {
      void readSiteSwitches(chromeStorageArea())
        .then((stored) => {
          configRef.current = stored;
          lastSavedRef.current = stored;
          setConfig(stored);
          setLoaded(true);
          setLoadError(null);
        })
        .catch((error: unknown) => {
          logWarn("读取站点开关失败", errorText(error));
          setLoadError(errorText(error, t("sites.loadError")));
          setLoaded(false);
        });
    };
    const listener = (message: unknown): void => {
      if (isSettingsChangedMessage(message)) reload();
    };
    reload();
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [lastSavedRef]);

  const update = useCallback(
    async (siteId: string, patch: Partial<SiteSwitches>) => {
      const saved = lastSavedRef.current;
      if (!saved) return;
      const current = siteSwitchesFor(saved, siteId);
      const nextPatch = { ...patch };
      if (patch.enabled === false || (patch.enabled !== true && current.enabled === false)) {
        nextPatch.enabled = false;
        nextPatch.platformAdSkip = false;
        nextPatch.segmentAnalysis = false;
      }
      const patchConfig = { [siteId]: nextPatch };
      const merged = {
        ...configRef.current,
        [siteId]: { ...current, ...(nextPatch as Partial<SiteSwitches>) }
      };
      // 先写 ref 再发请求：下一次点击立刻能读到这次改动。
      configRef.current = merged;
      await save(patchConfig, merged);
    },
    [lastSavedRef, save]
  );

  return (
    <div className="flex flex-col gap-4">
      {loadError && (
        <div className="flex flex-col gap-2 rounded-md border border-danger/40 bg-danger-soft p-3">
          <p className="text-caption text-danger">
            {t("sites.loadErrorDetail", { message: loadError })}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => window.location.reload()}
          >
            {t("sites.reload")}
          </Button>
        </div>
      )}
      <p className="text-label text-muted-foreground">
        {t("sites.intro")}
      </p>
      {sites.map((plugin) => {
        const { id } = plugin;
        const name = siteName(id);
        const note = SITE_NOTES[id] ?? "";
        const switches = siteSwitchesFor(loaded ? config : {}, id);
        const capabilities = plugin.manifest.capabilities;
        const toggles = TOGGLE_ORDER.filter((key) => {
          const capability = TOGGLE_META[key].needsCapability;
          return !capability || capabilities.includes(capability);
        });
        return (
          <section
            key={id}
            className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-body font-semibold">{name}</span>
              <span className="text-overline text-muted-foreground">{note}</span>
            </div>
            {toggles.map((key) => {
              const toggle = TOGGLE_META[key];
              return (
                <div key={key} className="flex items-center gap-3">
                  <div className="flex min-w-0 grow flex-col gap-0.5">
                    <span className="text-caption font-medium">{toggle.label}</span>
                    <span className="text-overline text-muted-foreground">{toggle.hint}</span>
                  </div>
                  <Switch
                    checked={switches[key]}
                    onCheckedChange={(value) => void update(id, { [key]: value })}
                    disabled={!loaded || loadError !== null}
                    aria-label={`${name} ${toggle.label}`}
                  />
                </div>
              );
            })}
          </section>
        );
      })}
      {saveError && (
        <p className="text-caption text-danger">
          {t("sites.saveErrorDetail", { message: saveError })}
        </p>
      )}
      <p className="text-overline text-muted-foreground">
        {t("sites.defaultState", {
          state: DEFAULT_SITE_SWITCHES.enabled ? t("sites.on") : t("sites.off")
        })}
      </p>
    </div>
  );
}
