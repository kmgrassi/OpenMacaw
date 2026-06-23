import { useUiStore } from "../../stores/ui";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { PageHeader } from "../ui/PageHeader";

export function DebugSection() {
  const debugMode = useUiStore((state) => state.debugMode);
  const toggleDebugMode = useUiStore((state) => state.toggleDebugMode);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Debug mode"
        description="Controls whether diagnostic panels and runtime debug details are shown."
      />

      <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-medium text-slate-100">Debug mode</div>
          <div className="mt-1 text-sm text-slate-400">
            Current status: {debugMode ? "On" : "Off"}
          </div>
        </div>
        <Button
          type="button"
          variant={debugMode ? "secondary" : "primary"}
          onClick={toggleDebugMode}
          aria-pressed={debugMode}
        >
          Turn {debugMode ? "off" : "on"}
        </Button>
      </Card>
    </div>
  );
}
