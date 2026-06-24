type SettingsSection = {
  path: `/settings/${string}`;
  label: string;
  autoConnectGateway?: boolean;
};

type SettingsGroup = {
  label: "Setup" | "Runtime" | "Account";
  sections: SettingsSection[];
};

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: "Setup",
    sections: [
      { path: "/settings/agents", label: "Agents" },
      { path: "/settings/manager", label: "Manager Agent" },
      { path: "/settings/models", label: "Models & providers" },
      { path: "/settings/connections", label: "Connections" },
      {
        path: "/settings/channels",
        label: "Channels",
        autoConnectGateway: true,
      },
      { path: "/settings/workspace", label: "Workspace" },
    ],
  },
  {
    label: "Runtime",
    sections: [
      { path: "/settings/runtime", label: "Runtime", autoConnectGateway: true },
      { path: "/settings/local-runtimes", label: "Local Runtimes" },
      {
        path: "/settings/sessions",
        label: "Sessions",
        autoConnectGateway: true,
      },
      { path: "/settings/debug", label: "Debug mode" },
    ],
  },
  {
    label: "Account",
    sections: [
      { path: "/settings/usage", label: "Usage", autoConnectGateway: true },
      { path: "/settings/config", label: "Config", autoConnectGateway: true },
      { path: "/settings/memory", label: "Memory" },
      { path: "/settings/skills", label: "Skills" },
    ],
  },
];

export const SETTINGS_SECTIONS = SETTINGS_GROUPS.flatMap(
  (group) => group.sections,
);

export const GATEWAY_SETTINGS_PATHS: ReadonlySet<string> = new Set(
  SETTINGS_SECTIONS.filter((section) => section.autoConnectGateway).map(
    (section) => section.path,
  ),
);
