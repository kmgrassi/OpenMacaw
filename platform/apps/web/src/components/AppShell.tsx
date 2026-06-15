import { useMemo, useState } from "react";
import type React from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAgentsQuery } from "../hooks/useAgents";
import { cn } from "../lib/cn";
import { useAuthStore } from "../stores/auth";
import { useUiStore } from "../stores/ui";
import { AgentSwitcher } from "./AppShell/AgentSwitcher";
import { NavItem } from "./AppShell/NavItem";
import { NavSection } from "./AppShell/NavSection";
import { OpenMacawLogo } from "./OpenMacawLogo";
import { WorkspaceAgentHealthBanner } from "./dashboard/WorkspaceAgentHealthBanner";
import { SETTINGS_GROUPS } from "./AppShell/settings-sections";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";

type AppShellProps = {
  children: React.ReactNode;
  focusMode?: boolean;
};

export function AppShell({ children, focusMode = false }: AppShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { resolvedAgentId, signOut } = useAuthStore();
  const {
    data: agents = [],
    isLoading: loading,
    error,
    refetch: refetchAgents,
  } = useAgentsQuery();
  const debugMode = useUiStore((state) => state.debugMode);
  const toggleDebugMode = useUiStore((state) => state.toggleDebugMode);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(
    location.pathname.startsWith("/settings"),
  );
  const inAgentSettings = location.pathname.startsWith("/settings/agents");

  const chatTarget = useMemo(() => {
    const preferred =
      agents.find((agent) => agent.id === resolvedAgentId) ?? agents[0] ?? null;
    return preferred ? `/dashboard/${preferred.id}` : "/";
  }, [agents, resolvedAgentId]);

  const closeMobile = () => setMobileOpen(false);
  const showLabels = !collapsed;

  const sidebar = (
    <nav
      className={cn(
        "flex h-full flex-col border-r border-border bg-surface transition-[width] duration-200",
        collapsed ? "w-16" : "w-72",
      )}
      aria-label="Primary navigation"
    >
      <div className="flex min-h-14 items-center justify-between border-b border-border px-3">
        {showLabels ? (
          <button
            type="button"
            onClick={() => {
              navigate(chatTarget);
              closeMobile();
            }}
            className="flex min-w-0 items-center gap-2.5 text-left"
          >
            <OpenMacawLogo className="size-9" />
            <div className="min-w-0">
              <div className="truncate text-[0.9375rem] font-semibold text-slate-100">
                OpenMacaw
              </div>
              <div className="truncate text-xs text-slate-400">Workspace</div>
            </div>
          </button>
        ) : (
          <IconButton
            onClick={() => {
              navigate(chatTarget);
              closeMobile();
            }}
            variant="secondary"
            size="lg"
            className="overflow-hidden p-0"
            aria-label="Go to chat"
          >
            <OpenMacawLogo className="size-full border-0" />
          </IconButton>
        )}
        <IconButton
          onClick={() => setCollapsed((value) => !value)}
          className="hidden text-slate-500 md:inline-flex"
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        >
          {collapsed ? ">" : "<"}
        </IconButton>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-5">
          <div className="space-y-1">
            {showLabels && (
              <div className="px-2 text-[0.8125rem] font-medium uppercase tracking-wide text-slate-400">
                Navigation
              </div>
            )}
            <NavItem
              to={chatTarget}
              label="Chat"
              collapsed={collapsed}
              onNavigate={closeMobile}
            />
            <NavItem
              to="/work"
              label="Plans & work items"
              collapsed={collapsed}
              onNavigate={closeMobile}
            />
            <NavItem
              to="/plans/new"
              label="Create Plan"
              collapsed={collapsed}
              onNavigate={closeMobile}
            />
          </div>

          <AgentSwitcher
            agents={agents}
            loading={loading}
            error={error ? error.message : null}
            collapsed={collapsed}
            showLabels={showLabels}
            agentsOpen={agentsOpen}
            inAgentSettings={inAgentSettings}
            onToggleAgents={() => setAgentsOpen((value) => !value)}
            onCreateAgent={() => {
              setAgentsOpen(true);
              navigate("/settings/agents/new");
              closeMobile();
            }}
            onNavigate={closeMobile}
            onRetry={() => void refetchAgents()}
          />

          <NavSection
            label="Settings"
            collapsed={collapsed}
            open={settingsOpen}
            onToggle={() => {
              const willOpen = !settingsOpen;
              setSettingsOpen(willOpen);
              if (willOpen && !location.pathname.startsWith("/settings")) {
                navigate("/settings/agents");
                closeMobile();
              }
            }}
          >
            <div className="space-y-3">
              {SETTINGS_GROUPS.map((group) => (
                <div key={group.label} className="space-y-0.5">
                  {!collapsed && (
                    <div className="px-2.5 pb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                      {group.label}
                    </div>
                  )}
                  {group.sections.map((section) => (
                    <NavItem
                      key={section.path}
                      to={section.path}
                      label={section.label}
                      collapsed={collapsed}
                      onNavigate={closeMobile}
                    />
                  ))}
                </div>
              ))}
            </div>
          </NavSection>
        </div>
      </div>

      <div className="space-y-1 border-t border-border p-3">
        <button
          type="button"
          onClick={toggleDebugMode}
          className={cn(
            "flex min-h-9 w-full items-center rounded-md px-2.5 py-2 text-[0.9375rem] transition-colors",
            collapsed ? "justify-center" : "justify-between gap-3",
            debugMode
              ? "bg-blue-950/50 text-blue-200"
              : "text-slate-300 hover:bg-surface-raised hover:text-slate-100",
          )}
          aria-pressed={debugMode}
          title="Toggle debug mode"
        >
          <span className={cn(collapsed && "sr-only")}>Debug mode</span>
          {collapsed ? (
            <span aria-hidden>D</span>
          ) : (
            <span className="text-xs">{debugMode ? "On" : "Off"}</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => void signOut()}
          className={cn(
            "flex min-h-9 w-full items-center rounded-md px-2.5 py-2 text-[0.9375rem] text-slate-400 transition-colors hover:bg-surface-raised hover:text-slate-100",
            collapsed ? "justify-center" : "justify-start",
          )}
        >
          <span className={cn(collapsed && "sr-only")}>Sign out</span>
          {collapsed && <span aria-hidden>Q</span>}
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex h-full bg-slate-950 text-slate-100">
      {!focusMode && <div className="hidden md:block">{sidebar}</div>}

      {!focusMode && mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/55"
            onClick={closeMobile}
            aria-label="Close navigation"
          />
          <div className="relative h-full w-72 shadow-xl">{sidebar}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-14 items-center justify-between border-b border-border bg-surface px-4 md:hidden">
          <Button
            onClick={() => setMobileOpen(true)}
            variant="ghost"
            size="sm"
            className="text-sm text-slate-300"
            aria-label="Open navigation"
          >
            Menu
          </Button>
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-100">
            <OpenMacawLogo className="size-7" />
            <span className="truncate">OpenMacaw</span>
          </div>
        </div>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <WorkspaceAgentHealthBanner agents={agents} />
          {children}
        </main>
      </div>
    </div>
  );
}
