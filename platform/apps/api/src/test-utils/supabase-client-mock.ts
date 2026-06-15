import { vi } from "vitest";

type Row = Record<string, unknown>;
type TableMap = Record<string, Row[]>;
type Filter = {
  column: string;
  operator: "contains" | "eq" | "neq" | "in" | "is" | "not" | "like" | "gte" | "lt" | "lte" | "or";
  negatedOperator?: "is";
  value: unknown;
};

class MockSupabaseQueryBuilder {
  private filters: Filter[] = [];
  private orderBy: Array<{ column: string; ascending: boolean }> = [];
  private limitCount: number | null = null;
  private rangeStart: number | null = null;
  private rangeEnd: number | null = null;
  private operation: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private body: Row | Row[] | null = null;
  private upsertConflict: string[] = [];

  constructor(
    private readonly tables: TableMap,
    private readonly table: string,
  ) {}

  select = vi.fn((_columns?: string) => this);
  eq = vi.fn((column: string, value: unknown) => {
    this.filters.push({ column, operator: "eq", value });
    return this;
  });
  neq = vi.fn((column: string, value: unknown) => {
    this.filters.push({ column, operator: "neq", value });
    return this;
  });
  gte = vi.fn((column: string, value: unknown) => {
    this.filters.push({ column, operator: "gte", value });
    return this;
  });
  in = vi.fn((column: string, value: unknown[]) => {
    this.filters.push({ column, operator: "in", value });
    return this;
  });
  contains = vi.fn((column: string, value: unknown[]) => {
    this.filters.push({ column, operator: "contains", value });
    return this;
  });
  lte = vi.fn((column: string, value: unknown) => {
    this.filters.push({ column, operator: "lte", value });
    return this;
  });
  lt = vi.fn((column: string, value: unknown) => {
    this.filters.push({ column, operator: "lt", value });
    return this;
  });
  like = vi.fn((column: string, pattern: string) => {
    this.filters.push({ column, operator: "like", value: pattern });
    return this;
  });
  or = vi.fn((expression: string) => {
    this.filters.push({ column: "__or", operator: "or", value: expression });
    return this;
  });
  is = vi.fn((column: string, value: unknown) => {
    this.filters.push({ column, operator: "is", value });
    return this;
  });
  not = vi.fn((column: string, operator: "is", value: unknown) => {
    this.filters.push({ column, operator: "not", negatedOperator: operator, value });
    return this;
  });
  order = vi.fn((column: string, options?: { ascending?: boolean }) => {
    this.orderBy.push({ column, ascending: options?.ascending ?? true });
    return this;
  });
  limit = vi.fn((count: number) => {
    this.limitCount = count;
    return this;
  });
  range = vi.fn((from: number, to: number) => {
    this.rangeStart = from;
    this.rangeEnd = to;
    return this;
  });
  insert = vi.fn((body: Row | Row[]) => {
    this.operation = "insert";
    this.body = body;
    return this;
  });
  update = vi.fn((body: Row) => {
    this.operation = "update";
    this.body = body;
    return this;
  });
  delete = vi.fn(() => {
    this.operation = "delete";
    return this;
  });
  upsert = vi.fn((body: Row | Row[], options?: { onConflict?: string }) => {
    this.operation = "upsert";
    this.body = body;
    this.upsertConflict = options?.onConflict?.split(",") ?? [];
    return this;
  });
  single = vi.fn(async () => {
    const rows = this.executeRows();
    return { data: rows[0] ?? null, error: null };
  });
  maybeSingle = vi.fn(async () => {
    const rows = this.executeRows();
    return { data: rows[0] ?? null, error: null };
  });

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[]; error: null; count: number }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const data = this.executeRows();
    return Promise.resolve({ data, error: null, count: data.length }).then(onfulfilled, onrejected);
  }

  private executeRows(): Row[] {
    if (this.operation === "insert") return this.insertRows();
    if (this.operation === "update") return this.updateRows();
    if (this.operation === "delete") return this.deleteRows();
    if (this.operation === "upsert") return this.upsertRows();
    return this.selectRows();
  }

  private tableRows(): Row[] {
    this.tables[this.table] ??= [];
    const rows = this.tables[this.table];
    if (!rows) {
      throw new Error(`Mock table ${this.table} was not initialized`);
    }
    return rows;
  }

  private selectRows(): Row[] {
    const rows = this.tableRows().filter((row) => this.matches(row));
    if (this.orderBy.length > 0) {
      rows.sort((left, right) => {
        for (const { column, ascending } of this.orderBy) {
          const comparison = String(left[column] ?? "").localeCompare(String(right[column] ?? ""));
          if (comparison !== 0) return ascending ? comparison : -comparison;
        }
        return 0;
      });
    }
    if (this.rangeStart !== null && this.rangeEnd !== null) {
      return rows.slice(this.rangeStart, this.rangeEnd + 1);
    }
    return this.limitCount === null ? rows : rows.slice(0, this.limitCount);
  }

  private insertRows(): Row[] {
    const rows = this.tableRows();
    const inserted = this.bodyRows().map((body) => {
      const row = {
        id: body.id ?? this.generatedId(rows.length + 1),
        created_at: "2026-04-25T00:00:00.000Z",
        updated_at: "2026-04-25T00:00:00.000Z",
        ...(this.table === "memory_items" && body.is_deleted === undefined ? { is_deleted: false } : {}),
        ...body,
      };
      rows.push(row);
      return row;
    });
    return inserted;
  }

  private updateRows(): Row[] {
    const body = this.bodyRows()[0] ?? {};
    return this.tableRows()
      .filter((row) => this.matches(row))
      .map((row) => Object.assign(row, body));
  }

  private deleteRows(): Row[] {
    const rows = this.tableRows();
    const deleted = rows.filter((row) => this.matches(row));
    this.tables[this.table] = rows.filter((row) => !deleted.includes(row));
    return deleted;
  }

  private upsertRows(): Row[] {
    const rows = this.tableRows();
    return this.bodyRows().map((body) => {
      const existing = rows.find((row) => this.upsertConflict.every((key) => row[key] === body[key]));
      if (existing) {
        Object.assign(existing, body);
        return existing;
      }
      const inserted = {
        id: body.id ?? this.generatedId(rows.length + 1),
        created_at: "2026-04-25T00:00:00.000Z",
        updated_at: "2026-04-25T00:00:00.000Z",
        ...(this.table === "memory_items" && body.is_deleted === undefined ? { is_deleted: false } : {}),
        ...body,
      };
      rows.push(inserted);
      return inserted;
    });
  }

  private bodyRows(): Row[] {
    if (!this.body) return [];
    return Array.isArray(this.body) ? this.body : [this.body];
  }

  private generatedId(index: number) {
    if (this.table === "memory_items") {
      return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    }
    if (this.table === "provider_cutover") {
      return `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`;
    }
    if (this.table === "scheduled_task") {
      return `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`;
    }
    return `${this.table}-${index}`;
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => {
      if (filter.operator === "eq") return row[filter.column] === filter.value;
      // PostgREST `neq` translates to SQL `<>`, which never matches NULL.
      if (filter.operator === "neq") return row[filter.column] != null && row[filter.column] !== filter.value;
      if (filter.operator === "contains") {
        const candidate = row[filter.column];
        return (
          Array.isArray(candidate) &&
          Array.isArray(filter.value) &&
          filter.value.every((value) => candidate.includes(value))
        );
      }
      if (filter.operator === "in") return Array.isArray(filter.value) && filter.value.includes(row[filter.column]);
      if (filter.operator === "gte") return this.compare(row[filter.column], filter.value) >= 0;
      if (filter.operator === "lt") return this.compare(row[filter.column], filter.value) < 0;
      if (filter.operator === "lte") return this.compare(row[filter.column], filter.value) <= 0;
      if (filter.operator === "or") return this.matchesOr(row, String(filter.value));
      if (filter.operator === "not" && filter.negatedOperator === "is") return row[filter.column] !== filter.value;
      if (filter.operator === "like") {
        const pattern = String(filter.value);
        const value = row[filter.column];
        if (typeof value !== "string") return false;
        const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
        return regex.test(value);
      }
      return row[filter.column] === filter.value;
    });
  }

  private compare(left: unknown, right: unknown): number {
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    return String(left ?? "").localeCompare(String(right ?? ""));
  }

  private matchesOr(row: Row, expression: string): boolean {
    const recentCursorMatch = expression.match(/^triggered_at\.lt\.(.+),and\(triggered_at\.eq\.(.+),id\.lt\.(.+)\)$/);
    if (recentCursorMatch) {
      const [, beforeTriggeredAt, equalTriggeredAt, beforeId] = recentCursorMatch;
      return (
        this.compare(row.triggered_at, beforeTriggeredAt) < 0 ||
        (this.compare(row.triggered_at, equalTriggeredAt) === 0 && this.compare(row.id, beforeId) < 0)
      );
    }
    return true;
  }
}

export function createMockSupabaseClient(tables: TableMap) {
  return {
    from: vi.fn((table: string) => new MockSupabaseQueryBuilder(tables, table)),
    rpc: vi.fn((functionName: string, args: Record<string, unknown>) => {
      if (functionName === "ensure_default_workspace_for_user") {
        const userId = args.p_user_id;
        const workspaceName = typeof args.p_workspace_name === "string" ? args.p_workspace_name.trim() : "";
        const memberships = (tables.workspace_members ??= []);
        const existingMembership = memberships.find((row) => row.user_id === userId);
        if (existingMembership?.workspace_id) {
          const workspaceSettings = (tables.workspace_settings ??= []);
          if (!workspaceSettings.some((row) => row.workspace_id === existingMembership.workspace_id)) {
            workspaceSettings.push({
              workspace_id: existingMembership.workspace_id,
              learning_enabled: false,
              tracker_kind: "database",
              tracker_credential_id: null,
              max_concurrent_agents: 10,
              updated_at: "2026-04-25T00:00:00.000Z",
              updated_by_user_id: null,
            });
          }
          return Promise.resolve({ data: existingMembership.workspace_id, error: null });
        }

        const workspaces = (tables.workspaces ??= []);
        const workspace = {
          id: `workspaces-${workspaces.length + 1}`,
          name: workspaceName || "Personal Workspace",
          owner_user_id: userId,
          created_at: "2026-04-25T00:00:00.000Z",
          updated_at: "2026-04-25T00:00:00.000Z",
        };
        workspaces.push(workspace);
        const workspaceSettings = (tables.workspace_settings ??= []);
        workspaceSettings.push({
          workspace_id: workspace.id,
          learning_enabled: false,
          tracker_kind: "database",
          tracker_credential_id: null,
          max_concurrent_agents: 10,
          updated_at: "2026-04-25T00:00:00.000Z",
          updated_by_user_id: null,
        });
        memberships.push({
          workspace_id: workspace.id,
          user_id: userId,
          role: "owner",
          created_at: "2026-04-25T00:00:00.000Z",
          updated_at: "2026-04-25T00:00:00.000Z",
        });
        return Promise.resolve({ data: workspace.id, error: null });
      }

      if (functionName !== "memory_hybrid_search") {
        return Promise.resolve({ data: [], error: null });
      }
      const workspaceId = args.p_workspace_id;
      const agentId = typeof args.p_agent_id === "string" ? args.p_agent_id : null;
      const scope = typeof args.p_scope === "string" ? args.p_scope : null;
      const matchCount = typeof args.p_match_count === "number" ? args.p_match_count : 10;
      const rows = (tables.memory_items ?? [])
        .filter((row) => row.workspace_id === workspaceId)
        .filter((row) => row.is_deleted !== true)
        .filter((row) => (scope ? row.scope === scope : true))
        .filter((row) => (agentId ? row.agent_id === null || row.agent_id === agentId : row.agent_id === null))
        .sort((left, right) => Number(right.importance ?? 0) - Number(left.importance ?? 0))
        .slice(0, matchCount)
        .map((row, index) => ({ ...row, score: row.score ?? 1 / (index + 1) }));
      return Promise.resolve({ data: rows, error: null });
    }),
  };
}
