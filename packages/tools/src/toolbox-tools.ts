/**
 * A toolbox's programs, as tools the model can call directly.
 *
 * The default is not this. A toolbox advertises itself in one prompt section —
 * forty tokens for a box of two hundred programs, because the model already
 * knows what `curl` and `nmap` are. That is the right trade for a model that
 * reads its instructions.
 *
 * Not every model does. A model attends to its **tool schemas** far more closely
 * than to prose claiming it has capabilities — schemas are what function-calling
 * fine-tuning is *made of*, and prose about the environment is not. Small models
 * especially will read a paragraph saying "you can search the web", read a tool
 * list containing only `read_file` and `exec`, and answer from the list: "the
 * available tools only let me interact with files." Observed, repeatedly, from a
 * model holding a working search tool.
 *
 * So `expose: 'tools'` materialises each declared entry as a real callable with
 * its own name and description. `ddgr` sits beside `read_file` in the list the
 * provider is sent, and a model that ignores prose cannot ignore it.
 *
 * The cost is real and is why this is opt-in per toolbox: roughly 60–80 tokens
 * per entry, on every request of every turn. Seven entries is ~500 tokens
 * against the ~40 the prompt section costs. Worth it for a model that needs it;
 * waste for one that does not.
 *
 * **Every generated tool runs through `guardExec` and the same runner as `exec`.**
 * There is no second execution path: the tool is a *spelling* of `exec` with the
 * program fixed, so the binary allow-list, the argv contract, the output cap and
 * the container all apply unchanged. A toolbox cannot grant reach by declaring
 * an entry — it can only make reach the agent already had easier to find.
 */

import { guardExec } from '@ghostai/security';
import type { Toolbox, ToolboxEntry, ToolPermission } from '@ghostai/protocol';
import { z } from 'zod';

import {
  TOOL_NAME_PATTERN,
  assertNotAborted,
  defineTool,
  type AnyTool,
} from './define.js';
import { coerceArgv } from './argv.js';
import { localRunner } from './runner.js';
import { renderRun } from './builtin/exec.js';

/**
 * The `args` field, described in this entry's own words.
 *
 * A schema per entry rather than one shared schema, because the description is
 * where the guidance has to land: it is the text a model is looking at while it
 * decides what to put in the field. A generic "arguments as separate strings"
 * says nothing about the flag this program insists on.
 */
function argsSchema(entry: ToolboxEntry): z.ZodType<string[]> {
  const parts = [
    entry.args === '' ? 'Arguments as separate strings.' : entry.args,
    'The program name is already supplied — do not repeat it.',
  ];
  if (entry.example.length > 0) {
    parts.push(`Example: ${JSON.stringify(entry.example)}`);
  }
  const description = parts.join(' ');

  // Always present, never defaulted — even for a program that takes none, where
  // the answer is `[]`. An optional field is one more thing for the model to
  // reason about, and "required, and sometimes empty" is a simpler contract than
  // "omit it unless you need it". It also keeps the schema's type uniform, which
  // a `.default()` on one branch would not.
  const array = z.array(z.string());

  // A program that does nothing without an argument refuses an empty call in the
  // schema, where the model gets a validation message it can act on rather than
  // a usage error from the program and a dead end it gives up at.
  const bounded = entry.requiresArgs ? array.min(1) : array;

  // **Coerced before validation, not instead of it.** The advertised type stays
  // `string[]` — that is what the description asks for and what a capable model
  // sends — and a model that sends a string gets what it evidently meant rather
  // than a refusal it will answer with another broken string. See `coerceArgv`
  // for the shapes this has to survive.
  return z.preprocess(coerceArgv, bounded).describe(description);
}

/**
 * One declared entry as a callable tool.
 *
 * `undefined` for a name no provider would accept. A manifest is data, and a
 * program called `foo bar` or `../sh` would be rejected mid-turn as a provider
 * 400 that reads like the model is broken — so it is dropped here, where the
 * install review can say so, rather than advertised and refused later.
 */
export function toolboxTool(
  toolbox: Toolbox,
  entry: ToolboxEntry,
): AnyTool | undefined {
  if (!TOOL_NAME_PATTERN.test(entry.name)) return undefined;

  // `use` alone. The toolbox is named once in the prompt section rather than
  // repeated in every one of these descriptions — that boilerplate is ~8 tokens
  // times the number of entries, on every request of every turn, to say
  // something the model was already told.
  const description = entry.use === '' ? `Run \`${entry.name}\`.` : entry.use;

  return defineTool({
    name: entry.name,
    description,
    schema: z.strictObject({ args: argsSchema(entry) }),
    // The same band as `exec`, because it *is* `exec`. A toolbox entry that
    // claimed a gentler risk would be an approval prompt an operator configured
    // and then silently stopped seeing.
    risk: 'exec',
    annotations: {
      title: `Run ${entry.name}`,
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    async execute(args, context) {
      assertNotAborted(context.signal, entry.name);

      const argv = [entry.name, ...args.args];
      const plan = guardExec(argv, {
        jail: context.jail,
        config: context.config.exec,
        ...(context.env === undefined ? {} : { env: context.env }),
        ...(context.sandboxed === undefined
          ? {}
          : { sandboxed: context.sandboxed }),
      });

      const outcome = await (context.runner ?? localRunner).run({
        plan,
        timeoutMs: plan.timeoutMs,
        signal: context.signal,
        ...(context.clock === undefined ? {} : { clock: context.clock }),
      });
      return renderRun(argv, plan, outcome);
    },
  });
}

/** Every entry a toolbox declares, as callables. Empty unless `expose: 'tools'`. */
export function toolboxTools(toolbox: Toolbox): readonly AnyTool[] {
  if (toolbox.expose !== 'tools') return [];
  const tools: AnyTool[] = [];
  for (const entry of toolbox.tools) {
    const tool = toolboxTool(toolbox, entry);
    if (tool !== undefined) tools.push(tool);
  }
  return tools;
}

/**
 * What the manifest says each of those callables may do.
 *
 * The *defaults* an agent's own `tools` map is laid over, not a ceiling — see
 * `ToolboxEntrySchema.permission`. Derived from `toolboxTools` rather than from
 * `toolbox.tools` so the two cannot disagree: an entry whose name no provider
 * would accept is dropped from the callables, and a permission for a tool that
 * does not exist would read in the settings UI as a row nothing can call.
 */
export function toolboxPermissions(
  toolbox: Toolbox,
): Record<string, ToolPermission> {
  const permissions: Record<string, ToolPermission> = {};
  if (toolbox.expose !== 'tools') return permissions;
  for (const entry of toolbox.tools) {
    if (!TOOL_NAME_PATTERN.test(entry.name)) continue;
    permissions[entry.name] = entry.permission;
  }
  return permissions;
}
