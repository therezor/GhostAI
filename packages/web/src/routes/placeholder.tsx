/**
 * The placeholder every unbuilt panel renders.
 *
 * It names the step that will fill it in, because the alternative — a stub that
 * looks like a feature — is how a half-built settings panel gets reported as a
 * bug against a step that has not started. A placeholder that says which step
 * owns it is a to-do list the application itself carries.
 */

import type { JSX, ReactNode } from 'react';

import { Badge } from '@/components/ui/badge.js';

export function Placeholder({
  title,
  step,
  children,
}: {
  readonly title: string;
  /** The build-plan step that replaces this. */
  readonly step: string;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <div className="stack page page--reading">
      <div className="row">
        <h1 className="page__title">{title}</h1>
        <Badge tone="info">{step}</Badge>
      </div>
      <p className="page__note">{children}</p>
    </div>
  );
}
