import type { JSX } from "react";
import { CircleAlert, KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Separator } from "../../components/ui/separator";
import { t } from "../../core/i18n";

const PRIVACY_POLICY_URL =
  "https://github.com/bungabungawoda/skip-ad/blob/main/PRIVACY.md";

const COMMON_STEPS: Array<{
  no: string;
  icon: JSX.Element;
  title: string;
  body: string;
  note: string;
}> = [
  {
    no: "01",
    icon: <ShieldCheck aria-hidden className="size-4.5 text-success" />,
    title: t("privacy.step1.title"),
    body: t("privacy.step1.body"),
    note: t("privacy.step1.note")
  },
  {
    no: "02",
    icon: <KeyRound aria-hidden className="size-4.5 text-brand-ink" />,
    title: t("privacy.step2.title"),
    body: t("privacy.step2.body"),
    note: t("privacy.step2.note")
  }
];

const SITE_SECTIONS: Array<{
  site: string;
  scope: string;
  body: string;
  note: string;
}> = [
  {
    site: t("site.bilibili"),
    scope: t("privacy.bilibiliScope"),
    body: t("privacy.bilibiliBody"),
    note: t("privacy.bilibiliNote")
  },
  {
    site: t("site.youtube"),
    scope: t("privacy.youtubeScope"),
    body: t("privacy.youtubeBody"),
    note: t("privacy.youtubeNote")
  }
];

const DECISION_NOTE = t("privacy.decisionNote");

export function PrivacyPage(props: { onConfigure: () => void }): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-label text-muted-foreground">
        {t("privacy.intro")}
      </p>

      {COMMON_STEPS.map((step) => (
        <section
          key={step.no}
          className="flex items-start gap-3.5 rounded-md border border-border bg-surface p-4"
        >
          <span className="w-[26px] flex-none pt-0.5 font-mono text-caption text-brand-ink">
            {step.no}
          </span>
          <span className="mt-0.5 flex-none">{step.icon}</span>
          <div className="flex grow flex-col gap-1">
            <span className="text-body font-semibold">{step.title}</span>
            <span className="text-caption text-muted-foreground">{step.body}</span>
            <span className="text-overline text-muted-foreground">{step.note}</span>
          </div>
        </section>
      ))}

      <section className="flex flex-col gap-2.5 rounded-md border border-border bg-surface p-4">
        <div className="flex items-center gap-2">
          <CircleAlert aria-hidden className="size-4 text-warning" />
          <span className="text-body font-semibold">{t("privacy.sitesTitle")}</span>
        </div>
        <Separator />
        {SITE_SECTIONS.map((section) => (
          <div key={section.site} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <span className="text-caption font-semibold">{section.site}</span>
              <span className="text-overline text-muted-foreground">{section.scope}</span>
            </div>
            <span className="text-caption text-muted-foreground">{section.body}</span>
            <span className="text-overline text-muted-foreground">{section.note}</span>
          </div>
        ))}
        <Separator />
        <span className="text-caption text-muted-foreground">{DECISION_NOTE}</span>
      </section>

      <section className="flex flex-col gap-2.5 rounded-md border border-border bg-surface p-4">
        <div className="flex items-center gap-2">
          <span className="text-overline text-muted-foreground">{t("privacy.permissions")}</span>
        </div>
        <div className="grid grid-cols-2 gap-x-5 gap-y-2">
          <span className="text-overline text-muted-foreground">{t("privacy.permission.local")}</span>
          <span className="text-overline text-muted-foreground">{t("privacy.permission.sites")}</span>
          <span className="text-overline text-muted-foreground">{t("privacy.permission.custom")}</span>
          <span className="text-overline text-muted-foreground">{t("privacy.permission.scope")}</span>
        </div>
        <Separator />
        <span className="text-overline text-muted-foreground">
          {t("privacy.cookieNote")}
        </span>
      </section>

      <a
        href={PRIVACY_POLICY_URL}
        target="_blank"
        rel="noreferrer"
        className="w-fit text-overline text-brand-ink underline underline-offset-2"
      >
        {t("privacy.fullPolicy")}
      </a>

      <div className="flex items-center gap-3">
        <Button onClick={props.onConfigure}>{t("privacy.configure")}</Button>
        <span className="ml-auto text-overline text-muted-foreground">
          {t("privacy.firstRun")}
        </span>
      </div>
    </div>
  );
}
