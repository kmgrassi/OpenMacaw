import type { ThemeProps } from "../section-props.js";

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
            The local runtime relay runs as a daemon on your own machine (or in
            your own cloud), opens an outbound relay connection, advertises your
            configured local models and runners, and can execute supported
            workflows without requiring inbound network access.
          </p>
          <p className="mt-5">
            Full end-to-end behavior can include the platform, runtime, relay,
            provider credentials, and a configured database path. The project is
            pre-release, and the public self-hosting path is being made more
            explicit as the repository hardens.
          </p>
        </div>
      </div>
    </section>
  );
}
