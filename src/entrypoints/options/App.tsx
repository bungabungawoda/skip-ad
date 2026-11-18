import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX, RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BarChart3, Globe, Menu, Plug, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { readRuntimeSettings } from "../../core/ports/runtime-client";
import { errorText } from "../../core/lib/error";
import { logWarn } from "../../core/lib/log";
import {
  PANEL_DEFAULT_PX,
  PANEL_MAX_PX,
  PANEL_MIN_PX,
  useSettingsStore
} from "../../stores/settings";
import { Button } from "../../components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "../../components/ui/sheet";
import { Switch } from "../../components/ui/switch";
import { useUiMotion } from "../../core/ui/motion";
import { ConnectionPage } from "./ConnectionPage";
import { PolicyPage } from "./PolicyPage";
import { MetricsPage } from "./MetricsPage";
import { PrivacyPage } from "./PrivacyPage";
import { SitesPage } from "./SitesPage";
import { localeTag, t } from "../../core/i18n";

type OptionsPage = "connection" | "sites" | "policy" | "privacy" | "metrics";

const PAGES: Array<{ id: OptionsPage; label: string; icon: JSX.Element; title: string; subtitle: string }> = [
  {
    id: "connection",
    label: t("options.nav.connection"),
    icon: <Plug aria-hidden />,
    title: t("options.nav.connectionTitle"),
    subtitle: t("options.nav.connectionSubtitle")
  },
  {
    id: "sites",
    label: t("options.nav.sites"),
    icon: <Globe aria-hidden />,
    title: t("options.nav.sitesTitle"),
    subtitle: t("options.nav.sitesSubtitle")
  },
  {
    id: "policy",
    label: t("options.nav.policy"),
    icon: <SlidersHorizontal aria-hidden />,
    title: t("options.nav.policyTitle"),
    subtitle: t("options.nav.policySubtitle")
  },
  {
    id: "privacy",
    label: t("options.nav.privacy"),
    icon: <ShieldCheck aria-hidden />,
    title: t("options.nav.privacyTitle"),
    subtitle: t("options.nav.privacySubtitle")
  },
  {
    id: "metrics",
    label: t("options.nav.metrics"),
    icon: <BarChart3 aria-hidden />,
    title: t("options.nav.metricsTitle"),
    subtitle: t("options.nav.metricsSubtitle")
  }
];

function useNarrowWindow(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(max-width: 767px)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(max-width: 767px)").matches
  );
}

/** 测量分栏容器宽度，把像素约束换算成 react-resizable-panels 的百分比。 */
function useContainerWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setWidth(element.getBoundingClientRect().width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export default function App(): JSX.Element {
  const [page, setPage] = useState<OptionsPage>("connection");
  const panelWidth = useSettingsStore((state) => state.panelWidth);
  const setPanelWidth = useSettingsStore((state) => state.setPanelWidth);
  const theme = useSettingsStore((state) => state.theme);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const narrow = useNarrowWindow();
  const [groupRef, groupWidth] = useContainerWidth();
  const [hydrated, setHydrated] = useState(() => useSettingsStore.persist.hasHydrated());

  useEffect(
    () => useSettingsStore.persist.onFinishHydration(() => setHydrated(true)),
    []
  );

  const toPercent = (px: number): number =>
    groupWidth > 0 ? (px / groupWidth) * 100 : (PANEL_DEFAULT_PX / 1280) * 100;

  // 首次安装（还没有配置 Key）落在隐私与权限页，也就是 FirstRun 内容。
  useEffect(() => {
    void readRuntimeSettings()
      .then((settings) => {
        if (!settings.llmConfigured) setPage("privacy");
      })
      .catch((error: unknown) => {
        // 读失败就停留在当前页，但不能一点痕迹都没有。
        logWarn("读取运行时设置失败，停留在当前页", errorText(error));
      });
  }, []);

  const active = PAGES.find((item) => item.id === page) ?? PAGES[0]!;

  const nav = (
    <NavList page={page} onNavigate={setPage} />
  );

  const pageContent = <PageSwitch page={page} onConfigure={() => setPage("connection")} />;

  return (
    <div className="flex h-screen min-h-[560px] flex-col bg-background">
      <header
        className={`flex h-[72px] flex-none items-center gap-3.5 border-b border-border ${
          narrow ? "px-4" : "px-8"
        }`}
      >
        {narrow && (
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon-sm" aria-label={t("options.openNav")}>
                <Menu aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[240px] gap-2 p-3">
              <span className="px-3 pt-1 text-overline text-muted-foreground">
                {t("common.settings")}
              </span>
              {nav}
            </SheetContent>
          </Sheet>
        )}
        <div className="flex size-8 flex-none items-center justify-center rounded-md bg-brand text-white">
          <Plug aria-hidden className="size-4" />
        </div>
        <div className="flex min-w-0 grow flex-col gap-0.5">
          <span className="truncate text-title font-semibold">{active.title}</span>
          <span className="truncate text-caption text-muted-foreground">{active.subtitle}</span>
        </div>
        <div className="flex flex-none items-center gap-2">
          {!narrow && (
            <span className="text-caption text-muted-foreground">
              {t("options.followTheme")}
            </span>
          )}
          <Switch
            checked={theme === "system"}
            onCheckedChange={(checked) => {
              if (checked) {
                setTheme("system");
              } else {
                setTheme(
                  window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
                );
              }
            }}
            aria-label={t("options.followTheme")}
          />
        </div>
      </header>

      {narrow ? (
        <main className="min-h-0 grow overflow-y-auto">
          <div className="mx-auto max-w-[720px] px-6 py-6">{pageContent}</div>
        </main>
      ) : (
        <div ref={groupRef} className="flex min-h-0 grow">
        {groupWidth > 0 && hydrated ? (
        <PanelGroup direction="horizontal" className="h-full w-full">
          <Panel
            defaultSize={toPercent(panelWidth)}
            minSize={toPercent(PANEL_MIN_PX)}
            maxSize={toPercent(PANEL_MAX_PX)}
            id="options-nav"
            onResize={(size) => {
              if (groupWidth > 0) setPanelWidth((size / 100) * groupWidth);
            }}
            className="bg-surface"
          >
            <div className="flex h-full flex-col gap-1 overflow-y-auto p-3">
              <span className="px-3 pb-2 text-overline text-muted-foreground">
                {t("common.settings")}
              </span>
              {nav}
              <div className="mt-auto flex flex-col gap-1.5 rounded-md border border-border bg-surface-raised p-3">
                <span className="text-caption font-semibold">{t("options.keyLocal.title")}</span>
                <span className="text-overline text-muted-foreground">
                  {t("options.keyLocal.body")}
                </span>
              </div>
            </div>
          </Panel>
          <PanelResizeHandle
            aria-label={t("options.resizeNav")}
            className="w-1.5 bg-surface-sunken transition-colors hover:bg-border-strong data-[resize-handle-state=drag]:bg-brand"
          />
          <Panel className="min-w-0">
            <main className="h-full overflow-y-auto px-8 py-6">
              <div className="mx-auto flex max-w-[880px] flex-col gap-4">{pageContent}</div>
            </main>
          </Panel>
        </PanelGroup>
        ) : null}
        </div>
      )}
    </div>
  );
}

function PageSwitch(props: { page: OptionsPage; onConfigure: () => void }): JSX.Element {
  const { page, onConfigure } = props;
  const motionVariants = useUiMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={page}
        variants={motionVariants.panel}
        initial="initial"
        animate="animate"
        exit="exit"
        className="flex flex-col gap-4"
      >
        {page === "connection" && <ConnectionPage />}
        {page === "sites" && <SitesPage />}
        {page === "policy" && <PolicyPage />}
        {page === "privacy" && <PrivacyPage onConfigure={onConfigure} />}
        {page === "metrics" && <MetricsPage />}
      </motion.div>
    </AnimatePresence>
  );
}

function NavList(props: { page: OptionsPage; onNavigate: (page: OptionsPage) => void }): JSX.Element {
  const { page, onNavigate } = props;
  return (
    <nav className="flex flex-col gap-1" aria-label={t("options.navGroup")} lang={localeTag()}>
      {PAGES.map((item) => {
        const active = item.id === page;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => onNavigate(item.id)}
            className={`flex h-10 items-center gap-2.5 rounded-sm px-3 text-left text-label ${
              active
                ? "bg-surface-sunken font-semibold text-foreground"
                : "text-muted-foreground hover:bg-surface-sunken hover:text-foreground"
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
