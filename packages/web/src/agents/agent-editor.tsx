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
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AgentEntrySchema,
  DEFAULT_AGENT_ID,
  DEFAULT_LIVE_STATE_TEMPLATE,
  DEFAULT_PLATFORM_HOST_TEMPLATE,
  DEFAULT_PLATFORM_TOOLBOX_TEMPLATE,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_TOOLBOX_TEMPLATE,
  DEFAULT_TOOL_POLICY_TEMPLATE,
  DEFAULT_WRAP_UP_TEMPLATE,
  deriveAgentId,
  LIVE_PROMPT_PLACEHOLDERS,
  PLATFORM_PROMPT_PLACEHOLDERS,
  PROMPT_PLACEHOLDERS,
  RAW_PROMPT_PLACEHOLDERS,
  TOOL_POLICY_PLACEHOLDERS,
  TOOLBOX_PROMPT_PLACEHOLDERS,
  type AgentDefaults,
  type AgentEntry,
  type SubagentRef,
  type ToolPermission,
  type ToolPromptOverride,
} from '@ghostai/protocol';

import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu.js';
import { ConfirmDialog } from '@/components/crud/confirm-dialog.js';
import { RowActions } from '@/components/crud/row-actions.js';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/cn.js';
import { queryKeys } from '@/lib/query.js';
import {
  FieldGrid,
  SaveBar,
  Section,
  SelectField,
  SwitchRow,
  TextField,
} from '@/components/form/controls.js';
import { modelOptions } from '@/components/form/fields.js';
import { useSaveSettings, useSettings } from '@/settings/use-settings.js';
import {
  REASONING_EFFORTS,
  UNSET_VALUE,
  toAgentDeletePatch,
  toAgentEntryForm,
  toAgentEntryPatch,
  toAgentForm,
  toDefaultAgentPatch,
  type AgentEntryForm,
  type AgentForm,
} from './agents-form.js';
import { useAgent } from './agent-context.js';
import { SubagentRow } from './subagent-row.js';
import { TemplateEditor } from './template-editor.js';
import { ToolRow, parameterFields } from './tool-row.js';

/**
 * The fields both halves of the form hold as strings under the same name.
 *
 * Intersecting the two keeps `bind` honest: a field that exists on only one of
 * them — `learningEnabled`, `tools` — cannot be bound this way, and trying
 * is a compile error rather than a control that silently edits nothing.
 */
type StringField = {
  [K in keyof AgentForm & keyof AgentEntryForm]: AgentForm[K] extends string
    ? AgentEntryForm[K] extends string
      ? K
      : never
    : never;
}[keyof AgentForm & keyof AgentEntryForm];

/**
 * The same intersection for the switches.
 *
 * `learningEnabled` is on the defaults form only, so it falls out here exactly
 * as it does above — which is the point of writing the constraint twice rather
 * than loosening `StringField` to cover both.
 */
type BooleanField = {
  [K in keyof AgentForm & keyof AgentEntryForm]: AgentForm[K] extends boolean
    ? AgentEntryForm[K] extends boolean
      ? K
      : never
    : never;
}[keyof AgentForm & keyof AgentEntryForm];

/** One field, wherever this agent happens to keep it. */
interface Bound {
  readonly value: string;
  readonly set: (value: string) => void;
}

/** The same, for a field that is on or off. */
interface Toggle {
  readonly checked: boolean;
  readonly set: (checked: boolean) => void;
}

/**
 * A select whose blank is a real answer.
 *
 * `reasoningEffort` unset means the request carries no such parameter — not "no
 * value chosen" — so it may not render as a blank trigger. `unsetLabel` is the
 * sentence that says what the blank does.
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
 * The placeholders whose value differs between two requests in the same turn.
 *
 * Only used to warn a raw template about the prefix cache. In Sections mode
 * these live in the block at the end, which is rebuilt every iteration anyway;
 * one of them in a raw template makes the *whole* prompt uncacheable.
 */
const VOLATILE: readonly string[] = [
  'time',
  'wrapUp',
  'iteration',
  'iterationsLeft',
  'nonce',
  'tag',
  'toolPolicy',
  'runtimeSections',
  'correction',
];

/**
 * The tool pinned to the top of the list.
 *
 * A name rather than a risk band: `exec` is the specific tool that runs a
 * program on the host, and pinning the whole `exec` band would float every
 * toolbox program with it — which is the second list, in its own group, where
 * manifest order is the useful order.
 */
const EXEC_TOOL = 'exec';
/**
 * The dropdown's stand-in for "no toolbox".
 *
 * A `SelectItem` may not carry an empty value — Radix reserves it for "nothing
 * chosen" — so the option that clears the field needs a value of its own. It
 * begins with `-`, which `ToolboxStore.manifestPathFor` refuses in a toolbox
 * name, so no installed toolbox can ever collide with it.
 */
const NO_TOOLBOX = '-none-';

/**
 * Creating an agent, on the page that edits one.
 *
 * The same `Editor`, seeded from the default agent's entry — which is exactly
 * what the dialog it replaced used as its template, only now the operator sees
 * it and can change it *before* anything is written. Nothing reaches the
 * settings tree until Save, so an abandoned create leaves no agent behind.
 */
export function AgentCreateRoute(): JSX.Element {
  const { t } = useTranslation();
  const settings = useSettings();

  if (settings.isPending) return <p className="page__note">{t('agents.loading')}</p>;
  if (settings.isError) {
    return (
      <p role="alert" className="page__error">
        {t('agents.loadDefaultsError', { message: settings.error.message })}
      </p>
    );
  }

  const { config } = settings.data;
  // The template a new agent is stamped from, and the same one `toNewAgentPatch`
  // used: the default agent as it actually stands, not the schema's defaults.
  const template = config.agents.list[DEFAULT_AGENT_ID] ?? AgentEntrySchema.parse({});

  return (
    <Editor
      mode="create"
      agentId=""
      entry={template}
      defaults={config.agents.defaults}
      list={config.agents.list}
    />
  );
}

export function AgentEditorRoute(): JSX.Element {
  const { t } = useTranslation();
  const { agentId } = useParams({ from: '/agents/$agentId' });
  const settings = useSettings();

  if (settings.isPending) return <p className="page__note">{t('agents.loading')}</p>;
  if (settings.isError) {
    return (
      <p role="alert" className="page__error">
        {t('agents.loadOneError', { message: settings.error.message })}
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
          {t('agents.noSuchAgent', { id: agentId })}
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
      mode="edit"
      agentId={agentId}
      entry={entry ?? AgentEntrySchema.parse({})}
      defaults={config.agents.defaults}
      // The whole list, not the `/api/agents` listing: that one omits the
      // disabled agents, and a rename onto a switched-off agent's id is still
      // the collision the server refuses with a 409.
      list={config.agents.list}
    />
  );
}

function Editor({
  mode,
  agentId,
  entry,
  defaults,
  list,
}: {
  /**
   * `create` seeds from the template and POSTs the agent into existence on
   * Save; `edit` loads the stored entry and patches it. It decides three things
   * and nothing else — the seed, what Save does, and whether the edit-only
   * controls render (Delete, and the id box's rename behaviour).
   */
  readonly mode: 'create' | 'edit';
  readonly agentId: string;
  readonly entry: AgentEntry;
  readonly defaults: AgentDefaults;
  readonly list: Readonly<Record<string, AgentEntry>>;
}): JSX.Element {
  const { t } = useTranslation();
  const creating = mode === 'create';
  // A new agent is never the default one, whatever its id box says.
  const isDefault = !creating && agentId === DEFAULT_AGENT_ID;
  const navigate = useNavigate();
  const { agentId: active, select } = useAgent();
  const { save, saving } = useSaveSettings();

  const [form, setForm] = useState<AgentEntryForm>(() => toAgentEntryForm(entry, defaults));
  const [base, setBase] = useState<AgentForm>(() => toAgentForm(defaults));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [dirty, setDirty] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /**
   * The id box, which is an ordinary field even though it is not an ordinary save.
   *
   * Changing it needs its own request: a settings patch could move the key, but
   * it could not say whether that meant "rename" or "delete and create", which
   * differ on whether this agent's conversations and approvals follow. That is a
   * fact about the wire, and it is not a reason to put a second commit button on
   * a screen that already has one: every other box here waits for Save, and one
   * control that did not would be a rule the operator learns by surprise.
   *
   * It also went wrong in a way worth recording. Renaming immediately meant
   * navigating to the new id, which remounts this editor — `key={agentId}` on
   * the route — and every unsaved edit in every other box went with it, silently.
   * One button cannot lose a change it is the one committing.
   */
  const [idDraft, setIdDraft] = useState(agentId);

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

  /** `bind`, for the two model-capability switches. Same split, same reason. */
  const bindToggle = (key: BooleanField): Toggle =>
    isDefault
      ? {
          checked: base[key],
          set: (checked) => {
            updateBase(key, checked);
          },
        }
      : {
          checked: form[key],
          set: (checked) => {
            update(key, checked);
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

  const switches = {
    visionEnabled: bindToggle('visionEnabled'),
    toolsEnabled: bindToggle('toolsEnabled'),
  } satisfies Record<string, Toggle>;

  // ── The prompt ───────────────────────────────────────────────────────────
  //
  // Six templates, one component. Empty means "use the built-in", so each box
  // shows the built-in and typing into it is what makes the wording this
  // agent's own — an operator cannot choose to edit something they have never
  // been shown. See `TemplateEditor` for the three states each one holds.
  //
  // Nothing here is hidden behind a "show advanced" toggle. The point of the
  // feature is that the prompt an install runs on is one an operator can read;
  // a section they have to go looking for is one they will not know exists.
  const raw = form.promptMode === 'raw';

  /** Bumped by a revert, to remount the template editors. See `onRevert`. */
  const [formEpoch, setFormEpoch] = useState(0);

  /**
   * Whether the policy would leave the model unable to identify a tool-output
   * fence. Mirrors `assertBuildable`, so the editor says it before the save
   * rather than the settings response saying it after.
   */
  const namesDelimiter = (template: string): boolean =>
    template.includes('{{nonce}}') || template.includes('{{tag}}');

  // The delimiter has to be named somewhere, not specifically in the policy. The
  // built-in policy names none on purpose — it is prose that never changes, so it
  // caches, and the live-state section supplies the turn's tag. Both templates
  // have to drop it before the model is left unable to identify a fence.
  const policyUnfenced =
    form.toolPolicyPrompt.trim() !== '' &&
    !namesDelimiter(form.toolPolicyPrompt) &&
    !namesDelimiter(form.livePrompt === '' ? DEFAULT_LIVE_STATE_TEMPLATE : form.livePrompt);

  // ── Tools ────────────────────────────────────────────────────────────────
  //
  // One row per tool, one control on it. Enabling a tool and choosing what
  // happens when it runs are the same act — `deny` is the off position — so
  // there is no switch beside the select and no mode toggle above the list.

  /** The programs the chosen toolbox contributes, which get a list of their own. */
  const toolboxToolNames = useMemo(
    () => new Set((chosen?.tools ?? []).map((tool) => tool.name)),
    [chosen],
  );

  /**
   * Every tool this agent could name, registered or not.
   *
   * The union matters because `agents.list.*` is replaced wholesale on save: a
   * list built only from the live registry would silently drop a tool this
   * agent has an opinion about but whose MCP server happens to be down, and
   * that opinion would be gone the next time anything on this screen was saved.
   *
   * The toolbox's own programs are subtracted, because they are in one map with
   * everything else but not in the shared registry — so overriding one put it
   * here as a spurious "not installed" row *and* in the group below, one tool
   * wearing two rows that disagreed about whether it existed.
   */
  const toolNames = useMemo(() => {
    const names = new Set<string>((tools.data?.tools ?? []).map((tool) => tool.name));
    for (const name of Object.keys(form.tools)) {
      if (!toolboxToolNames.has(name)) names.add(name);
    }
    // `exec` first, then A–Z. Alphabetical put the one tool that runs arbitrary
    // programs on this machine second from the top by accident of spelling, and
    // it is the row an operator opens this section to look at. Everything below
    // it reads a file or writes one inside the jail.
    return [...names].sort((a, b) => {
      if (a === EXEC_TOOL) return -1;
      if (b === EXEC_TOOL) return 1;
      return a.localeCompare(b);
    });
  }, [tools.data, form.tools, toolboxToolNames]);

  const registered = useMemo(
    () => new Map((tools.data?.tools ?? []).map((tool) => [tool.name, tool])),
    [tools.data],
  );

  /**
   * Read from the switch rather than from the saved config, so the list greys
   * out as it is flipped rather than a save later. It is the same value the
   * request is built from, which is what lets this section say something true
   * about the next turn instead of about the last one.
   */
  const toolsOff = !switches.toolsEnabled.checked;

  const setToolPermission = (name: string, permission: ToolPermission): void => {
    update('tools', { ...form.tools, [name]: permission });
  };

  const setToolPrompt = (name: string, override: ToolPromptOverride): void => {
    // Kept as typed, blanks and all. `pruneToolPrompts` drops the empty ones on
    // the way to the patch — doing it here instead would delete a row from under
    // the operator the moment they cleared the box to start again.
    update('toolPrompts', { ...form.toolPrompts, [name]: override });
  };

  const setSubagents = (next: readonly SubagentRef[]): void => {
    update('subagents', next);
  };

  const setSubagent = (index: number, next: SubagentRef): void => {
    setSubagents(form.subagents.map((ref, at) => (at === index ? next : ref)));
  };

  /**
   * The agents this one could delegate to.
   *
   * Everything `GET /api/agents` returns except this agent, which is refused at
   * save as a self-reference. Disabled agents are already absent — `listAgents`
   * skips them — which is the same set `assertBuildable` will accept.
   */
  const delegable = useMemo(
    () => (agents.data?.agents ?? []).filter((agent) => agent.id !== agentId),
    [agents.data, agentId],
  );

  const chosenSubagents = useMemo(
    () => new Set(form.subagents.map((ref) => ref.id)),
    [form.subagents],
  );

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

  /**
   * What the id box would actually produce, and why it might not be allowed.
   *
   * Slugified rather than validated-as-typed: the box accepts a label's worth of
   * typing and the hint below it says what that becomes, which is the same
   * bargain the create dialog makes. `''` means the box holds nothing usable,
   * which is only an error once it differs from the id the agent already has.
   */
  // While creating, an untouched id box follows the name — the same bargain the
  // dialog this replaced made, and what the workspace create page does with its
  // folder. Typing in the box takes it over.
  const idSource = creating && idDraft.trim() === '' ? form.label : idDraft;
  const proposedId = idSource.trim() === '' ? '' : deriveAgentId(idSource);
  // Creating is never renaming: there is no old id for the new one to move
  // away from, so the same box means "what this will be called" instead.
  const renaming = !creating && !isDefault && proposedId !== '' && proposedId !== agentId;

  const idError = ((): string | undefined => {
    if (creating) {
      if (proposedId === '') return t('agents.idEmpty');
      return list[proposedId] === undefined ? undefined : t('agents.idTaken', { id: proposedId });
    }
    if (isDefault || idDraft.trim() === agentId) return undefined;
    if (proposedId === '') return t('agents.idEmpty');
    // Checked against the settings tree rather than the agent listing, which
    // omits the disabled ones — colliding with an agent that is merely switched
    // off is still a collision, and the server would refuse it with a 409.
    if (proposedId !== agentId && list[proposedId] !== undefined) {
      return t('agents.idTaken', { id: proposedId });
    }
    return undefined;
  })();

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
    // The id is settled first, because everything below is addressed *to* an id
    // and the patch has to name the one the entry will be under by the time it
    // arrives. A failed rename must therefore leave the settings untouched
    // rather than half-applied to a key that no longer exists.
    if (idError !== undefined) {
      setErrors({ agentId: idError });
      return;
    }

    const target = creating || renaming ? proposedId : agentId;
    const result = isDefault
      ? toDefaultAgentPatch(base, form, entry, t)
      : toAgentEntryPatch(target, form, entry, t);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});

    if (creating) {
      // The first write this page makes. On success, not on the press — the
      // editor it navigates to reads the settings cache, and arriving before
      // the write lands is the "There is no agent called…" path.
      save(result.patch, {
        onSuccess: () => {
          void navigate({ to: '/agents/$agentId', params: { agentId: target } });
        },
      });
      setDirty(false);
      return;
    }

    // One request, patch and rename together. As two it was two writes with a
    // window between them: the rename could land and the patch fail, leaving the
    // agent under its new name holding its old settings.
    //
    // No invalidation on this line: `useSaveSettings` refreshes the agents query
    // once the write has landed, and doing it here fired it *before* the PATCH
    // resolved — the refetch answered from the old config and a renamed label
    // never reached the composer's picker.
    save(
      renaming
        ? { ...result.patch, renameAgents: [{ from: agentId, to: proposedId }] }
        : result.patch,
      renaming
        ? {
            // Only once the write has landed and the cache holds it. Navigating
            // first lands the editor on an id the settings tree does not have
            // yet, which is the race that used to say "There is no agent called…".
            onSuccess: () => {
              // This browser's remembered choice is the one reference the server
              // cannot reach, and nothing else fixes it: the picker only resets
              // an id that names *nothing*, and this one now names the renamed
              // agent.
              if (active === agentId) select(proposedId);
              void navigate({ to: '/agents/$agentId', params: { agentId: proposedId } });
            },
          }
        : {},
    );
    setDirty(false);
  };

  const onRevert = (): void => {
    setForm(toAgentEntryForm(entry, defaults));
    setBase(toAgentForm(defaults));
    setIdDraft(agentId);
    // Remounts every `TemplateEditor`, which is what re-derives "does this agent
    // own this template" from the stored value. Without it a revert leaves each
    // box holding the stored (empty) template while still claiming the agent
    // owns one — the state is deliberately not derived from the value, so
    // nothing else would reset it.
    setFormEpoch((epoch) => epoch + 1);
    setErrors({});
    setDirty(false);
  };

  const name = form.label === '' ? (creating ? t('agents.newTitle') : agentId) : form.label;

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
              would destroy, and it used to fire without asking. Absent while
              creating: there is nothing yet to delete. */}
          {!isDefault && !creating && (
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
          {/* A switched-off agent is absent from `/api/agents` just as a
              deleted one is, so `resolved` being undefined cannot on its own
              mean "no model". Asked in this order, the disabled case answers
              for itself and the model line is only reached by an agent that
              could actually run — otherwise a disabled agent was told it had
              no model, and choosing one would not have helped. */}
          {isDefault
            ? 'Every session that names no agent runs on this one, and a new agent starts as a copy of it.'
            : !form.enabled
              ? 'Switched off: it cannot take a turn, and it is hidden from the picker. Its settings and its sessions are kept.'
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
            hint={t('agents.labelHint', { token: '{{name}}' })}
          />
          {!isDefault && (
            <TextField
              label={t('agents.idLabel')}
              value={idDraft}
              {...(creating ? { placeholder: proposedId } : {})}
              onValueChange={(value) => {
                setIdDraft(value);
                setDirty(true);
              }}
              {...(errors.agentId === undefined || creating ? {} : { error: errors.agentId })}
              hint={
                // Creating shows what the id *will be* as it is typed, and says
                // so inline rather than as an error — a name that collides is a
                // thing to fix, not a failure that has happened.
                creating
                  ? (idError ?? t('agents.idCreatePreview', { id: proposedId }))
                  : renaming
                    ? t('agents.idPreview', { id: proposedId })
                    : t('agents.idHint')
              }
            />
          )}
          {!isDefault && (
            <SwitchRow
              label={t('agents.enabled')}
              hint={t('agents.enabledHint')}
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
            hint={t('agents.temperatureHint')}
          />
          <OptionalSelect
            label={t('agents.reasoningEffort')}
            bound={fields.reasoningEffort}
            options={REASONING_EFFORTS}
            unsetLabel="The provider’s own"
          />
          {/* Below the model rather than beside the toolset, because that is
              what they are about: what this model can be asked to do, not what
              this agent is allowed to do. Both default on, so an operator only
              comes here once they have met a model that cannot keep up. */}
          <SwitchRow
            label={t('agents.vision')}
            hint={t('agents.visionHint')}
            checked={switches.visionEnabled.checked}
            onCheckedChange={switches.visionEnabled.set}
          />
          <SwitchRow
            label={t('agents.toolsEnabled')}
            hint={t('agents.toolsEnabledHint')}
            checked={switches.toolsEnabled.checked}
            onCheckedChange={switches.toolsEnabled.set}
          />
        </FieldGrid>
      </Section>

      <Section title={t('agents.toolsSection')} description={t('agents.toolsDesc')}>
        {tools.isPending && <p className="page__note">{t('agents.loadingTools')}</p>}
        {/* Shown above the list rather than in place of it. The rows say what
            this agent is configured to do, and that is still true and still
            saved — what has changed is only that this model is not being told
            about any of it. Emptying the list would read as the config being
            gone, which is the one thing the switch must not do. */}
        {toolsOff && <p className="page__note page__warning">{t('agents.toolsOffNote')}</p>}
        {toolNames.length > 0 && (
          <ul className={cn('stack agent-editor__tools', toolsOff && 'agent-editor__tools--off')}>
            {toolNames.map((name) => {
              const tool = registered.get(name);
              return (
                <ToolRow
                  key={name}
                  name={name}
                  detail={tool?.description ?? ''}
                  risk={tool?.risk}
                  permission={form.tools[name] ?? 'deny'}
                  fields={tool === undefined ? [] : parameterFields(tool.parameters)}
                  override={form.toolPrompts[name]}
                  disabled={toolsOff}
                  onChange={(next) => {
                    setToolPermission(name, next);
                  }}
                  onOverrideChange={(next) => {
                    setToolPrompt(name, next);
                  }}
                />
              );
            })}
          </ul>
        )}

        {/* Only when the box exposes callables. A `prompt` toolbox's programs
            are reached through `exec`, so `exec`'s permission is already
            theirs and a second set of rows would be a lie. */}
        {chosen?.exposesTools === true && chosen.tools.length > 0 && (
          <>
            <h3 className="agent-editor__tool-group">
              {t('agents.toolboxToolsGroup', { name: chosen.label || chosen.name })}
            </h3>
            <ul className={cn('stack agent-editor__tools', toolsOff && 'agent-editor__tools--off')}>
              {chosen.tools.map((tool) => (
                <ToolRow
                  key={tool.name}
                  name={tool.name}
                  detail={tool.use}
                  risk="exec"
                  disabled={toolsOff}
                  // The manifest's default until this agent overrides it. It is
                  // a suggestion from the box's author, not a ceiling — the
                  // programs are reachable through `exec` either way.
                  permission={form.tools[tool.name] ?? tool.permission}
                  // A toolbox program's schema is synthesised from the manifest
                  // and is not in `GET /api/tools`, so there are no argument
                  // boxes to offer — only the description, which is the part the
                  // manifest author wrote and this agent may disagree with.
                  fields={[]}
                  override={form.toolPrompts[tool.name]}
                  onChange={(next) => {
                    setToolPermission(tool.name, next);
                  }}
                  onOverrideChange={(next) => {
                    setToolPrompt(tool.name, next);
                  }}
                />
              ))}
            </ul>
          </>
        )}
      </Section>

      {/* After the tools, because delegating *is* a tool from the model's side —
          one per subagent, named after it — and an operator reading down the
          page has just decided what this agent may do on its own. */}
      <Section title={t('agents.subagentsSection')} description={t('agents.subagentsDesc')}>
        {delegable.length === 0 ? (
          <p className="page__note">{t('agents.subagentsNoneAvailable')}</p>
        ) : (
          <>
            {form.subagents.length === 0 && (
              <p className="page__note">{t('agents.subagentsEmpty')}</p>
            )}

            <ul className="stack agent-editor__subagents">
              {form.subagents.map((ref, index) => (
                <SubagentRow
                  // By position, not by id: a row the operator has not filled in
                  // yet has no id, and two of them would collide on `''` — which
                  // React resolves by reusing one input for both.
                  key={index}
                  ref_={ref}
                  index={index}
                  // The agent itself is never offered, and neither is one already
                  // chosen — both are refused at save, and a picker that offers
                  // what the save refuses teaches the wrong thing.
                  options={delegable.filter(
                    (agent) => agent.id === ref.id || !chosenSubagents.has(agent.id),
                  )}
                  onChange={(next) => {
                    setSubagent(index, next);
                  }}
                  onRemove={() => {
                    setSubagents(form.subagents.filter((_unused, at) => at !== index));
                  }}
                />
              ))}
            </ul>

            <Button
              variant="secondary"
              disabled={form.subagents.length >= delegable.length}
              onClick={() => {
                setSubagents([...form.subagents, { id: '', prompt: '', permission: 'allow' }]);
              }}
            >
              <Plus aria-hidden="true" />
              {t('agents.subagentAdd')}
            </Button>
          </>
        )}
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
            hint={t('agents.zeroDisablesHint')}
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
              hint={t('agents.zeroDisablesHint')}
            />
          )}
        </FieldGrid>
      </Section>

      <Section title={t('agents.systemPrompt')} description={t('agents.promptDesc')}>
        <div className="stack agent-editor__prompt">
          <TemplateEditor
            key={`${String(formEpoch)}-system`}
            name={name}
            label="agents.promptSystem"
            builtIn={DEFAULT_SYSTEM_PROMPT_TEMPLATE}
            value={form.systemPrompt}
            placeholders={raw ? RAW_PROMPT_PLACEHOLDERS : PROMPT_PLACEHOLDERS}
            removable={false}
            hint={raw ? 'agents.promptSystemRawHint' : 'agents.promptSystemHint'}
            {...(raw && VOLATILE.some((hole) => form.systemPrompt.includes(`{{${hole}}}`))
              ? {
                  // Not an error: a clock in the prompt is a legitimate thing to
                  // want. It is a price, and one an operator cannot see on the
                  // bill, so it is said here instead.
                  warning: t('agents.promptUncacheable'),
                }
              : {})}
            onChange={(next) => {
              update('systemPrompt', next);
            }}
          />

          {/* A disclosure, not a second mode picker. The sections below are the
              rest of the prompt, and an operator who has not gone looking for
              them should not have to answer a question about them first — the
              old "Assembly: Sections / Raw" select made a rare decision the
              opening move of an ordinary screen.

              `<details>` rather than a button and state: it is what the element
              is for, and the keyboard behaviour and `aria-expanded` come out
              correct without being written. */}
          <details className="agent-editor__advanced">
            <summary>{t('agents.promptAdvanced')}</summary>
            <div className="stack agent-editor__advanced-body">
              {/* Phrased as what it does rather than as a mode with a name. An
                  operator reaching for this wants "stop adding things to my
                  prompt", which is a behaviour; `raw` is our word for it. */}
              <SwitchRow
                label={t('agents.promptOnlySystem')}
                hint={t('agents.promptOnlySystemHint')}
                checked={raw}
                onCheckedChange={(next) => {
                  update('promptMode', next ? 'raw' : 'template');
                }}
              />

              {/* Hidden rather than disabled: nothing places them, so a box that
                  still edited one would be a control with no effect on screen.
                  The stored values survive — switching back restores them. */}
              {!raw && (
                <>
                  <TemplateEditor
                    key={`${String(formEpoch)}-live`}
                    name={name}
                    label="agents.promptLive"
                    builtIn={DEFAULT_LIVE_STATE_TEMPLATE}
                    value={form.livePrompt}
                    placeholders={LIVE_PROMPT_PLACEHOLDERS}
                    hint="agents.promptLiveHint"
                    onChange={(next) => {
                      update('livePrompt', next);
                    }}
                  />
                  <TemplateEditor
                    key={`${String(formEpoch)}-wrapup`}
                    name={name}
                    label="agents.promptWrapUp"
                    builtIn={DEFAULT_WRAP_UP_TEMPLATE}
                    value={form.wrapUpPrompt}
                    placeholders={['iterationsLeft']}
                    hint="agents.promptWrapUpHint"
                    onChange={(next) => {
                      update('wrapUpPrompt', next);
                    }}
                  />
                  <TemplateEditor
                    key={`${String(formEpoch)}-platform`}
                    name={name}
                    label="agents.promptPlatform"
                    builtIn={
                      form.toolboxName.trim() === ''
                        ? DEFAULT_PLATFORM_HOST_TEMPLATE
                        : DEFAULT_PLATFORM_TOOLBOX_TEMPLATE
                    }
                    value={form.platformPrompt}
                    placeholders={PLATFORM_PROMPT_PLACEHOLDERS}
                    hint="agents.promptPlatformHint"
                    // Tool-shaped like the two below it: every line it renders
                    // describes running a command, and the file tools it names
                    // are tools too. With none of them there is nothing left for
                    // the section to be about.
                    {...(toolsOff ? { warning: t('agents.promptNotPlacedNoTools') } : {})}
                    onChange={(next) => {
                      update('platformPrompt', next);
                    }}
                  />
                  {form.toolboxName.trim() !== '' && (
                    <TemplateEditor
                      key={`${String(formEpoch)}-toolbox`}
                      name={name}
                      label="agents.promptToolbox"
                      builtIn={DEFAULT_TOOLBOX_TEMPLATE}
                      value={form.toolboxPrompt}
                      placeholders={TOOLBOX_PROMPT_PLACEHOLDERS}
                      hint="agents.promptToolboxHint"
                      // Left editable rather than disabled: the wording is worth
                      // writing before the model that can use it is chosen, and
                      // a box that refuses keystrokes cannot say why as clearly
                      // as a line that says it is not being placed.
                      {...(toolsOff ? { warning: t('agents.promptNotPlacedNoTools') } : {})}
                      onChange={(next) => {
                        update('toolboxPrompt', next);
                      }}
                    />
                  )}
                  <TemplateEditor
                    key={`${String(formEpoch)}-policy`}
                    name={name}
                    label="agents.promptToolPolicy"
                    builtIn={DEFAULT_TOOL_POLICY_TEMPLATE}
                    value={form.toolPolicyPrompt}
                    placeholders={TOOL_POLICY_PLACEHOLDERS}
                    hint="agents.promptToolPolicyHint"
                    // Ahead of the two delimiter warnings, and it replaces them:
                    // neither says anything while the section is not placed, and
                    // a box carrying three lines about a prompt nothing sends is
                    // three chances to act on the wrong one.
                    {...(toolsOff
                      ? { warning: t('agents.promptNotPlacedNoTools') }
                      : policyUnfenced
                        ? {
                            warning: t('agents.promptToolPolicyUnfenced', {
                              // Passed rather than written into the bundle: i18next
                              // does not rescan an interpolated value, which is the
                              // only way a literal `{{…}}` survives to the screen.
                              tag: '{{tag}}',
                              nonce: '{{nonce}}',
                            }),
                          }
                        : namesDelimiter(form.toolPolicyPrompt)
                          ? {
                              // Naming the tag here is legal and costs the cache:
                              // this section is otherwise identical for the life of
                              // a session, so it rides the cached prefix — unless it
                              // spells out a delimiter that changes every turn, at
                              // which point the whole of it is re-sent per step.
                              warning: t('agents.promptToolPolicyUncacheable', { tag: '{{tag}}' }),
                            }
                          : {})}
                    onChange={(next) => {
                      update('toolPolicyPrompt', next);
                    }}
                  />
                </>
              )}
            </div>
          </details>
        </div>
      </Section>

      <SaveBar dirty={dirty} saving={saving} onSave={onSave} onRevert={onRevert} />

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={t('agents.deleteTitle')}
        description={`${name} is removed from the settings. Its sessions keep their history and fall back to the default agent.`}
        confirmLabel="Delete"
        pending={saving}
        onConfirm={onDelete}
      />
    </div>
  );
}
