/**
 * The living style guide: every token at the size it is used, and every
 * primitive beside it.
 *
 * It started as Step 15's swatch grid and kept its job — a seed change is
 * something you can look at rather than something you discover in the chat view
 * three steps later — and Step 16 added the primitives. That is what makes
 * "reviewed in both themes" a five-second check on one page rather than a tour
 * of the application, and it is why every recipe is exercised here in every
 * variant instead of only in the two places the shell happens to use.
 *
 * It is also the widest gate target in the package: written entirely in the
 * utilities every later component uses, so a token that could not be reached
 * without a raw colour or a `px` fails here first.
 */

import type { JSX, ReactNode } from 'react';

import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogSubheading,
  DialogTrigger,
} from '@/components/ui/dialog.js';
import { Field } from '@/components/ui/field.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.js';
import { Switch } from '@/components/ui/switch.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.js';
import { Tooltip } from '@/components/ui/tooltip.js';
import { toast } from '@/components/ui/toast.js';

const SURFACES = ['surface-0', 'surface-1', 'surface-2', 'surface-3'] as const;
const TEXT = ['fg-1', 'fg-2', 'fg-3'] as const;
const OVERLAYS = ['hover', 'active', 'line', 'line-strong'] as const;
const ROLES = ['accent', 'success', 'warning', 'danger', 'info'] as const;
const SIZES = ['2xs', 'xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl'] as const;
const RADII = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'] as const;
const SHADOWS = ['xs', 'sm', 'md', 'lg'] as const;
const ROLE_VARIANTS = ['soft', 'solid', 'outline'] as const;
const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger', 'link'] as const;

export function TokensRoute(): JSX.Element {
  return (
    <div className="bg-surface-0 text-fg-1">
      <div className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-10">
        <header className="border-b border-line pb-6">
          <h1 className="text-2xl font-semibold">Tokens and primitives</h1>
          <p className="text-sm text-fg-2">
            The living style guide. Flip the theme in the header and everything here has to hold —
            which is what makes reviewing in both themes something you can actually do.
          </p>
        </header>
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

        <Section
          title="Buttons"
          hint="One recipe. Tab through them — the ring is the base layer's, not each button's."
        >
          <div className="flex flex-col gap-3">
            {BUTTON_VARIANTS.map((variant) => (
              <div key={variant} className="flex flex-wrap items-center gap-3">
                <Button variant={variant} size="sm">
                  {variant} sm
                </Button>
                <Button variant={variant}>{variant} md</Button>
                <Button variant={variant} size="lg">
                  {variant} lg
                </Button>
                <Button variant={variant} disabled>
                  disabled
                </Button>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Badges" hint="One recipe parameterised on role — not twenty-five pills.">
          <div className="flex flex-col gap-3">
            {ROLE_VARIANTS.map((variant) => (
              <div key={variant} className="flex flex-wrap items-center gap-2">
                <Label>{variant}</Label>
                <Badge variant={variant}>neutral</Badge>
                {ROLES.map((role) => (
                  <Badge key={role} tone={role} variant={variant}>
                    {role}
                  </Badge>
                ))}
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Interaction"
          hint="Radix behaviour, our classes. Every one of these is keyboard-operable."
        >
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-surface-2 p-4">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="secondary">Open dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogHeading>A modal dialog</DialogHeading>
                  <DialogSubheading>
                    Focus is trapped here, Escape closes it, and focus returns to the button that
                    opened it.
                  </DialogSubheading>
                </DialogHeader>
                <Field label="Something to focus" placeholder="Tab cycles inside the dialog" />
                <DialogFooter>
                  <Button variant="ghost">Cancel</Button>
                  <Button variant="primary">Confirm</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Tooltip label="Tooltips label; they never explain">
              <Button variant="ghost">Hover or focus me</Button>
            </Tooltip>

            <Button
              variant="secondary"
              onClick={() => {
                toast.success('Saved', 'Toasts announce without stealing focus.');
              }}
            >
              Raise a toast
            </Button>

            <label className="flex items-center gap-2 text-sm text-fg-2">
              <Switch defaultChecked />
              Applies immediately
            </label>

            <Select defaultValue="anthropic">
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anthropic">Anthropic</SelectItem>
                <SelectItem value="ollama">Ollama</SelectItem>
                <SelectItem value="openai-compatible">OpenAI-compatible</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Tabs defaultValue="one">
            <TabsList>
              <TabsTrigger value="one">First</TabsTrigger>
              <TabsTrigger value="two">Second</TabsTrigger>
              <TabsTrigger value="three" disabled>
                Disabled
              </TabsTrigger>
            </TabsList>
            <TabsContent value="one" className="text-sm text-fg-2">
              Arrow keys move between tabs; the panel follows.
            </TabsContent>
            <TabsContent value="two" className="text-sm text-fg-2">
              The active tab is a surface change and a text tier, never colour alone.
            </TabsContent>
          </Tabs>

          <div className="max-w-sm">
            <Field label="Text field" placeholder="Label, input and message are wired together" />
            <div className="mt-3">
              <Field label="Invalid field" defaultValue="not-an-email" error="That is not valid." />
            </div>
          </div>
        </Section>
      </div>
    </div>
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
