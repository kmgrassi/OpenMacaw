import { projectComparisons } from "../content.js";
import type { ThemeProps } from "../section-props.js";

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
