export type ThemePreset = {
  name: string;
  label: string;
  page: string;
  surface: string;
  surfaceSoft: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  accentSoft: string;
  accentText: string;
  primary: string;
  primaryHover: string;
  primaryText: string;
  inverse: string;
  inverseMuted: string;
  hero: string;
};

export const themes: ThemePreset[] = [
  {
    name: "Ember",
    label: "Warm",
    page: "#fffaf5",
    surface: "#ffffff",
    surfaceSoft: "#ffedd5",
    text: "#18181b",
    muted: "#57534e",
    border: "#fed7aa",
    accent: "#c2410c",
    accentSoft: "#fed7aa",
    accentText: "#7c2d12",
    primary: "#9a3412",
    primaryHover: "#7c2d12",
    primaryText: "#ffffff",
    inverse: "#1c1917",
    inverseMuted: "#fdba74",
    hero: "radial-gradient(circle at 18% 20%, rgba(249,115,22,0.16), transparent 30%), radial-gradient(circle at 90% 10%, rgba(244,63,94,0.12), transparent 28%), linear-gradient(135deg, #fffaf5 0%, #fff1e7 48%, #fff7ed 100%)",
  },
  {
    name: "Evergreen",
    label: "Default",
    page: "#fafaf9",
    surface: "#ffffff",
    surfaceSoft: "#ecfdf5",
    text: "#020617",
    muted: "#475569",
    border: "#cbd5e1",
    accent: "#0f766e",
    accentSoft: "#ccfbf1",
    accentText: "#134e4a",
    primary: "#020617",
    primaryHover: "#1e293b",
    primaryText: "#ffffff",
    inverse: "#020617",
    inverseMuted: "#94a3b8",
    hero: "radial-gradient(circle at 20% 18%, rgba(20,184,166,0.18), transparent 30%), radial-gradient(circle at 92% 8%, rgba(225,83,61,0.14), transparent 28%), linear-gradient(135deg, #f8faf5 0%, #eaf5f1 45%, #fbf0e9 100%)",
  },
  {
    name: "Signal",
    label: "Blue",
    page: "#f8fbff",
    surface: "#ffffff",
    surfaceSoft: "#e0f2fe",
    text: "#0f172a",
    muted: "#475569",
    border: "#bfdbfe",
    accent: "#2563eb",
    accentSoft: "#dbeafe",
    accentText: "#1e3a8a",
    primary: "#1d4ed8",
    primaryHover: "#1e40af",
    primaryText: "#ffffff",
    inverse: "#0b1220",
    inverseMuted: "#93c5fd",
    hero: "radial-gradient(circle at 20% 18%, rgba(37,99,235,0.16), transparent 30%), radial-gradient(circle at 88% 12%, rgba(14,165,233,0.16), transparent 28%), linear-gradient(135deg, #f8fbff 0%, #eaf4ff 48%, #f6f8ff 100%)",
  },
  {
    name: "Orchid",
    label: "Violet",
    page: "#fbf8ff",
    surface: "#ffffff",
    surfaceSoft: "#f3e8ff",
    text: "#181026",
    muted: "#5b5366",
    border: "#ddd6fe",
    accent: "#7c3aed",
    accentSoft: "#ede9fe",
    accentText: "#4c1d95",
    primary: "#6d28d9",
    primaryHover: "#5b21b6",
    primaryText: "#ffffff",
    inverse: "#171022",
    inverseMuted: "#c4b5fd",
    hero: "radial-gradient(circle at 20% 18%, rgba(124,58,237,0.16), transparent 30%), radial-gradient(circle at 92% 8%, rgba(236,72,153,0.12), transparent 28%), linear-gradient(135deg, #fbf8ff 0%, #f3ecff 46%, #fff7fb 100%)",
  },
  {
    name: "Graphite",
    label: "Neutral",
    page: "#f7f7f5",
    surface: "#ffffff",
    surfaceSoft: "#e7e5e4",
    text: "#111827",
    muted: "#52525b",
    border: "#d6d3d1",
    accent: "#3f3f46",
    accentSoft: "#e7e5e4",
    accentText: "#27272a",
    primary: "#18181b",
    primaryHover: "#3f3f46",
    primaryText: "#ffffff",
    inverse: "#18181b",
    inverseMuted: "#d4d4d8",
    hero: "radial-gradient(circle at 18% 18%, rgba(63,63,70,0.12), transparent 30%), radial-gradient(circle at 88% 10%, rgba(120,113,108,0.14), transparent 28%), linear-gradient(135deg, #f7f7f5 0%, #eeeeeb 48%, #fafafa 100%)",
  },
  {
    name: "Mint",
    label: "Green",
    page: "#f6fff8",
    surface: "#ffffff",
    surfaceSoft: "#dcfce7",
    text: "#052e16",
    muted: "#3f6212",
    border: "#bbf7d0",
    accent: "#15803d",
    accentSoft: "#dcfce7",
    accentText: "#14532d",
    primary: "#166534",
    primaryHover: "#14532d",
    primaryText: "#ffffff",
    inverse: "#052e16",
    inverseMuted: "#86efac",
    hero: "radial-gradient(circle at 20% 18%, rgba(34,197,94,0.16), transparent 30%), radial-gradient(circle at 90% 10%, rgba(20,184,166,0.14), transparent 28%), linear-gradient(135deg, #f6fff8 0%, #e9fcef 48%, #f4fff9 100%)",
  },
];

export const productPillars = [
  {
    title: "Bring your own models",
    description:
      "Run open models locally with Ollama, or self-host them in your own cloud, and put them to work as first-class agents.",
  },
  {
    title: "Mix in frontier models",
    description:
      "Route the same agents and workflows to frontier models when you want more capability — switch per agent or per task without rewiring.",
  },
  {
    title: "Operate with visibility",
    description:
      "Track health, credentials, sessions, traces, and runtime status without stitching together separate tools.",
  },
];

export const systemLayers = [
  {
    name: "Platform",
    detail:
      "Browser UI, API gateway, shared contracts, database coordination, generated Supabase types, and local developer scripts.",
  },
  {
    name: "Runtime",
    detail:
      "Elixir orchestrator, launcher, relay-facing behavior, worker bridge, smoke tools, and generated runtime schemas.",
  },
  {
    name: "Local helper",
    detail:
      "Installable daemon for outbound relay connections, local runner advertisement, and local workflow execution.",
  },
];

export const workflowSteps = [
  "Plan with agents that understand workspace context.",
  "Route tasks to your own models — local or self-hosted — or to frontier models.",
  "Watch execution health, messages, traces, and outputs.",
  "Review results and keep improving the agent system.",
];

export const stats = [
  ["Web", "React control plane"],
  ["API", "Database-backed coordination"],
  ["Runtime", "Launcher and orchestrator"],
  ["Helper", "Local runner bridge"],
];

export type ComparisonRow = {
  project: string;
  logoSrc: string;
  highlight?: boolean;
  role: string;
  runs: string;
  fit: string;
};

export const projectComparisons: ComparisonRow[] = [
  {
    project: "OpenMacaw",
    logoSrc: "/openmacaw-logo.png",
    highlight: true,
    role: "Multi-tenant control plane that orchestrates your own models — local or self-hosted — alongside frontier models across many agent runtimes for a whole team.",
    runs: "Cloud-hosted and always on, with outbound-only execution for models on your own machine or cloud.",
    fit: "Running your own models alongside frontier models, and coordinating workspaces, credentials, and routing at team scale.",
  },
  {
    project: "OpenClaw",
    logoSrc: "/openclaw-logo.png",
    role: "Self-hosted personal AI assistant with a single Gateway daemon that owns its own tool-calling loop.",
    runs: "Local Gateway on your own machine, wired to your chat apps.",
    fit: "A one-person assistant — and inside OpenMacaw, one pluggable runner kind.",
  },
  {
    project: "Hermes Agent",
    logoSrc: "/hermes-logo.png",
    role: "Self-improving personal agent with a built-in learning loop and autonomous skill creation.",
    runs: "Single-user runtime across local, Docker, SSH, or serverless backends.",
    fit: "Personal memory and skill growth; inspires OpenMacaw's optional workspace learning sidecar.",
  },
];
