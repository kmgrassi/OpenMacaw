import { themes } from "../content.js";
import { ArrowIcon } from "../icons.js";
import type { FooterSectionProps } from "../section-props.js";

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
