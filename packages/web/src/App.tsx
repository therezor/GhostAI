/**
 * The token swatch grid — the whole UI, for now.
 *
 * It is the page Step 15 is done against: every token rendered at the size it
 * will be used, in both themes, so a seed change is something you can look at
 * rather than something you find out about in the chat view three steps later.
 * It is also a gate target: it is written in the same Tailwind utilities every
 * later component will use, so if a token were unreachable without a raw colour
 * or a `px`, this page would be the first thing to fail.
 *
 * Step 16 replaces it with the app shell. Nothing here is a primitive — the
 * buttons below are three `<button>` elements, not a Button component, because
 * a recipe written before the shell exists is a recipe written twice.
 */

import type { JSX, ReactNode } from 'react';

import { useTheme } from './theme/use-theme.js';
import type { ThemePreference } from './theme/theme.js';

const SURFACES = ['surface-0', 'surface-1', 'surface-2', 'surface-3'] as const;
const TEXT = ['fg-1', 'fg-2', 'fg-3'] as const;
const OVERLAYS = ['hover', 'active', 'line', 'line-strong'] as const;
const ROLES = ['accent', 'success', 'warning', 'danger', 'info'] as const;
const SIZES = ['2xs', 'xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl'] as const;
const RADII = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'] as const;
const SHADOWS = ['xs', 'sm', 'md', 'lg'] as const;
const PREFERENCES: readonly ThemePreference[] = ['dark', 'light', 'system'];

export function App(): JSX.Element {
  return (
    <div className="min-h-dvh bg-surface-0 text-fg-1">
      <div className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-10">
        <Header />
        <Section title="Surfaces" hint="An even OKLCH ramp: page, sunken, card, elevated.">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {SURFACES.map((name) => (
              <div
                key={name}
                className="flex h-24 flex-col justify-end rounded-lg border border-line p-3"
                style={{ backgroundColor: `var(--color-${name})` }}
              >
                <Label>{name}</Label>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Text" hint="Every tier meets WCAG AA on every surface, in both themes.">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            {SURFACES.map((surface) => (
              <div
                key={surface}
                className="flex flex-col gap-1 rounded-lg border border-line p-3"
                style={{ backgroundColor: `var(--color-${surface})` }}
              >
                {TEXT.map((tier) => (
                  <p key={tier} className="text-sm" style={{ color: `var(--color-${tier})` }}>
                    {tier} on {surface}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Overlays"
          hint="Alpha fills, not ramp stops — they lighten in dark and darken in light."
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {OVERLAYS.map((name) => (
              <div key={name} className="rounded-lg bg-surface-2 p-3">
                <div
                  className="mb-2 h-12 rounded-md"
                  style={{ backgroundColor: `var(--color-${name})` }}
                />
                <Label>{name}</Label>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Roles"
          hint="Fill, text, and the soft fill behind a badge. Text never uses the fill token."
        >
          <div className="flex flex-col gap-3">
            {ROLES.map((role) => (
              <div key={role} className="flex flex-wrap items-center gap-3">
                <span
                  className="inline-flex h-9 w-24 items-center justify-center rounded-md text-sm font-medium text-on-fill"
                  style={{ backgroundColor: `var(--color-${role})` }}
                >
                  {role}
                </span>
                <span
                  className="inline-flex h-9 items-center rounded-md px-3 text-sm"
                  style={{
                    backgroundColor: `var(--color-${role}-soft)`,
                    color: `var(--color-${role}-fg)`,
                  }}
                >
                  {role}-soft
                </span>
                <span className="text-sm" style={{ color: `var(--color-${role}-fg)` }}>
                  {role}-fg on the page
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Type" hint="rem throughout; the root font size is never overridden.">
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-4">
            {/* Inline vars rather than `text-${size}`: Tailwind scans source text
                for class names, so a template literal produces a class nobody
                generated. Every swatch here is driven by the token directly. */}
            {SIZES.map((size) => (
              <p
                key={size}
                style={{
                  fontSize: `var(--text-${size})`,
                  lineHeight: `var(--text-${size}--line-height)`,
                }}
              >
                <span className="text-fg-3">text-{size}</span> — The quick brown fox jumps over the
                lazy dog
              </p>
            ))}
            <p className="font-mono text-sm text-fg-2">
              font-mono — const nonce = randomUUID(); // 0O1lI!=
            </p>
          </div>
        </Section>

        <Section title="Radius and elevation">
          <div className="flex flex-wrap gap-4">
            {RADII.map((radius) => (
              <div key={radius} className="flex flex-col items-center gap-2">
                <div
                  className="size-16 border border-line bg-surface-3"
                  style={{ borderRadius: `var(--radius-${radius})` }}
                />
                <Label>{radius}</Label>
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-6">
            {SHADOWS.map((shadow) => (
              <div key={shadow} className="flex flex-col items-center gap-2">
                <div
                  className="size-16 rounded-lg bg-surface-3"
                  style={{ boxShadow: `var(--shadow-${shadow})` }}
                />
                <Label>{shadow}</Label>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Focus" hint="Tab through these. The ring is the base layer's, not theirs.">
          <div className="flex flex-wrap gap-3">
            <button type="button" className="rounded-md bg-accent px-4 py-2 text-sm text-on-fill">
              Primary
            </button>
            <button
              type="button"
              className="rounded-md border border-line-strong px-4 py-2 text-sm hover:bg-hover"
            >
              Secondary
            </button>
            <a href="#top" className="rounded-md px-4 py-2 text-sm text-accent-fg underline">
              A link
            </a>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Header(): JSX.Element {
  const { preference, resolved, setPreference } = useTheme();

  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
      <div>
        <h1 className="text-2xl font-semibold">GhostAI tokens</h1>
        <p className="text-sm text-fg-2">
          Resolved: <span className="font-mono text-accent-fg">{resolved}</span>
        </p>
      </div>

      <div
        role="group"
        aria-label="Theme"
        className="flex gap-1 rounded-lg border border-line bg-surface-1 p-1"
      >
        {PREFERENCES.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={preference === option}
            onClick={() => {
              setPreference(option);
            }}
            className={
              preference === option
                ? 'rounded-md bg-accent px-3 py-1.5 text-sm text-on-fill'
                : 'rounded-md px-3 py-1.5 text-sm text-fg-2 hover:bg-hover'
            }
          >
            {option}
          </button>
        ))}
      </div>
    </header>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-medium">{title}</h2>
        {hint !== undefined && <p className="text-sm text-fg-3">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Label({ children }: { readonly children: ReactNode }): JSX.Element {
  return <span className="font-mono text-2xs text-fg-2">{children}</span>;
}
