import { stats } from "../content.js";
import type { ThemeProps } from "../section-props.js";

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
