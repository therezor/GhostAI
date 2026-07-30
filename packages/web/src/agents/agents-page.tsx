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

import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { BrainCircuit, Copy, Pencil, Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import { useMemo, useState, type JSX } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

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
import { toAgentDeletePatch, toAgentEnabledPatch, toNewAgentPatch } from './agents-form.js';
import { useAgent } from './agent-context.js';

/** One row of the table, with everything it renders already resolved. */
interface AgentRow {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly entry: AgentEntry;
  readonly isDefault: boolean;
}

type SortKey = 'name' | 'model' | 'status';

/** Every column is text, so all three read from A. */
const ASCENDING_FIRST: readonly SortKey[] = ['name', 'model', 'status'];

/**
 * What the Status column says.
 *
 * A word rather than the absence of one. The state used to be an `off` badge
 * beside the name and nothing at all when the agent was on, which reads as "we
 * had nothing to say about this row" rather than as "this one runs".
 */
function statusLabel(row: AgentRow): string {
  return row.enabled ? 'Enabled' : 'Disabled';
}

const COMPARE: Comparators<AgentRow, SortKey> = {
  name: (a, b) => a.label.localeCompare(b.label),
  model: (a, b) => a.model.localeCompare(b.model),
  // Compared as the label rather than as the boolean, so the column sorts the
  // way it reads: ascending is Disabled before Enabled, which is D before E.
  status: (a, b) => statusLabel(a).localeCompare(statusLabel(b)),
};

/**
 * What an agent is offering, in one line, without opening it.
 *
 * Counts rather than names. An agent's map holds every tool the install has, so
 * listing them would fill the column with the same five words on every row —
 * what differs between agents is how many of them are on, and how many of those
 * stop to ask.
 */
function summarise(entry: AgentEntry, t: TFunction): string {
  const permissions = Object.values(entry.tools);
  const enabled = permissions.filter((permission) => permission !== 'deny').length;
  const asking = permissions.filter((permission) => permission === 'ask').length;

  const parts = [t('agents.summaryTools', { count: enabled })];
  if (asking > 0) parts.push(t('agents.summaryAsking', { count: asking }));
  if (entry.systemPrompt.trim() !== '') parts.push(t('agents.summaryOwnPrompt'));
  return parts.join(' · ');
}

export function AgentsRoute(): JSX.Element {
  const { t } = useTranslation();
  const settings = useSettings();
  const { save, saving } = useSaveSettings();
  const navigate = useNavigate();
  const { agentId: active, select } = useAgent();

  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortOrder<SortKey>>({ key: 'name', descending: false });
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AgentRow | undefined>(undefined);

  const agents = useQuery({
    queryKey: queryKeys.agents,
    queryFn: ({ signal }) => api.agents(signal),
  });

  const list = settings.data?.config.agents.list ?? {};
  const defaults = settings.data?.config.agents.defaults;

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
      // `/api/agents` reports the model a turn would actually use, but it omits
      // the disabled ones entirely — so the stored value is the fallback, or a
      // switched-off agent would show a dash where its model is.
      const model = resolved.find((agent) => agent.id === id)?.model ?? entry.model ?? '';
      const isDefault = id === DEFAULT_AGENT_ID;
      return {
        id,
        label: entry.label === '' ? id : entry.label,
        model: model === '' ? '—' : model,
        // The default agent's own flag is ignored by the resolver — an install
        // with no agent at all is not a state anything downstream can serve —
        // so the column reports what is true rather than what is stored.
        enabled: isDefault || entry.enabled,
        entry,
        isDefault,
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
          // The default is the agent every other one was created as a copy of,
          // so it heads the list in both directions rather than sorting among
          // the agents it seeded.
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

  /**
   * Opens the editor once the agent it names actually exists.
   *
   * **On success, not on the next line.** `save` is fire-and-forget, so
   * navigating straight after it took the editor to an agent the settings cache
   * had never seen — which is the "There is no agent called …" path, and is why
   * duplicating one appeared to do nothing at all.
   */
  const createThenOpen = (id: string, patch: ReturnType<typeof toNewAgentPatch>): void => {
    save(patch, {
      onSuccess: () => {
        open(id);
      },
    });
  };

  const create = (name: string): void => {
    const proposed = deriveAgentId(name);
    // A new agent is a copy of the defaults, so there is nothing to copy until
    // they have arrived. The dialog is reachable while the query is in flight.
    if (proposed === '' || taken.has(proposed) || defaults === undefined) return;
    // Straight into the editor: creating one is the first half of setting it
    // up, and a list that has merely grown a row leaves the other half to be
    // found.
    createThenOpen(proposed, toNewAgentPatch(proposed, name, entryFor(DEFAULT_AGENT_ID), defaults));
    setCreating(false);
  };

  /**
   * A copy, under a name that does not collide.
   *
   * The suffix is counted rather than fixed: "Reviewer copy" is taken the
   * second time, and a duplicate that silently did nothing because of it was
   * indistinguishable from one that was broken.
   */
  const duplicate = (row: AgentRow): void => {
    if (defaults === undefined) return;

    let label = `${row.label} copy`;
    let copyId = deriveAgentId(label);
    for (let n = 2; taken.has(copyId); n += 1) {
      label = `${row.label} copy ${String(n)}`;
      copyId = deriveAgentId(label);
    }

    createThenOpen(copyId, toNewAgentPatch(copyId, label, row.entry, defaults));
  };

  /**
   * Switching one off, which is the reversible half of deleting it.
   *
   * Its prompt, tools and permissions stay in the settings; it simply stops
   * being something a turn can run on, and stops being offered in the composer.
   */
  const toggleEnabled = (row: AgentRow): void => {
    save(toAgentEnabledPatch(row.id, row.entry, !row.enabled));
    // Same reason a delete moves the selection: an agent that has just been
    // switched off is one the server will refuse, so nothing may stay pointed
    // at it.
    if (row.enabled && active === row.id) select(DEFAULT_AGENT_ID);
  };

  const remove = (row: AgentRow): void => {
    save(toAgentDeletePatch(row.id));
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
        <h1 className="page__title">{t('agents.title')}</h1>
        <span className="spacer" />
        <Button
          onClick={() => {
            setCreating(true);
          }}
        >
          <Plus />
          {t('agents.newAgent')}
        </Button>
      </div>

      <div className="cluster list-toolbar">
        <p className="page__note">{t('agents.note')}</p>
        <span className="spacer" />
        <SearchFilter value={filter} label={t('agents.filter')} onValueChange={setFilter} />
      </div>

      {settings.isPending && <p className="page__note">{t('common.loading')}</p>}
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
                <SortHeader
                  label={t('common.name')}
                  sortKey="name"
                  sort={sort}
                  onSort={toggleSort}
                />
                <SortHeader
                  label={t('agents.model')}
                  sortKey="model"
                  sort={sort}
                  onSort={toggleSort}
                />
                <SortHeader
                  label={t('common.status')}
                  sortKey="status"
                  sort={sort}
                  onSort={toggleSort}
                />
                <th scope="col" className="data-table__actions">
                  <span className="sr-only">{t('common.actions')}</span>
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
                        </span>
                        <span className="agents__summary truncate">{summarise(row.entry, t)}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="data-table__meta agents__model">{row.model}</td>
                  <td className="data-table__meta">
                    <Badge tone={row.enabled ? 'success' : 'neutral'}>{statusLabel(row)}</Badge>
                  </td>
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
                      {/* No Rename. The name is a field in the editor, which is
                          one press away and is where every other thing about
                          an agent is changed — a second way to edit one field,
                          with its own dialog and its own patch builder, was a
                          shortcut that had to be kept correct twice. */}
                      {/* Reversible where Delete is not: a disabled agent keeps
                          its prompt and permissions and simply stops being
                          something a turn can run on. No confirmation, for the
                          same reason — switching it back on is the same click. */}
                      {!row.isDefault && (
                        <DropdownMenuItem
                          onSelect={() => {
                            toggleEnabled(row);
                          }}
                        >
                          {row.enabled ? <PowerOff /> : <Power />}
                          {row.enabled ? 'Disable' : 'Enable'}
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
        title={t('agents.newTitle')}
        description={t('agents.newHint')}
        fieldLabel="Name"
        placeholder={t('agents.namePlaceholder')}
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

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined);
        }}
        title={t('agents.deleteTitle')}
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
