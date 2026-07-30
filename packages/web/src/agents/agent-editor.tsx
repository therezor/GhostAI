/**
 * Editing one agent.
 *
 * A route of its own rather than a panel beside a list, because an agent has
 * several sections' worth of settings and a master/detail that put both on one
 * screen made the list a narrow column of nothing and the form a scroll. The
 * list picks; this edits; the back link returns.
 *
 * **The default agent is edited here too, and it is the reason Settings has no
 * "Agent" panel.** Its model and budget *are* `agents.defaults` — what a new
 * agent is seeded from — so editing them is editing that subtree, and a second
 * screen for the same fields was two doors into one room.
 *
 * **It is also the same screen, field for field.** It did not use to be: the
 * default agent got sections called "Model", "Budget" and "Workspace" while
 * every other agent got one called "Model and budget", with different labels,
 * different hints and a different shape. Two layouts for one concept meant an
 * operator learned the screen twice and could not tell which settings an agent
 * actually had. The only remaining difference is *which subtree a control
 * writes to*, which lives in one `bind` function here and in `onSave`.
 *
 * **Nothing on this screen inherits.** Every box holds this agent's own value,
 * and one opened on an agent that stored none is filled from the defaults so
 * that saving writes them down — see the note at the top of `agents-form.ts`.
 * There is no "Inherit — …" option and no empty box that means "ask the other
 * screen": a setting you cannot read off the screen it is on is a setting an
 * operator has to go and derive.
 *
 * **The system prompt is last.** It is the tallest thing on the screen by a
 * wide margin — a full editor holding a page of text — and in the middle it
 * split the short settings into a group above and a group below, so reaching
 * the tools meant scrolling past a document. Everything that fits on a line
 * comes first; the one thing that does not comes after, where it can be as tall
 * as it likes without pushing anything.
 */

import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, RotateCcw, Trash2 } from 'lucide-react';
import { useMemo, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AgentEntrySchema,
  DEFAULT_AGENT_ID,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  PROMPT_PLACEHOLDERS,
  unknownPlaceholders,
  type AgentDefaults,
  type AgentEntry,
} from '@ghostai/protocol';

import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu.js';
import { Switch } from '@/components/ui/switch.js';
import { ConfirmDialog } from '@/components/crud/confirm-dialog.js';
import { RowActions } from '@/components/crud/row-actions.js';
import { CodeEditor } from '@/files/code-editor.js';
import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import {
  FieldGrid,
  SaveBar,
  Section,
  SelectField,
  SwitchRow,
  TextField,
} from '@/settings/controls.js';
import { modelOptions } from '@/settings/fields.js';
import { useSaveSettings, useSettings } from '@/settings/use-settings.js';
import {
  APPROVAL_POLICIES,
  REASONING_EFFORTS,
  UNSET_VALUE,
  parseToolList,
  toAgentDeletePatch,
  toAgentEntryForm,
  toAgentEntryPatch,
  toAgentForm,
  toDefaultAgentPatch,
  type AgentEntryForm,
  type AgentForm,
} from './agents-form.js';
import { useAgent } from './agent-context.js';

/**
 * The fields both halves of the form hold as strings under the same name.
 *
 * Intersecting the two keeps `bind` honest: a field that exists on only one of
 * them — `learningEnabled`, `allowTools` — cannot be bound this way, and trying
 * is a compile error rather than a control that silently edits nothing.
 */
type StringField = {
  [K in keyof AgentForm & keyof AgentEntryForm]: AgentForm[K] extends string
    ? AgentEntryForm[K] extends string
      ? K
      : never
    : never;
}[keyof AgentForm & keyof AgentEntryForm];

/** One field, wherever this agent happens to keep it. */
interface Bound {
  readonly value: string;
  readonly set: (value: string) => void;
}

/**
 * A select whose blank is a real answer.
 *
 * `reasoningEffort` unset means the request carries no such parameter; an
 * approval band left blank is governed by `tools.approvals` rather than by this
 * agent. Neither is "no value chosen", so neither may render as a blank
 * trigger — `unsetLabel` is the sentence that says what the blank does.
 */
function OptionalSelect({
  label,
  bound,
  options,
  unsetLabel,
}: {
  readonly label: string;
  readonly bound: Bound;
  readonly options: readonly string[];
  readonly unsetLabel: string;
}): JSX.Element {
  return (
    <SelectField
      label={label}
      value={bound.value === '' ? UNSET_VALUE : bound.value}
      options={[
        { value: UNSET_VALUE, label: unsetLabel },
        ...options.map((option) => ({ value: option, label: option })),
      ]}
      onValueChange={(next) => {
        bound.set(next === UNSET_VALUE ? '' : next);
      }}
    />
  );
}

/** A text field over whichever subtree this agent keeps the setting in. */
function BoundField({
  label,
  bound,
  error,
  hint,
  inputMode,
  placeholder,
}: {
  readonly label: string;
  readonly bound: Bound;
  readonly error?: string | undefined;
  readonly hint?: string;
  readonly inputMode?: 'numeric' | 'decimal';
  readonly placeholder?: string;
}): JSX.Element {
  return (
    <TextField
      label={label}
      value={bound.value}
      {...(error === undefined ? {} : { error })}
      {...(hint === undefined ? {} : { hint })}
      {...(inputMode === undefined ? {} : { inputMode })}
      {...(placeholder === undefined ? {} : { placeholder })}
      onValueChange={bound.set}
    />
  );
}

/**
 * The dropdown's stand-in for "no toolbox".
 *
 * A `SelectItem` may not carry an empty value — Radix reserves it for "nothing
 * chosen" — so the option that clears the field needs a value of its own. It
 * begins with `-`, which `ToolboxStore.manifestPathFor` refuses in a toolbox
 * name, so no installed toolbox can ever collide with it.
 */
const NO_TOOLBOX = '-none-';

export function AgentEditorRoute(): JSX.Element {
  const { t } = useTranslation();
  const { agentId } = useParams({ from: '/agents/$agentId' });
  const settings = useSettings();

  if (settings.isPending) return <p className="page__note">{t('agents.loading')}</p>;
  if (settings.isError) {
    return (
      <p role="alert" className="page__error">
        Could not load the agent: {settings.error.message}
      </p>
    );
  }

  const { config } = settings.data;
  const isDefault = agentId === DEFAULT_AGENT_ID;
  const entry = config.agents.list[agentId];

  // A named agent that is not in the settings is a stale link — a bookmark to
  // one that was deleted, or a hand-typed id. Saying so beats an empty form
  // that silently creates it on the first save.
  if (entry === undefined && !isDefault) {
    return (
      <div className="stack page page--wide">
        <p role="alert" className="page__error">
          There is no agent called “{agentId}”.
        </p>
        <Link to="/agents" className="page__back">
          <ArrowLeft aria-hidden="true" />
          {t('agents.backToAgents')}
        </Link>
      </div>
    );
  }

  return (
    <Editor
      // Remounts on a change of agent, so one agent's edits cannot survive into
      // the next one's boxes.
      key={agentId}
      agentId={agentId}
      entry={entry ?? AgentEntrySchema.parse({})}
      defaults={config.agents.defaults}
    />
  );
}

function Editor({
  agentId,
  entry,
  defaults,
}: {
  readonly agentId: string;
  readonly entry: AgentEntry;
  readonly defaults: AgentDefaults;
}): JSX.Element {
  const { t } = useTranslation();
  const isDefault = agentId === DEFAULT_AGENT_ID;
  const navigate = useNavigate();
  const { agentId: active, select } = useAgent();
  const { save, saving } = useSaveSettings();

  const [form, setForm] = useState<AgentEntryForm>(() => toAgentEntryForm(entry, defaults));
  const [base, setBase] = useState<AgentForm>(() => toAgentForm(defaults));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [dirty, setDirty] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const agents = useQuery({
    queryKey: queryKeys.agents,
    queryFn: ({ signal }) => api.agents(signal),
  });
  const providers = useQuery({
    queryKey: queryKeys.providers,
    queryFn: ({ signal }) => api.providers(signal),
  });
  const models = useQuery({
    queryKey: queryKeys.models,
    queryFn: ({ signal }) => api.models(signal),
  });
  const tools = useQuery({
    queryKey: queryKeys.tools,
    queryFn: ({ signal }) => api.tools(signal),
  });

  const toolboxes = useQuery({
    queryKey: queryKeys.toolboxes,
    queryFn: ({ signal }) => api.toolboxes(signal),
  });

  const resolved = agents.data?.agents.find((agent) => agent.id === agentId);

  /**
   * Every installed toolbox, approved or not.
   *
   * Unapproved ones are offered rather than hidden: an operator who has just
   * built one needs to see it in the list to understand that approving is the
   * step they are missing. Choosing it is refused at save with a sentence that
   * says so, which is a better teacher than an empty dropdown.
   */
  const toolboxOptions = [
    // "No toolbox" has to be a real option, not the placeholder.
    //
    // Radix shows a placeholder only while the value is empty, and empty is the
    // one value a `SelectItem` may not carry — so choosing a toolbox was a
    // one-way door: the option that would take it back did not exist, and an
    // agent could not be moved off a container without hand-editing the config.
    { value: NO_TOOLBOX, label: t('agents.toolboxHost') },
    ...(toolboxes.data?.toolboxes ?? []).map((box: { name: string; label: string }) => ({
      value: box.name,
      label: box.label === '' ? box.name : `${box.label} (${box.name})`,
    })),
  ];
  const chosen = toolboxes.data?.toolboxes.find(
    (box: { name: string }) => box.name === form.toolboxName,
  );
  const boxed = form.toolboxName !== '';

  /**
   * The network modes this toolbox actually permits.
   *
   * Filtered by the toolbox's own ceiling rather than offering all three and
   * failing the save: a picker that lets you choose something the manifest
   * forbids is a picker that teaches the wrong thing about who is in charge.
   */
  const networkOptions = (
    [
      { value: 'none', label: t('agents.toolboxNetworkNone') },
      { value: 'allowlist', label: t('agents.toolboxNetworkAllowlist') },
      { value: 'open', label: t('agents.toolboxNetworkOpen') },
    ] as const
  ).filter((option) => {
    const order = ['none', 'allowlist', 'open'];
    const ceiling = chosen?.maxNetwork ?? 'none';
    return order.indexOf(option.value) <= order.indexOf(ceiling);
  });

  const update = <K extends keyof AgentEntryForm>(key: K, value: AgentEntryForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };
  const updateBase = <K extends keyof AgentForm>(key: K, value: AgentForm[K]): void => {
    setBase((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  /**
   * Where each field lives for *this* agent.
   *
   * The default agent's model and budget are `agents.defaults`; every other
   * agent's are on its own entry. That is the only difference left between the
   * two screens, and deciding it once here is what lets the form below be
   * written a single time.
   */
  const bind = (key: StringField): Bound =>
    isDefault
      ? {
          value: base[key],
          set: (value) => {
            updateBase(key, value);
          },
        }
      : {
          value: form[key],
          set: (value) => {
            update(key, value);
          },
        };

  const fields = {
    provider: bind('provider'),
    model: bind('model'),
    temperature: bind('temperature'),
    reasoningEffort: bind('reasoningEffort'),
    maxTokens: bind('maxTokens'),
    contextWindowTokens: bind('contextWindowTokens'),
    toolTimeoutSeconds: bind('toolTimeoutSeconds'),
  } satisfies Record<string, Bound>;

  // ── The system prompt ────────────────────────────────────────────────────
  //
  // Empty means "use the built-in", so the box shows the built-in and typing
  // into it is what makes the prompt this agent's own. That is the whole of the
  // discoverability problem: an operator cannot choose to edit something they
  // have never been shown.
  //
  // **Ownership is state, not `systemPrompt !== ''`.** Deriving it made the box
  // fight the person typing in it: selecting all and deleting — the obvious way
  // to start a short prompt from scratch — emptied the field, which flipped it
  // back to "not owned", which refilled the box with the built-in template. The
  // next keystroke then landed at the end of a page of text nobody asked for.
  const [promptOwned, setPromptOwned] = useState(() => entry.systemPrompt.trim() !== '');
  const promptText = promptOwned ? form.systemPrompt : DEFAULT_SYSTEM_PROMPT_TEMPLATE;
  const strayPlaceholders = useMemo(() => unknownPlaceholders(promptText), [promptText]);

  // ── Tools ────────────────────────────────────────────────────────────────
  const allow = useMemo(() => parseToolList(form.allowTools), [form.allowTools]);
  const deny = useMemo(() => parseToolList(form.denyTools), [form.denyTools]);
  const onlyListed = allow.length > 0;

  /**
   * Every tool this agent could name, registered or not.
   *
   * The union matters because `agents.list.*` is replaced wholesale on save: a
   * checkbox list built only from the live registry would silently drop a tool
   * this agent denies but whose MCP server happens to be down, and the denial
   * would be gone the next time anything on this screen was saved.
   */
  const toolNames = useMemo(() => {
    const names = new Set<string>((tools.data?.tools ?? []).map((tool) => tool.name));
    for (const name of [...allow, ...deny]) names.add(name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [tools.data, allow, deny]);

  const registered = useMemo(
    () => new Set((tools.data?.tools ?? []).map((tool) => tool.name)),
    [tools.data],
  );

  const setToolChecked = (name: string, checked: boolean): void => {
    if (onlyListed) {
      const next = checked ? [...allow, name] : allow.filter((tool) => tool !== name);
      update('allowTools', next.join(', '));
      return;
    }
    // "Everything except": a *checked* box is a tool the agent may call, so
    // unchecking one adds it to the deny list.
    const next = checked ? deny.filter((tool) => tool !== name) : [...deny, name];
    update('denyTools', next.join(', '));
  };

  const setOnlyListed = (next: boolean): void => {
    // Carry the choice across rather than resetting it: the tools that were
    // reachable a moment ago are the obvious starting point for the other mode.
    const reachable = toolNames.filter(
      (name) => (onlyListed ? allow : deny).includes(name) === onlyListed,
    );
    if (next) {
      update('allowTools', reachable.join(', '));
      update('denyTools', '');
    } else {
      update('allowTools', '');
      update('denyTools', toolNames.filter((name) => !reachable.includes(name)).join(', '));
    }
  };

  const providerOptions = useMemo(() => {
    const instances = (providers.data?.instances ?? []).filter((instance) => instance.enabled);
    return [
      { value: 'auto', label: 'auto — resolve from whichever has credentials' },
      ...instances.map((instance) => ({
        value: instance.id,
        label: instance.displayName === '' ? instance.id : instance.displayName,
      })),
    ];
  }, [providers.data]);

  /**
   * The catalogue for the chosen provider, plus whatever is already pinned.
   *
   * `modelOptions` in `settings/fields.ts` already holds both rules that matter
   * — `auto` offers everything, and the current model is always in the list
   * even when no endpoint advertises it — so a model pinned by hand, or one a
   * provider stopped listing, survives being looked at.
   */
  const modelChoices = useMemo(
    () => modelOptions(models.data?.models ?? [], fields.provider.value, fields.model.value),
    [models.data, fields.provider.value, fields.model.value],
  );

  /**
   * Changing the provider, and dropping the model when the new one cannot serve it.
   *
   * The model list is per provider, so switching endpoints leaves a pin that
   * may name nothing on the other side — and because `modelOptions` always
   * keeps the current value in the list (so a hand-typed or temporarily
   * unlisted model survives being looked at), the stale pin would go on
   * *looking* valid in the select right up until a turn failed on it.
   *
   * Two cases deliberately do **not** clear it, because in both the honest
   * answer is "unknown" rather than "no":
   *
   *  - **`auto`**, which is not an endpoint but an instruction to resolve one,
   *    so every model is still on the table.
   *  - **An empty catalogue** — the query is still in flight, or every endpoint
   *    is unreachable. Clearing on that would unpin a working model because a
   *    server was briefly down, which is the failure this guard exists to avoid
   *    causing.
   */
  const onProviderChange = (value: string): void => {
    fields.provider.set(value);

    const pinned = fields.model.value;
    if (pinned === '') return;

    const catalogue = models.data?.models ?? [];
    if (catalogue.length === 0) return;

    if (value === 'auto') return;

    // `current` empty, so this is what the new provider actually offers rather
    // than that plus the value being judged.
    if (!modelOptions(catalogue, value, '').includes(pinned)) {
      fields.model.set('');
    }
  };

  const onDelete = (): void => {
    save(toAgentDeletePatch(agentId));
    // Anything pointed at the agent that just went has to move, or the next
    // conversation would name one the server will refuse.
    if (active === agentId) select(DEFAULT_AGENT_ID);
    // Leaving immediately is safe in this direction: the list this returns to
    // does not depend on the agent that is going away.
    void navigate({ to: '/agents' });
  };

  const onSave = (): void => {
    const result = isDefault
      ? toDefaultAgentPatch(base, form, entry, t)
      : toAgentEntryPatch(agentId, form, entry, t);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    // No invalidation here any more: `useSaveSettings` refreshes the agents
    // query once the write has landed. Doing it on this line fired it *before*
    // the PATCH resolved, so the refetch answered from the old config and a
    // rename never reached the composer's picker.
    save(result.patch);
    setDirty(false);
  };

  const onRevert = (): void => {
    setForm(toAgentEntryForm(entry, defaults));
    setBase(toAgentForm(defaults));
    // Or a revert would leave the box holding the stored (empty) prompt while
    // still claiming the agent owns one.
    setPromptOwned(entry.systemPrompt.trim() !== '');
    setErrors({});
    setDirty(false);
  };

  const name = form.label === '' ? agentId : form.label;

  return (
    <div className="stack page page--wide agent-editor">
      <div className="editor__head">
        <Link to="/agents" className="page__back">
          <ArrowLeft aria-hidden="true" />
          Agents
        </Link>

        <div className="cluster editor__title">
          <h1 className="page__title">{name}</h1>
          {isDefault && <Badge>default</Badge>}
          <span className="spacer" />
          {/* Not a section at the bottom of the form any more. A destructive
              action does not belong in the reading order of the settings it
              would destroy, and it used to fire without asking. */}
          {!isDefault && (
            <RowActions label={name}>
              <DropdownMenuItem
                className="menu__item--danger"
                onSelect={() => {
                  setConfirmingDelete(true);
                }}
              >
                <Trash2 />
                {t('agents.deleteAgent')}
              </DropdownMenuItem>
            </RowActions>
          )}
        </div>

        <p className="page__note">
          {isDefault
            ? 'Every conversation that names no agent runs on this one, and a new agent starts as a copy of it.'
            : `Runs on ${resolved?.model === '' || resolved === undefined ? 'no model yet — it cannot take a turn until one is chosen' : resolved.model}.`}
        </p>
      </div>

      <Section title={t('agents.identity')} description={t('agents.identityDesc')}>
        <FieldGrid>
          <TextField
            label={t('common.name')}
            value={form.label}
            placeholder={agentId}
            onValueChange={(value) => {
              update('label', value);
            }}
            hint="Fills {{name}} in the system prompt."
          />
          {!isDefault && (
            <SwitchRow
              label={t('agents.enabled')}
              hint="A disabled agent cannot run a turn and is hidden from the picker."
              checked={form.enabled}
              onCheckedChange={(checked) => {
                update('enabled', checked);
              }}
            />
          )}
        </FieldGrid>
      </Section>

      <Section
        title={t('agents.modelSection')}
        description={
          isDefault
            ? 'What this agent runs on, and what a new agent is created holding.'
            : 'What this agent runs on.'
        }
      >
        <FieldGrid>
          <SelectField
            label={t('agents.provider')}
            value={fields.provider.value}
            options={providerOptions}
            onValueChange={onProviderChange}
            error={errors.provider}
          />
          {/* No "resolved automatically" option, because there is no such
              resolution: an empty model is `noModelError` and a `null` provider
              in the runtime, so offering it here dressed an unconfigured
              install up as a choice. Blank is a placeholder now — a question
              the form asks — and saving without answering it is refused. */}
          <SelectField
            label={t('agents.model')}
            value={fields.model.value}
            placeholder={modelChoices.length === 0 ? 'No models to choose from' : 'Choose a model'}
            options={modelChoices.map((model) => ({ value: model, label: model }))}
            onValueChange={fields.model.set}
            error={errors.model}
            hint={
              modelChoices.length === 0
                ? 'Nothing could be listed. Add an endpoint and its credentials in Settings → Providers.'
                : models.isError
                  ? 'The model lists could not be fetched. Anything already pinned is still offered.'
                  : 'Endpoints that list their own models are enumerated live.'
            }
          />
          <BoundField
            label={t('agents.temperature')}
            bound={fields.temperature}
            inputMode="decimal"
            error={errors.temperature}
            placeholder={t('agents.providerDefault')}
            hint="Leave empty to send none at all — which is the only thing that works for models that reject it."
          />
          <OptionalSelect
            label={t('agents.reasoningEffort')}
            bound={fields.reasoningEffort}
            options={REASONING_EFFORTS}
            unsetLabel="The provider’s own"
          />
        </FieldGrid>
      </Section>

      <Section title={t('agents.toolsSection')} description={t('agents.toolsDesc')}>
        <SwitchRow
          label={t('agents.onlyPicked')}
          hint={
            onlyListed
              ? 'Anything unchecked is not offered to the model at all.'
              : 'Every tool this install has, except the ones you uncheck.'
          }
          checked={onlyListed}
          onCheckedChange={setOnlyListed}
        />

        {tools.isPending && <p className="page__note">{t('agents.loadingTools')}</p>}
        {toolNames.length > 0 && (
          <ul className="stack agent-editor__tools">
            {toolNames.map((tool) => {
              const checked = onlyListed ? allow.includes(tool) : !deny.includes(tool);
              return (
                <li key={tool} className="row agent-editor__tool">
                  <Switch
                    id={`tool-${tool}`}
                    checked={checked}
                    onCheckedChange={(next) => {
                      setToolChecked(tool, next);
                    }}
                  />
                  <label htmlFor={`tool-${tool}`} className="agent-editor__tool-name truncate">
                    {tool}
                  </label>
                  {!registered.has(tool) && (
                    // Named in the config but not registered right now — an MCP
                    // server that is down, or a tool that was removed. It stays
                    // on the list so a save cannot drop it.
                    <Badge tone="warning">not installed</Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <FieldGrid>
          {/* These three are the one place a blank still defers to another
              screen — the global `tools.approvals`, which is a policy for the
              whole install rather than a setting this agent could hold a
              private copy of. */}
          <OptionalSelect
            label={t('agents.runCommands')}
            bound={{
              value: form.approveExec,
              set: (value) => {
                update('approveExec', value);
              },
            }}
            options={APPROVAL_POLICIES}
            unsetLabel="The global policy — Settings → Tools"
          />
          <OptionalSelect
            label={t('agents.reachNetwork')}
            bound={{
              value: form.approveNetwork,
              set: (value) => {
                update('approveNetwork', value);
              },
            }}
            options={APPROVAL_POLICIES}
            unsetLabel="The global policy — Settings → Tools"
          />
          <OptionalSelect
            label={t('agents.writeFiles')}
            bound={{
              value: form.approveWrite,
              set: (value) => {
                update('approveWrite', value);
              },
            }}
            options={APPROVAL_POLICIES}
            unsetLabel="The global policy — Settings → Tools"
          />
        </FieldGrid>
      </Section>

      {/* After the tools, because a profile decides *where* the tools it just
          listed actually run — and before the budget, which is a smaller
          decision. */}
      <Section title={t('agents.toolboxSection')} description={t('agents.toolboxDesc')}>
        {toolboxes.isPending && <p className="page__note">{t('agents.toolboxLoading')}</p>}
        {toolboxes.data?.toolboxes.length === 0 && (
          <p className="page__note">{t('agents.toolboxNoProfiles')}</p>
        )}

        <FieldGrid>
          <SelectField
            label={t('agents.toolboxProfile')}
            // The sentinel is a display concern and never leaves this control:
            // the form's own value for "no toolbox" is and stays the empty string.
            value={form.toolboxName === '' ? NO_TOOLBOX : form.toolboxName}
            onValueChange={(value) => {
              update('toolboxName', value === NO_TOOLBOX ? '' : value);
            }}
            options={toolboxOptions}
          />
          {boxed && (
            <SelectField
              label={t('agents.toolboxNetwork')}
              value={form.toolboxNetworkMode}
              onValueChange={(value) => {
                update('toolboxNetworkMode', value);
              }}
              options={networkOptions}
            />
          )}
        </FieldGrid>

        {/* Only the two states an operator has to act on. A profile that is
            approved and unweakened needs no line of its own. */}
        {chosen?.approved === false && (
          <p className="page__note">{t('agents.toolboxNotApproved')}</p>
        )}
        {chosen !== undefined && chosen.weakened.length > 0 && (
          <p className="page__note">
            {t('agents.toolboxWeakened', { what: chosen.weakened.join(', ') })}
          </p>
        )}

        {boxed && form.toolboxNetworkMode === 'allowlist' && (
          <TextField
            label={t('agents.toolboxAllow')}
            value={form.toolboxAllow}
            onValueChange={(value) => {
              update('toolboxAllow', value);
            }}
            hint={t('agents.toolboxAllowHint')}
          />
        )}
      </Section>

      {/* Below the tools and above the prompt, in plain sight. It sat behind a
          "Show limits" press on the theory that nobody changes a budget twice a
          year — but the numbers are now this agent's own rather than inherited,
          and a setting an operator has to go looking for to find out what it
          says is not one they can be said to have chosen. */}
      <Section title={t('agents.limits')} description={t('agents.limitsDesc')}>
        <FieldGrid>
          <BoundField
            label={t('agents.maxOutputTokens')}
            bound={fields.maxTokens}
            inputMode="numeric"
            error={errors.maxTokens}
          />
          <BoundField
            label={t('agents.contextWindow')}
            bound={fields.contextWindowTokens}
            inputMode="numeric"
            error={errors.contextWindowTokens}
          />
          <BoundField
            label={t('agents.toolTimeout')}
            bound={fields.toolTimeoutSeconds}
            inputMode="numeric"
            error={errors.toolTimeoutSeconds}
            hint="0 disables the limit."
          />
          {isDefault && (
            <TextField
              label={t('agents.maxToolIterations')}
              inputMode="numeric"
              value={base.maxToolIterations}
              error={errors.maxToolIterations}
              onValueChange={(value) => {
                updateBase('maxToolIterations', value);
              }}
            />
          )}
          {isDefault && (
            <TextField
              label={t('agents.turnTimeout')}
              inputMode="numeric"
              value={base.loopWallTimeoutSeconds}
              error={errors.loopWallTimeoutSeconds}
              onValueChange={(value) => {
                updateBase('loopWallTimeoutSeconds', value);
              }}
              hint="0 disables the limit."
            />
          )}
        </FieldGrid>
      </Section>

      <Section title={t('agents.systemPrompt')} description={t('agents.promptDesc')}>
        <div className="cluster agent-editor__prompt-bar">
          <span className="micro-label">
            {promptOwned ? 'This agent’s own prompt' : 'The built-in prompt'}
          </span>
          <span className="spacer" />
          {promptOwned && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPromptOwned(false);
                update('systemPrompt', '');
              }}
            >
              <RotateCcw aria-hidden="true" />
              {t('agents.resetBuiltin')}
            </Button>
          )}
        </div>

        <div className="stack agent-editor__prompt">
          {/* The real editor, not an input. This is the one field here that
              holds prose, and a one-line box is the control that makes people
              write one sentence and stop. */}
          <CodeEditor
            value={promptText}
            readOnly={false}
            language="markdown"
            label={`System prompt for ${name}`}
            onChange={(value) => {
              // The first keystroke is the decision: from here the text is this
              // agent's, including when it is emptied.
              setPromptOwned(true);
              update('systemPrompt', value);
            }}
          />
          <p className="agent-editor__hint">
            {promptOwned
              ? 'Placeholders:'
              : 'Editing this makes it this agent’s own; until then it follows the built-in prompt and improves with each release. Placeholders:'}{' '}
            {PROMPT_PLACEHOLDERS.map((placeholder) => `{{${placeholder}}}`).join(', ')}.
          </p>
          {strayPlaceholders.length > 0 && (
            <p role="alert" className="notice notice--warning">
              <span>
                Nothing will fill{' '}
                {strayPlaceholders.map((placeholder) => `{{${placeholder}}}`).join(', ')} — it will
                appear in the prompt exactly as written.
              </span>
            </p>
          )}
        </div>
      </Section>

      <SaveBar dirty={dirty} saving={saving} onSave={onSave} onRevert={onRevert} />

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={t('agents.deleteTitle')}
        description={`${name} is removed from the settings. Its conversations keep their history and fall back to the default agent.`}
        confirmLabel="Delete"
        pending={saving}
        onConfirm={onDelete}
      />
    </div>
  );
}
