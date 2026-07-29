/**
 * The agents index.
 *
 * Built out of the same chrome as Files and Workspaces, deliberately and not by
 * resemblance: the same `page page--wide` container, the same `cluster
 * page__header` with its actions on the right, the same `list-toolbar` and
 * `SearchFilter`, the same `data-table` with the same sortable headings, and
 * the same kebab in the actions column. Three CRUD screens that merely *look*
 * similar drift the moment any of them is touched; three that share the
 * components cannot.
 *
 * Creating happens in a dialog rather than in a form pinned above the list —
 * again matching the other two. A permanent create form is a permanent piece of
 * furniture for something done once a month, and it pushes the list, which is
 * what the page is for, down.
 *
 * **Deleting is here now, and it asks first.** It used to live only at the
 * bottom of the editor, which meant removing an agent was a navigation away and
 * removing the wrong one was a single unguarded click once you got there.
 *
 * Selecting an agent to *use* is not on this page. That is in the composer,
 * where the choice is actually made; this page is for keeping the list.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { BrainCircuit, Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState, type JSX } from 'react';

import {
  AgentEntrySchema,
  DEFAULT_AGENT_ID,
  deriveAgentId,
  type AgentEntry,
} from '@ghostai/protocol';

import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu.js';
import { SearchFilter } from '@/components/ui/search-filter.js';
import { ConfirmDialog } from '@/components/crud/confirm-dialog.js';
import { NameDialog } from '@/components/crud/name-dialog.js';
import { RowActions } from '@/components/crud/row-actions.js';
import { SortHeader } from '@/components/crud/sort-header.js';
import {
  filterRows,
  nextSort,
  sortRows,
  type Comparators,
  type SortOrder,
} from '@/components/crud/sort.js';
import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { useSaveSettings, useSettings } from '@/settings/use-settings.js';
import { toAgentDeletePatch, toNewAgentPatch, toRenameAgentPatch } from './agents-form.js';
import { useAgent } from './agent-context.js';

/** One row of the table, with everything it renders already resolved. */
interface AgentRow {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  readonly entry: AgentEntry;
  readonly isDefault: boolean;
}

type SortKey = 'name' | 'model';

/** Both columns are text, so both read from A. */
const ASCENDING_FIRST: readonly SortKey[] = ['name', 'model'];

const COMPARE: Comparators<AgentRow, SortKey> = {
  name: (a, b) => a.label.localeCompare(b.label),
  model: (a, b) => a.model.localeCompare(b.model),
};

/** What an agent is offering, in one line, without opening it. */
function summarise(entry: AgentEntry): string {
  const parts: string[] = [];
  if (entry.tools.deny.length > 0) parts.push(`no ${entry.tools.deny.join(', ')}`);
  if (entry.tools.allow.length > 0) parts.push(`only ${entry.tools.allow.join(', ')}`);
  if (entry.approvals?.exec === 'deny') parts.push('cannot run commands');
  if (entry.systemPrompt.trim() !== '') parts.push('own prompt');
  return parts.length === 0 ? 'Every tool, inherited settings' : parts.join(' · ');
}

export function AgentsRoute(): JSX.Element {
  const settings = useSettings();
  const { save, saving } = useSaveSettings();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { agentId: active, select } = useAgent();

  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortOrder<SortKey>>({ key: 'name', descending: false });
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<AgentRow | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<AgentRow | undefined>(undefined);

  const agents = useQuery({
    queryKey: queryKeys.agents,
    queryFn: ({ signal }) => api.agents(signal),
  });

  const list = settings.data?.config.agents.list ?? {};

  /**
   * The default first, then the operator's order.
   *
   * `default` is included even when `agents.list` has no entry for it, which is
   * every install that has not customised it. It is still an agent — every
   * unbound conversation runs on it — and a list that showed only the ones
   * written down would hide the one actually in use.
   */
  const ids = useMemo(
    () => [DEFAULT_AGENT_ID, ...Object.keys(list).filter((id) => id !== DEFAULT_AGENT_ID)],
    [list],
  );

  const entryFor = (id: string): AgentEntry => list[id] ?? AgentEntrySchema.parse({});

  const all = useMemo((): readonly AgentRow[] => {
    const resolved = agents.data?.agents ?? [];
    return ids.map((id) => {
      const entry = list[id] ?? AgentEntrySchema.parse({});
      const model = resolved.find((agent) => agent.id === id)?.model ?? '';
      return {
        id,
        label: entry.label === '' ? id : entry.label,
        model: model === '' ? '—' : model,
        entry,
        isDefault: id === DEFAULT_AGENT_ID,
      };
    });
  }, [ids, list, agents.data]);

  const rows = useMemo(
    () =>
      sortRows(
        filterRows(all, filter, (row) => `${row.id} ${row.label}`),
        sort,
        COMPARE,
        {
          // The default is what every other agent inherits from, so it heads the
          // list in both directions rather than sorting among its own children.
          group: (row) => (row.isDefault ? 0 : 1),
          tiebreak: (a, b) => a.label.localeCompare(b.label),
        },
      ),
    [all, filter, sort],
  );

  const taken = useMemo(() => new Set(ids), [ids]);

  const open = (id: string): void => {
    void navigate({ to: '/agents/$agentId', params: { agentId: id } });
  };

  const refreshAgents = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
  };

  const create = (name: string): void => {
    const proposed = deriveAgentId(name);
    if (proposed === '' || taken.has(proposed)) return;
    save(toNewAgentPatch(proposed, name, entryFor(DEFAULT_AGENT_ID)));
    setCreating(false);
    refreshAgents();
    // Straight into the editor: creating one is the first half of setting it
    // up, and a list that has merely grown a row leaves the other half to be
    // found.
    open(proposed);
  };

  const duplicate = (row: AgentRow): void => {
    const label = `${row.label} copy`;
    const copyId = deriveAgentId(label);
    if (taken.has(copyId)) return;
    save(toNewAgentPatch(copyId, label, row.entry));
    refreshAgents();
    open(copyId);
  };

  const remove = (row: AgentRow): void => {
    save(toAgentDeletePatch(row.id));
    refreshAgents();
    setPendingDelete(undefined);
    // Anything pointed at the agent that just went has to move, or the next
    // conversation would name one the server will refuse.
    if (active === row.id) select(DEFAULT_AGENT_ID);
  };

  const toggleSort = (key: SortKey): void => {
    setSort((current) => nextSort(current, key, ASCENDING_FIRST));
  };

  return (
    <div className="stack page page--wide">
      <div className="cluster page__header">
        <h1 className="page__title">Agents</h1>
        <span className="spacer" />
        <Button
          onClick={() => {
            setCreating(true);
          }}
        >
          <Plus />
          New agent
        </Button>
      </div>

      <div className="cluster list-toolbar">
        <p className="page__note">
          Each has its own prompt, model, permissions and memory, and inherits from the default
          unless it says otherwise.
        </p>
        <span className="spacer" />
        <SearchFilter value={filter} label="Filter agents by name" onValueChange={setFilter} />
      </div>

      {settings.isPending && <p className="page__note">Loading…</p>}
      {settings.isError && (
        <p role="alert" className="page__error">
          Could not load agents: {settings.error.message}
        </p>
      )}

      {settings.isSuccess &&
        (rows.length === 0 ? (
          <p className="page__note">No agent matches “{filter}”.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <SortHeader label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
                <SortHeader label="Model" sortKey="model" sort={sort} onSort={toggleSort} />
                <th scope="col" className="data-table__actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link
                      to="/agents/$agentId"
                      params={{ agentId: row.id }}
                      className="data-table__open"
                      aria-label={`Edit ${row.label}`}
                    >
                      <BrainCircuit />
                      <span className="stack agents__name">
                        <span className="agents__name-row">
                          <span className="truncate">{row.label}</span>
                          {row.isDefault && <Badge>default</Badge>}
                          {!row.entry.enabled && <Badge tone="warning">off</Badge>}
                        </span>
                        <span className="agents__summary truncate">{summarise(row.entry)}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="data-table__meta agents__model">{row.model}</td>
                  <td className="data-table__actions">
                    <RowActions label={row.label}>
                      <DropdownMenuItem
                        onSelect={() => {
                          open(row.id);
                        }}
                      >
                        <Pencil />
                        Edit
                      </DropdownMenuItem>
                      {/* A copy is the fastest route to a variant of something
                          that already works, which is most of what a second
                          agent is. */}
                      <DropdownMenuItem
                        onSelect={() => {
                          duplicate(row);
                        }}
                      >
                        <Copy />
                        Duplicate
                      </DropdownMenuItem>
                      {!row.isDefault && (
                        <DropdownMenuItem
                          onSelect={() => {
                            setRenaming(row);
                          }}
                        >
                          <Pencil />
                          Rename
                        </DropdownMenuItem>
                      )}
                      {/* Switching the default off would leave an install with
                          no agent at all, which is not a state anything
                          downstream can serve. */}
                      {!row.isDefault && (
                        <DropdownMenuItem
                          className="menu__item--danger"
                          onSelect={() => {
                            setPendingDelete(row);
                          }}
                        >
                          <Trash2 />
                          Delete
                        </DropdownMenuItem>
                      )}
                    </RowActions>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      <NameDialog
        open={creating}
        onOpenChange={setCreating}
        title="New agent"
        description="It starts as a copy of the default agent’s prompt and permissions, and keeps inheriting its model."
        fieldLabel="Name"
        placeholder="Code Reviewer"
        pending={saving}
        validate={(value) => {
          const proposed = value.trim() === '' ? '' : deriveAgentId(value);
          if (proposed === '') return { ok: true, hint: 'The id is derived from the name.' };
          if (taken.has(proposed)) {
            return { ok: false, hint: `There is already an agent called “${proposed}”.` };
          }
          return { ok: true, hint: `Creates “${proposed}”.` };
        }}
        onSubmit={create}
      />

      <NameDialog
        open={renaming !== undefined}
        onOpenChange={(open) => {
          if (!open) setRenaming(undefined);
        }}
        title="Rename agent"
        description="Only the display name changes. The id stays as it is, so every conversation bound to this agent keeps working."
        fieldLabel="Name"
        initialValue={renaming?.label ?? ''}
        submitLabel="Save"
        pending={saving}
        onSubmit={(name) => {
          if (renaming === undefined) return;
          save(toRenameAgentPatch(renaming.id, name, renaming.entry));
          setRenaming(undefined);
          refreshAgents();
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined);
        }}
        title="Delete this agent?"
        description={`${pendingDelete?.label ?? ''} is removed from the settings. Its conversations keep their history and fall back to the default agent.`}
        confirmLabel="Delete"
        pending={saving}
        onConfirm={() => {
          if (pendingDelete !== undefined) remove(pendingDelete);
        }}
      />
    </div>
  );
}
