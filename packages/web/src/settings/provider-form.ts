/**
 * One provider instance's editable settings.
 *
 * An *instance*, not a provider: the panel now lists endpoints an operator
 * created, so this module gained the two fields that make one endpoint distinct
 * from another of the same type — its label and whether it is on — and a `type`
 * that is written when the instance is created and never edited afterwards.
 * Changing an endpoint's protocol is not an edit, it is a different endpoint.
 *
 * Nothing here can fail validation, so these return patches rather than results
 * — the panel's only failure mode is the server refusing one.
 *
 * What is *not* here is the API key, and that is the design. A key is not part
 * of the settings tree: it goes to `PUT /api/settings/credentials`, into the
 * vault, and never comes back out. Keeping it out of this module is what makes
 * "no response anywhere carries a credential" a property of the shape of the
 * code rather than of remembering.
 *
 * `extraHeaders` is not here either, for a different reason: it is one of the
 * records `mergeConfigPatch` replaces wholesale, and a patch that omits it
 * leaves it untouched. Editing it needs a control that can express removal,
 * which is a panel of its own rather than a text field bolted to this one.
 */

import type { ConfigPatch, ProviderConfig } from '@ghostai/protocol';

import { formatList, parseList } from './fields.js';

export interface ProviderForm {
  /** Blank falls back to the provider type's own display name. */
  readonly label: string;
  /** Empty means the provider's own default endpoint — see `resolveConnection`. */
  readonly apiBase: string;
  /** One model id per line, as typed. */
  readonly models: string;
  readonly enabled: boolean;
}

export function toProviderForm(config: ProviderConfig | undefined): ProviderForm {
  return {
    label: config?.label ?? '',
    apiBase: config?.apiBase ?? '',
    models: formatList(config?.models ?? []),
    enabled: config?.enabled ?? true,
  };
}

export function toProviderPatch(instanceId: string, form: ProviderForm): ConfigPatch {
  return {
    providers: {
      [instanceId]: {
        label: form.label.trim(),
        // Sent even when empty, and that is what makes the field clearable: an
        // empty `apiBase` is read as "unset" and falls back to the registry's
        // default, where an omitted one would mean "leave whatever is there".
        apiBase: form.apiBase.trim(),
        models: parseList(form.models),
        enabled: form.enabled,
      },
    },
  };
}

/**
 * A patch that creates an instance.
 *
 * `type` appears here and in no other patch: it is what the merged tree is
 * validated against, and an instance that could change its type would be a
 * different endpoint wearing the same credential.
 */
export function toCreateProviderPatch(
  instanceId: string,
  type: string,
  label: string,
): ConfigPatch {
  return { providers: { [instanceId]: { type, label: label.trim(), enabled: true } } };
}

/**
 * A patch that removes one.
 *
 * `null` is the only token available: the merge treats an absent key as "not
 * mentioned", so without this there would be no way to take back a provider an
 * operator added. The server also drops the instance's vault entry, because
 * the config is only half of an endpoint.
 */
export function toDeleteProviderPatch(instanceId: string): ConfigPatch {
  return { providers: { [instanceId]: null } };
}
