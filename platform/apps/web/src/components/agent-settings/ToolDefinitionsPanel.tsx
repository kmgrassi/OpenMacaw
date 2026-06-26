import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { ResolvedToolsSection } from "./ToolDefinitionsPanel/ResolvedToolsSection";
import { SchemaPreview } from "./ToolDefinitionsPanel/SchemaPreview";
import { ToolCatalog } from "./ToolDefinitionsPanel/ToolCatalog";
import { useToolAssignments } from "./ToolDefinitionsPanel/useToolAssignments";

type Props = {
  agentId: string;
  workspaceId?: string | null;
};

export function ToolDefinitionsPanel({ agentId, workspaceId }: Props) {
  const {
    allToolsById,
    templates,
    loading,
    saving,
    error,
    actionError,
    confirmation,
    localExecutionReady,
    localExecutionLoading,
    search,
    setSearch,
    bundleFilter,
    setBundleFilter,
    previewToolId,
    setPreviewToolId,
    draftTools,
    addedTools,
    excludedTools,
    excludedGrantTools,
    filteredCatalog,
    dirty,
    addTool,
    removeTool,
    resetDraft,
    saveChanges,
    applyTemplateGrant,
    removeGrant,
    isLocalCodingToolBlocked,
    sourceForTool,
  } = useToolAssignments(agentId, workspaceId);

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-base font-semibold text-slate-200">Tools</h3>
          <p className="mt-1 text-sm text-slate-400">
            Manage this agent's assigned tools and staged override changes.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!dirty || saving}
            onClick={resetDraft}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || saving || !workspaceId}
            loading={saving}
            onClick={saveChanges}
          >
            Save
          </Button>
        </div>
      </div>

      {(error || actionError) && (
        <Alert tone="error" className="mb-4">
          {actionError ?? error}
        </Alert>
      )}
      {confirmation && (
        <Alert tone="success" className="mb-4">
          {confirmation}
        </Alert>
      )}
      {!workspaceId && (
        <Alert tone="warning" className="mb-4">
          Workspace context is required before tools can be configured.
        </Alert>
      )}
      {workspaceId && !localExecutionReady && (
        <Alert tone="warning" className="mb-4">
          Connect a local runtime relay with a workspace root before assigning
          local coding tools.
        </Alert>
      )}

      <section className="space-y-3 border-b border-border pb-4">
        <div>
          <h4 className="text-sm font-medium text-slate-300">Templates</h4>
        </div>
        <div className="flex flex-wrap gap-2">
          {templates.length === 0 ? (
            <span className="text-xs text-slate-500">
              No tool templates are available.
            </span>
          ) : (
            templates.map((template) => (
              <Button
                key={template.id}
                type="button"
                variant="secondary"
                size="sm"
                disabled={saving || !workspaceId}
                onClick={() => applyTemplateGrant(template.id)}
              >
                {template.name}
              </Button>
            ))
          )}
        </div>
      </section>

      {loading ? (
        <p className="py-6 text-sm text-slate-400">Loading tools...</p>
      ) : (
        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
          <ResolvedToolsSection
            draftTools={draftTools}
            addedTools={addedTools}
            excludedTools={excludedTools}
            excludedGrantTools={excludedGrantTools}
            saving={saving}
            sourceForTool={sourceForTool}
            onPreview={setPreviewToolId}
            onAddTool={addTool}
            onRemoveTool={removeTool}
            onRemoveGrant={removeGrant}
          />

          <ToolCatalog
            tools={filteredCatalog}
            search={search}
            bundleFilter={bundleFilter}
            saving={saving}
            localExecutionLoading={localExecutionLoading}
            setSearch={setSearch}
            setBundleFilter={setBundleFilter}
            isLocalCodingToolBlocked={isLocalCodingToolBlocked}
            onPreview={setPreviewToolId}
            onAddTool={addTool}
          />
        </div>
      )}

      {previewToolId && allToolsById.has(previewToolId) && (
        <SchemaPreview
          tool={allToolsById.get(previewToolId)!}
          onClose={() => setPreviewToolId(null)}
        />
      )}
    </Card>
  );
}
