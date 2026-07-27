/**
 * One provider's editable settings.
 *
 * Two fields, and neither can fail validation, so this returns a patch rather
 * than a result — the panel's only failure mode is the server refusing it.
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
  /** Empty means the provider's own default endpoint — see `resolveConnection`. */
  readonly apiBase: string;
  /** One model id per line, as typed. */
  readonly models: string;
}

export function toProviderForm(config: ProviderConfig | undefined): ProviderForm {
  return {
    apiBase: config?.apiBase ?? '',
    models: formatList(config?.models ?? []),
  };
}

export function toProviderPatch(providerId: string, form: ProviderForm): ConfigPatch {
  return {
    providers: {
      [providerId]: {
        // Sent even when empty, and that is what makes the field clearable: an
        // empty `apiBase` is read as "unset" and falls back to the registry's
        // default, where an omitted one would mean "leave whatever is there".
        apiBase: form.apiBase.trim(),
        models: parseList(form.models),
      },
    },
  };
}
