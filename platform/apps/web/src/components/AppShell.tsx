import { useCallback, useMemo, useState } from "react";
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

const COLLAPSED_SIDEBAR_WIDTH = 64;
const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 224;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_RESIZE_STEP = 16;

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

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
  const storedSidebarWidth = useUiStore((state) => state.sidebarWidth);
  const setStoredSidebarWidth = useUiStore((state) => state.setSidebarWidth);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [resizingSidebar, setResizingSidebar] = useState(false);
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
  const sidebarWidth = clampSidebarWidth(storedSidebarWidth);

  const startSidebarResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) {
        return;
      }

      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      setResizingSidebar(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        setStoredSidebarWidth(
          clampSidebarWidth(startWidth + moveEvent.clientX - startX),
        );
      };

      const stopResize = () => {
        setResizingSidebar(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
    },
    [collapsed, setStoredSidebarWidth, sidebarWidth],
  );

  const resizeSidebarWithKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (collapsed) {
        return;
      }

      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        setStoredSidebarWidth(
          clampSidebarWidth(sidebarWidth + direction * SIDEBAR_RESIZE_STEP),
        );
      }
    },
    [collapsed, setStoredSidebarWidth, sidebarWidth],
  );

  const renderSidebar = (resizable: boolean) => (
    <nav
      className={cn(
        "relative flex h-full shrink-0 flex-col border-r border-border bg-surface",
        resizingSidebar ? "transition-none" : "transition-[width] duration-200",
      )}
      style={{
        width: collapsed
          ? COLLAPSED_SIDEBAR_WIDTH
          : resizable
            ? sidebarWidth
            : DEFAULT_SIDEBAR_WIDTH,
      }}
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
        </div>
      </div>

      <div className="space-y-1 border-t border-border p-3">
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
          <div className="max-h-[45dvh] space-y-3 overflow-y-auto pr-1">
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
      {resizable && !collapsed && (
        <div
          role="separator"
          aria-label="Resize navigation"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={startSidebarResize}
          onKeyDown={resizeSidebarWithKeyboard}
          className="group absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize touch-none outline-none"
        >
          <div
            className={cn(
              "mx-auto h-full w-0.5 bg-blue-400 opacity-0 transition-opacity",
              "group-hover:opacity-80 group-focus-visible:opacity-100",
              resizingSidebar && "opacity-100",
            )}
          />
        </div>
      )}
    </nav>
  );

  return (
    <div className="flex h-dvh min-h-0 bg-slate-950 text-slate-100">
      {!focusMode && (
        <div className="hidden md:block">{renderSidebar(true)}</div>
      )}

      {!focusMode && mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/55"
            onClick={closeMobile}
            aria-label="Close navigation"
          />
          <div className="relative h-full w-72 shadow-xl">
            {renderSidebar(false)}
          </div>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-4 md:hidden">
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
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <WorkspaceAgentHealthBanner agents={agents} />
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </main>
      </div>
    </div>
  );
}
