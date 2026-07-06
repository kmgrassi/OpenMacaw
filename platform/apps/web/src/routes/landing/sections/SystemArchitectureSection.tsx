import { systemLayers } from "../content.js";
import type { ThemeProps } from "../section-props.js";

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
            runtime relay.
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
