/**
 * Models, as rows.
 *
 * The list is whatever the endpoints themselves answered — every
 * OpenAI-compatible server publishes `GET /models`, which is most of them and
 * all the local ones — so this is a real catalogue rather than a hardcoded one
 * that goes stale the week after it ships.
 *
 * A provider that could not be reached is not an error here. It goes in
 * `ModelsResponse.errors`, and the caller says which endpoint went quiet before
 * opening the picker on the ones that answered — the alternative is a silently
 * shorter list, which reads as "that model is gone" rather than "that laptop is
 * shut".
 */

import type { ModelsResponse } from '@ghostai/protocol';
import type { SelectItem } from '@ghostai/tui';

import type { CliT } from '../i18n.js';
import type { Menu } from '../menu.js';

export interface ModelPickerDeps {
  readonly menu: Menu;
  readonly catalogue: ModelsResponse;
  /** The model a turn would use right now. */
  readonly current: string;
  readonly t: CliT;
}

export function modelItems(
  catalogue: ModelsResponse,
  current: string,
  t: CliT,
): Array<SelectItem<string>> {
  return catalogue.models.map((model) => {
    const where = model.providerId;
    return {
      value: model.id,
      label: model.displayName ?? model.id,
      hint: model.id === current ? `${where} · ${t('menu.current')}` : where,
      // The id is not always the label, and it is what an operator types.
      keywords: model.id,
    };
  });
}

/** The listing, for a terminal that cannot draw a menu. */
export function modelListing(
  catalogue: ModelsResponse,
  current: string,
): string {
  return catalogue.models
    .map(
      (model) =>
        `${model.id === current ? '*' : ' '} ${model.id}  ·  ${model.providerId}`,
    )
    .join('\n');
}

/** Every endpoint that did not answer, one line each. */
export function modelErrors(catalogue: ModelsResponse, t: CliT): string[] {
  return Object.entries(catalogue.errors).map(([id, message]) =>
    t('slash.notes.providerQuiet', { id, message }),
  );
}

export async function pickModel(
  deps: ModelPickerDeps,
): Promise<string | undefined> {
  const items = modelItems(deps.catalogue, deps.current, deps.t);
  const at = items.findIndex((item) => item.value === deps.current);

  return await deps.menu.choose({
    items,
    labels: {
      title: deps.t('menu.titles.model'),
      empty: deps.t('menu.empty'),
      footer: deps.t('menu.footer'),
    },
    ...(at < 0 ? {} : { index: at }),
  });
}
