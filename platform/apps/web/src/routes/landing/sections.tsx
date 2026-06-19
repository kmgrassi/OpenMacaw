import type { CSSProperties } from "react";

import {
  productPillars,
  projectComparisons,
  stats,
  systemLayers,
  themes,
  workflowSteps,
  type ThemePreset,
} from "./content.js";
import { ArrowIcon, CheckIcon } from "./icons.js";

type ThemeProps = {
  theme: ThemePreset;
};

type LandingButtonProps = {
  appUrl: string;
  primaryButtonStyle: CSSProperties;
  outlineButtonStyle: CSSProperties;
};

type HeroSectionProps = ThemeProps &
  LandingButtonProps & {
    elevatedSurfaceStyle: CSSProperties;
  };

type FooterSectionProps = ThemeProps &
  LandingButtonProps & {
    themeIndex: number;
    onSelectTheme: (index: number) => void;
  };

export function HeroSection({
  appUrl,
  theme,
  primaryButtonStyle,
  outlineButtonStyle,
  elevatedSurfaceStyle,
}: HeroSectionProps) {
  return (
    <section
      className="relative overflow-hidden border-b"
      style={{ borderColor: theme.border }}
    >
      <div
        className="absolute inset-0"
        style={{
          background: `${theme.hero}, radial-gradient(circle at 74% 48%, rgba(194,65,12,0.18), transparent 34%)`,
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.28]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(120, 53, 15, 0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(120, 53, 15, 0.08) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage:
            "linear-gradient(to bottom, transparent 0%, black 16%, black 72%, transparent 100%)",
        }}
      />
      <div className="relative mx-auto flex min-h-[86vh] max-w-7xl flex-col px-5 py-5 sm:px-8 lg:px-10">
        <header
          className="flex items-center justify-between gap-4 rounded-2xl border px-3 py-3 backdrop-blur-md sm:px-4"
          style={elevatedSurfaceStyle}
        >
          <a className="flex items-center gap-3" href="/">
            <span
              className="flex h-11 w-11 items-center justify-center rounded-xl"
              style={{ backgroundColor: theme.surfaceSoft }}
            >
              <img
                src="/openmacaw-logo.png"
                alt=""
                className="h-9 w-9 object-contain"
                aria-hidden="true"
              />
            </span>
            <span className="text-base font-semibold tracking-tight">
              OpenMacaw
            </span>
          </a>
          <nav className="flex items-center gap-2">
            <a
              href="https://github.com/kmgrassi/OpenMacaw"
              className="hidden rounded-xl px-3 py-2 text-sm font-medium transition hover:bg-black/[0.04] hover:opacity-90 sm:inline-flex"
              style={{ color: theme.muted }}
            >
              GitHub
            </a>
            <a
              href={appUrl}
              className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition hover:brightness-95"
              style={{
                ...primaryButtonStyle,
                boxShadow: "0 12px 28px rgba(154, 52, 18, 0.22)",
              }}
            >
              Open app
              <ArrowIcon />
            </a>
          </nav>
        </header>

        <div className="grid flex-1 items-center gap-12 py-8 lg:grid-cols-[minmax(0,0.88fr)_minmax(430px,1.12fr)] lg:py-8">
          <div className="max-w-3xl lg:pb-8">
            <p
              className="mb-6 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold uppercase tracking-[0.16em]"
              style={{
                backgroundColor: "rgba(255,255,255,0.62)",
                color: theme.accent,
                boxShadow:
                  "0 1px 0 rgba(255,255,255,0.85) inset, 0 10px 30px rgba(120,53,15,0.08)",
              }}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: theme.accent }}
              />
              Open-source model orchestration
            </p>
            <h1 className="max-w-4xl text-5xl font-semibold leading-[0.98] tracking-tight sm:text-6xl lg:text-7xl">
              Orchestrate your own models alongside frontier models.
            </h1>
            <p
              className="mt-6 max-w-2xl text-lg font-normal leading-8 sm:text-xl sm:leading-9"
              style={{ color: theme.muted }}
            >
              OpenMacaw is for teams that want to run their own models — on your
              own computer, or self-hosted in your own cloud — and put them to
              work as agents alongside frontier models, all from one place where
              you can see exactly what they're doing.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href={appUrl}
                className="inline-flex items-center gap-2 rounded-xl px-5 py-3.5 text-sm font-semibold transition hover:brightness-95"
                style={{
                  ...primaryButtonStyle,
                  boxShadow:
                    "0 18px 36px rgba(154, 52, 18, 0.26), 0 1px 0 rgba(255,255,255,0.22) inset",
                }}
              >
                Launch dashboard
                <ArrowIcon />
              </a>
              <a
                href="https://github.com/kmgrassi/OpenMacaw"
                className="rounded-xl border px-5 py-3.5 text-sm font-semibold transition hover:bg-white hover:opacity-90"
                style={{
                  ...outlineButtonStyle,
                  boxShadow: "0 10px 26px rgba(120, 53, 15, 0.07)",
                }}
              >
                View source
              </a>
            </div>
            <div className="mt-8 grid max-w-2xl gap-3 sm:grid-cols-2">
              {workflowSteps.map((item) => (
                <div
                  key={item}
                  className="flex items-start gap-3 rounded-xl border px-3.5 py-3 text-sm leading-6"
                  style={{
                    backgroundColor: "rgba(255,255,255,0.50)",
                    borderColor: "rgba(254, 215, 170, 0.72)",
                    color: theme.muted,
                  }}
                >
                  <span
                    className="flex h-6 w-6 flex-none items-center justify-center rounded-lg"
                    style={{
                      backgroundColor: theme.accentSoft,
                      color: theme.accent,
                    }}
                  >
                    <CheckIcon color="currentColor" />
                  </span>
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="relative min-h-[440px] lg:min-h-[540px]">
            <div
              className="absolute inset-x-8 top-14 h-72 rounded-full blur-3xl lg:inset-x-0"
              style={{ backgroundColor: "rgba(194, 65, 12, 0.20)" }}
            />
            <div className="absolute inset-x-0 top-0 mx-auto max-w-[720px] rounded-[28px] border border-white/10 bg-[#07111f] p-3 shadow-[0_34px_100px_rgba(28,25,23,0.32),0_2px_0_rgba(255,255,255,0.08)_inset]">
              <div className="rounded-[22px] border border-white/10 bg-gradient-to-b from-white/[0.08] to-white/[0.02]">
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
                    <span className="h-2.5 w-2.5 rounded-full bg-teal-300" />
                  </div>
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-slate-300">
                    app.openmacaw.ai
                  </span>
                </div>
                <div className="grid gap-4 p-4 md:grid-cols-[200px_1fr]">
                  <aside className="rounded-2xl border border-white/10 bg-white/[0.045] p-4 shadow-[0_1px_0_rgba(255,255,255,0.08)_inset]">
                    <div className="mb-5 h-2.5 w-24 rounded-full bg-white/25" />
                    {[
                      "Agent dashboard",
                      "Runtime health",
                      "Local runners",
                      "Credentials",
                    ].map((route) => (
                      <div
                        key={route}
                        className="mb-2 rounded-xl border border-white/10 bg-white/[0.045] px-3 py-2.5 text-[13px] text-slate-300"
                      >
                        {route}
                      </div>
                    ))}
                  </aside>
                  <div className="rounded-2xl border border-white/10 bg-[#0b1626] p-5 shadow-[0_1px_0_rgba(255,255,255,0.08)_inset]">
                    <div className="mb-6 flex items-start justify-between gap-3">
                      <div>
                        <div className="text-base font-semibold text-white">
                          Runtime dashboard
                        </div>
                        <div className="mt-2 text-sm text-slate-400">
                          Your own models, frontier models, custom targets
                        </div>
                      </div>
                      <div
                        className="rounded-full px-3 py-1.5 text-xs font-semibold"
                        style={{
                          backgroundColor: theme.accentSoft,
                          color: theme.accentText,
                        }}
                      >
                        Healthy
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      {[
                        ["Route", "Your own model or a frontier model."],
                        ["Run", "Live status, traces, and chat."],
                        ["Review", "Outputs, credentials, and history."],
                      ].map(([label, value]) => (
                        <div
                          key={label}
                          className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.075] to-white/[0.035] p-4"
                        >
                          <div className="text-sm font-semibold text-white">
                            {label}
                          </div>
                          <p className="mt-2 text-[13px] leading-5 text-slate-400">
                            {value}
                          </p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 rounded-2xl border border-white/10 bg-[#07111f] p-4 shadow-[0_1px_0_rgba(255,255,255,0.07)_inset]">
                      <div className="mb-4 flex items-center justify-between text-xs font-medium text-slate-400">
                        <span>Runtime activity</span>
                        <span className="rounded-full bg-white/[0.06] px-2 py-1 text-slate-300">
                          Live
                        </span>
                      </div>
                      <div className="space-y-3">
                        <div
                          className="h-2.5 rounded-full"
                          style={{
                            background:
                              "linear-gradient(90deg, #fb923c 0%, #c2410c 100%)",
                          }}
                        />
                        <div className="h-2.5 w-4/5 rounded-full bg-orange-300/60" />
                        <div className="h-2.5 w-3/5 rounded-full bg-amber-200/60" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function StatsSection({ theme }: ThemeProps) {
  return (
    <section
      className="border-b"
      style={{
        background:
          "linear-gradient(180deg, rgba(255,250,245,0.35) 0%, rgba(255,255,255,0.86) 100%)",
        borderColor: theme.border,
      }}
    >
      <div className="mx-auto grid max-w-7xl gap-4 px-5 py-10 sm:grid-cols-2 sm:px-8 lg:grid-cols-4 lg:px-10">
        {stats.map(([label, value]) => (
          <div
            key={label}
            className="rounded-2xl border p-5 transition hover:-translate-y-0.5"
            style={{
              backgroundColor: "rgba(255,255,255,0.72)",
              borderColor: theme.border,
              boxShadow:
                "0 18px 44px rgba(120, 53, 15, 0.07), 0 1px 0 rgba(255,255,255,0.86) inset",
            }}
          >
            <div
              className="text-sm font-semibold uppercase tracking-[0.12em]"
              style={{ color: theme.accent }}
            >
              {label}
            </div>
            <div
              className="mt-2 text-sm leading-6"
              style={{ color: theme.muted }}
            >
              {value}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ProductPillarsSection({ theme }: ThemeProps) {
  return (
    <section style={{ backgroundColor: theme.page }}>
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 lg:px-10">
        <div className="max-w-3xl">
          <p
            className="text-sm font-semibold uppercase tracking-[0.14em]"
            style={{ color: theme.accent }}
          >
            Built for bring-your-own-model teams
          </p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
            Run your own models, and reach for the frontier when you want.
          </h2>
        </div>

        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          {productPillars.map((pillar) => (
            <article
              key={pillar.title}
              className="rounded-md border p-6 shadow-sm"
              style={{
                backgroundColor: theme.surface,
                borderColor: theme.border,
              }}
            >
              <h3 className="text-lg font-semibold">{pillar.title}</h3>
              <p
                className="mt-4 text-sm leading-7"
                style={{ color: theme.muted }}
              >
                {pillar.description}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function SystemArchitectureSection({ theme }: ThemeProps) {
  return (
    <section
      className="border-y text-white"
      style={{ backgroundColor: theme.inverse, borderColor: theme.border }}
    >
      <div className="mx-auto grid max-w-7xl gap-10 px-5 py-20 sm:px-8 lg:grid-cols-[0.72fr_1fr] lg:px-10">
        <div>
          <p
            className="text-sm font-semibold uppercase tracking-[0.14em]"
            style={{ color: theme.inverseMuted }}
          >
            System architecture
          </p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
            A single source tree for the platform, orchestrator, and local
            helper.
          </h2>
          <p
            className="mt-5 text-sm leading-7"
            style={{ color: theme.inverseMuted }}
          >
            OpenMacaw is designed so the browser UI, API coordination layer,
            runtime orchestration, and local machine bridge can be developed
            together while still preserving clear subsystem boundaries.
          </p>
        </div>

        <div className="grid gap-3">
          {systemLayers.map((layer) => (
            <article
              key={layer.name}
              className="rounded-md border border-white/10 bg-white/[0.04] p-5"
            >
              <h3 className="text-lg font-semibold">{layer.name}</h3>
              <p
                className="mt-3 text-sm leading-7"
                style={{ color: theme.inverseMuted }}
              >
                {layer.detail}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function LocalFirstSection({ theme }: ThemeProps) {
  return (
    <section style={{ backgroundColor: theme.surface }}>
      <div className="mx-auto grid max-w-7xl gap-8 px-5 py-20 sm:px-8 lg:grid-cols-[0.82fr_1fr] lg:px-10">
        <div>
          <p
            className="text-sm font-semibold uppercase tracking-[0.14em]"
            style={{ color: theme.accent }}
          >
            Your models, your infrastructure
          </p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
            Connect your own models without opening inbound access to your
            machine.
          </h2>
        </div>
        <div className="text-sm leading-7" style={{ color: theme.muted }}>
          <p>
            The local runtime helper runs as a daemon on your own machine (or in
            your own cloud), opens an outbound relay connection, advertises your
            configured local models and runners, and can execute supported
            workflows without requiring inbound network access.
          </p>
          <p className="mt-5">
            Full end-to-end behavior can include the platform, runtime, helper,
            provider credentials, and a configured database path. The project is
            pre-release, and the public self-hosting path is being made more
            explicit as the repository hardens.
          </p>
        </div>
      </div>
    </section>
  );
}

export function ComparisonSection({ theme }: ThemeProps) {
  return (
    <section
      className="border-y"
      style={{ backgroundColor: theme.page, borderColor: theme.border }}
    >
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 lg:px-10">
        <div className="max-w-3xl">
          <p
            className="text-sm font-semibold uppercase tracking-[0.14em]"
            style={{ color: theme.accent }}
          >
            Project comparison
          </p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
            How OpenMacaw relates to OpenClaw and Hermes.
          </h2>
          <p className="mt-4 text-sm leading-7" style={{ color: theme.muted }}>
            OpenClaw and Hermes are self-hosted personal assistants for one
            user. OpenMacaw is the multi-tenant platform that runs many agent
            runtimes for a team — including OpenClaw as a pluggable runner.
          </p>
        </div>

        <div
          className="mt-10 overflow-hidden rounded-md border"
          style={{
            backgroundColor: theme.surface,
            borderColor: theme.border,
          }}
        >
          <div
            className="hidden grid-cols-[0.9fr_1.35fr_1fr_1.25fr] border-b px-5 py-3 text-xs font-semibold uppercase tracking-[0.12em] lg:grid"
            style={{ borderColor: theme.border, color: theme.muted }}
          >
            <div>Project</div>
            <div>Primary job</div>
            <div>Where it runs</div>
            <div>Best fit</div>
          </div>
          {projectComparisons.map((item) => (
            <article
              key={item.project}
              className="grid gap-4 border-b px-5 py-5 last:border-b-0 lg:grid-cols-[0.9fr_1.35fr_1fr_1.25fr]"
              style={{
                borderColor: theme.border,
                backgroundColor: item.highlight ? theme.accentSoft : undefined,
              }}
            >
              <div>
                <div
                  className="text-xs font-semibold uppercase tracking-[0.12em] lg:hidden"
                  style={{ color: theme.muted }}
                >
                  Project
                </div>
                <div className="mt-1 flex items-center gap-3 lg:mt-0">
                  <span
                    className="flex h-9 w-9 flex-none items-center justify-center overflow-hidden rounded-xl border"
                    style={{
                      backgroundColor: theme.surface,
                      borderColor: theme.border,
                    }}
                  >
                    <img
                      src={item.logoSrc}
                      alt={`${item.project} logo`}
                      className="h-7 w-7 rounded-md object-contain"
                      loading="lazy"
                    />
                  </span>
                  <h3 className="text-base font-semibold">{item.project}</h3>
                </div>
              </div>
              <div>
                <div
                  className="text-xs font-semibold uppercase tracking-[0.12em] lg:hidden"
                  style={{ color: theme.muted }}
                >
                  Primary job
                </div>
                <p
                  className="mt-1 text-sm leading-6 lg:mt-0"
                  style={{ color: theme.muted }}
                >
                  {item.role}
                </p>
              </div>
              <div>
                <div
                  className="text-xs font-semibold uppercase tracking-[0.12em] lg:hidden"
                  style={{ color: theme.muted }}
                >
                  Where it runs
                </div>
                <p
                  className="mt-1 text-sm leading-6 lg:mt-0"
                  style={{ color: theme.muted }}
                >
                  {item.runs}
                </p>
              </div>
              <div>
                <div
                  className="text-xs font-semibold uppercase tracking-[0.12em] lg:hidden"
                  style={{ color: theme.muted }}
                >
                  Best fit
                </div>
                <p
                  className="mt-1 text-sm leading-6 lg:mt-0"
                  style={{ color: theme.muted }}
                >
                  {item.fit}
                </p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FooterSection({
  appUrl,
  theme,
  themeIndex,
  onSelectTheme,
  primaryButtonStyle,
  outlineButtonStyle,
}: FooterSectionProps) {
  return (
    <section
      className="border-t"
      style={{
        backgroundColor: theme.surfaceSoft,
        borderColor: theme.border,
      }}
    >
      <div className="mx-auto grid max-w-7xl gap-8 px-5 py-14 sm:px-8 lg:grid-cols-[1fr_410px] lg:items-start lg:px-10">
        <div>
          <h2 className="text-2xl font-semibold">
            Start with the dashboard or inspect the source.
          </h2>
          <p className="mt-2 text-sm" style={{ color: theme.muted }}>
            OpenMacaw is moving toward a polished open-source launch while
            remaining usable for active local development.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href={appUrl}
              className="inline-flex items-center gap-2 rounded-md px-5 py-3 text-sm font-semibold transition hover:opacity-90"
              style={primaryButtonStyle}
            >
              Open app
              <ArrowIcon />
            </a>
            <a
              href="https://github.com/kmgrassi/OpenMacaw"
              className="rounded-md border px-5 py-3 text-sm font-semibold transition hover:opacity-80"
              style={outlineButtonStyle}
            >
              GitHub repository
            </a>
          </div>
        </div>

        <div
          className="rounded-md border p-4"
          style={{
            backgroundColor: theme.surface,
            borderColor: theme.border,
          }}
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold">Theme settings</h3>
              <p className="mt-1 text-xs" style={{ color: theme.muted }}>
                Preview launch palettes before choosing the production look.
              </p>
            </div>
            <span
              className="rounded-md px-2 py-1 text-xs font-semibold"
              style={{
                backgroundColor: theme.accentSoft,
                color: theme.accentText,
              }}
            >
              {theme.name}
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {themes.map((preset, index) => {
              const selected = index === themeIndex;

              return (
                <button
                  key={preset.name}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelectTheme(index)}
                  className="flex min-h-12 items-center gap-2 rounded-md border px-3 py-2 text-left text-sm font-medium transition hover:opacity-80"
                  style={{
                    backgroundColor: selected
                      ? preset.accentSoft
                      : theme.surface,
                    borderColor: selected ? preset.accent : theme.border,
                    color: selected ? preset.accentText : theme.text,
                  }}
                >
                  <span
                    className="h-4 w-4 flex-none rounded-full border"
                    style={{
                      background: `linear-gradient(135deg, ${preset.accent} 0%, ${preset.primary} 55%, ${preset.surfaceSoft} 100%)`,
                      borderColor: selected ? preset.accent : theme.border,
                    }}
                  />
                  <span>{preset.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
