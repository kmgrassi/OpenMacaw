import { useState } from "react";
import { useGatewayContext } from "../../context/GatewayContext";
import { fetchLearningCost } from "../../api/learning-cost";
import type { LearningCostResponse } from "../../../../../contracts/learning-cost";
import type { SessionsUsageResult } from "../../api/ws-types";
import { useLoadOnConnect } from "../../hooks/useLoadOnConnect";
import { Alert } from "../ui/Alert";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { LoadingState } from "../ui/LoadingState";
import { PageHeader } from "../ui/PageHeader";

function formatCost(cost: number) {
  return `$${cost.toFixed(4)}`;
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function UsageSection() {
  const { request, connected, scope } = useGatewayContext();
  const [result, setResult] = useState<SessionsUsageResult | null>(null);
  const [learningCost, setLearningCost] = useState<LearningCostResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default to last 7 days
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000)
    .toISOString()
    .slice(0, 10);
  const [startDate, setStartDate] = useState(weekAgo);
  const [endDate, setEndDate] = useState(today);

  const loadUsage = async () => {
    if (!connected) return;
    setLoading(true);
    setError(null);
    try {
      const [sessionsRes, costRes, learningCostRes] = await Promise.all([
        request("sessions.usage", {
          startDate,
          endDate,
          limit: 1000,
        }),
        request("usage.cost", {
          startDate,
          endDate,
        }),
        scope?.workspaceId
          ? fetchLearningCost({
              workspaceId: scope.workspaceId,
              startDate,
              endDate,
            })
          : Promise.resolve(null),
      ]);
      if (sessionsRes) {
        // Merge cost totals if available
        const costTotals = costRes?.totals;
        if (costTotals) {
          sessionsRes.totals = costTotals;
        }
        setResult(sessionsRes);
      }
      setLearningCost(learningCostRes);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useLoadOnConnect(connected, loadUsage);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Usage"
        description="Token usage and cost analytics."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={loadUsage}
            loading={loading}
          >
            Refresh
          </Button>
        }
      />

      {/* Date range */}
      <div className="flex items-end gap-3">
        <Input
          label="From"
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
        />
        <Input
          label="To"
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
        />
        <Button size="sm" onClick={loadUsage} loading={loading}>
          Load
        </Button>
      </div>

      {!connected && <LoadingState label="Connecting to gateway..." />}

      {error && <Alert tone="error">{error}</Alert>}

      {result && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-4 gap-3">
            <Card>
              <div className="text-xs text-slate-400">Total tokens</div>
              <div className="mt-1 text-lg font-semibold text-slate-200">
                {formatTokens(result.totals.totalTokens)}
              </div>
            </Card>
            <Card>
              <div className="text-xs text-slate-400">Total cost</div>
              <div className="mt-1 text-lg font-semibold text-slate-200">
                {formatCost(result.totals.totalCost)}
              </div>
            </Card>
            <Card>
              <div className="text-xs text-slate-400">Messages</div>
              <div className="mt-1 text-lg font-semibold text-slate-200">
                {result.aggregates.messages.total.toLocaleString()}
              </div>
            </Card>
            <Card>
              <div className="text-xs text-slate-400">Errors</div>
              <div className="mt-1 text-lg font-semibold text-slate-200">
                {result.aggregates.messages.errors}
              </div>
            </Card>
          </div>

          {/* By model */}
          {result.aggregates.byModel.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-slate-300">By model</h3>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-raised text-left">
                      <th className="px-3 py-2 text-xs font-medium text-slate-400">
                        Model
                      </th>
                      <th className="px-3 py-2 text-xs font-medium text-slate-400">
                        Requests
                      </th>
                      <th className="px-3 py-2 text-xs font-medium text-slate-400">
                        Tokens
                      </th>
                      <th className="px-3 py-2 text-xs font-medium text-slate-400">
                        Cost
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.aggregates.byModel.map((m, i) => (
                      <tr key={i} className="border-b border-border/50">
                        <td className="px-3 py-2">
                          <span className="text-slate-200 font-mono text-xs">
                            {m.model || "unknown"}
                          </span>
                          {m.provider && (
                            <Badge className="ml-1.5">{m.provider}</Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-400">{m.count}</td>
                        <td className="px-3 py-2 text-slate-400">
                          {formatTokens(m.totals.totalTokens)}
                        </td>
                        <td className="px-3 py-2 text-slate-400">
                          {formatCost(m.totals.totalCost)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {learningCost && learningCost.totals.totalTokens > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-slate-300">
                Learning cost
              </h3>
              <div className="grid grid-cols-3 gap-3">
                <Card>
                  <div className="text-xs text-slate-400">Learning tokens</div>
                  <div className="mt-1 text-lg font-semibold text-slate-200">
                    {formatTokens(learningCost.totals.totalTokens)}
                  </div>
                </Card>
                <Card>
                  <div className="text-xs text-slate-400">Learning cost</div>
                  <div className="mt-1 text-lg font-semibold text-slate-200">
                    {formatCost(learningCost.totals.totalCost)}
                  </div>
                </Card>
                <Card>
                  <div className="text-xs text-slate-400">Learning jobs</div>
                  <div className="mt-1 text-lg font-semibold text-slate-200">
                    {learningCost.aggregates.byKind
                      .reduce((sum, entry) => sum + entry.taskCount, 0)
                      .toLocaleString()}
                  </div>
                </Card>
              </div>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-raised text-left">
                      <th className="px-3 py-2 text-xs font-medium text-slate-400">
                        Kind
                      </th>
                      <th className="px-3 py-2 text-xs font-medium text-slate-400">
                        Jobs
                      </th>
                      <th className="px-3 py-2 text-xs font-medium text-slate-400">
                        Runs
                      </th>
                      <th className="px-3 py-2 text-xs font-medium text-slate-400">
                        Tokens
                      </th>
                      <th className="px-3 py-2 text-xs font-medium text-slate-400">
                        Cost
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {learningCost.aggregates.byKind.map((entry) => (
                      <tr
                        key={entry.kind}
                        className="border-b border-border/50"
                      >
                        <td className="px-3 py-2 text-slate-200 capitalize">
                          {entry.kind}
                        </td>
                        <td className="px-3 py-2 text-slate-400">
                          {entry.taskCount}
                        </td>
                        <td className="px-3 py-2 text-slate-400">
                          {entry.runCount}
                        </td>
                        <td className="px-3 py-2 text-slate-400">
                          {formatTokens(entry.totals.totalTokens)}
                        </td>
                        <td className="px-3 py-2 text-slate-400">
                          {formatCost(entry.totals.totalCost)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Daily breakdown */}
          {result.aggregates.daily.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-slate-300">
                Daily breakdown
              </h3>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-raised text-left">
                      <th className="px-3 py-2 text-xs font-medium text-slate-400">
                        Date
                      </th>
                      <th className="px-3 py-2 text-xs font-medium text-slate-400">
                        Tokens
                      </th>
                      <th className="px-3 py-2 text-xs font-medium text-slate-400">
                        Cost
                      </th>
                      <th className="px-3 py-2 text-xs font-medium text-slate-400">
                        Messages
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.aggregates.daily.map((d) => (
                      <tr key={d.date} className="border-b border-border/50">
                        <td className="px-3 py-2 text-slate-200">{d.date}</td>
                        <td className="px-3 py-2 text-slate-400">
                          {formatTokens(d.tokens)}
                        </td>
                        <td className="px-3 py-2 text-slate-400">
                          {formatCost(d.cost)}
                        </td>
                        <td className="px-3 py-2 text-slate-400">
                          {d.messages}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {!loading && !result && connected && (
        <Card>
          <p className="text-sm text-slate-400">
            No usage data available for the selected period.
          </p>
        </Card>
      )}
    </div>
  );
}
