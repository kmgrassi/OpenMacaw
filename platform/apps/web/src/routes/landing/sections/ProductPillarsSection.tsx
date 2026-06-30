import { productPillars } from "../content.js";
import type { ThemeProps } from "../section-props.js";

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
