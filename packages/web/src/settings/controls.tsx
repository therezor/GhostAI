/**
 * The furniture every settings panel is built out of.
 *
 * A settings screen is where a design system either holds or visibly stops
 * holding: it is dozens of label/control/hint triples, and written one at a time
 * they drift in spacing, in where the hint sits, and in whether the label is
 * attached to the control at all. These are the four shapes the panels below
 * need, so a new setting is a line rather than a layout decision.
 *
 * `SaveBar` carries the one behavioural rule worth stating: **a settings panel
 * saves on a press, never on a keystroke.** A field that applies as it is typed
 * would rebuild the provider on every character of an API base, and half of
 * those characters are a URL that does not resolve yet.
 */

import type { ComponentProps, JSX, ReactNode } from 'react';
import { useId } from 'react';

import { cn } from '@/lib/cn.js';
import { Button } from '@/components/ui/button.js';
import { Input, Label } from '@/components/ui/field.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.js';
import { Switch } from '@/components/ui/switch.js';

export function Section({
  title,
  description,
  children,
  className,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}): JSX.Element {
  return (
    <section
      aria-label={title}
      className={cn('rounded-lg border border-line bg-surface-1 p-4', className)}
    >
      <h3 className="text-md font-medium text-fg-1">{title}</h3>
      {description !== undefined && <p className="mt-1 text-xs text-fg-3">{description}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

/** Two columns above `sm`, one below — a settings form is the last place to force a scroll. */
export function FieldGrid({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

export interface TextFieldProps extends Omit<ComponentProps<'input'>, 'id' | 'onChange'> {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
  readonly onValueChange: (value: string) => void;
}

/**
 * `Field` from the primitives, minus its `onChange` event and plus a hint that
 * stays visible next to an error rather than being replaced by it.
 *
 * The replacement matters: the hint on a duration field says what `0` means, and
 * losing it exactly when the value is invalid removes the sentence that explains
 * the valid values.
 */
export function TextField({
  label,
  hint,
  error,
  onValueChange,
  className,
  ...props
}: TextFieldProps): JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [
    hint === undefined ? undefined : hintId,
    error === undefined ? undefined : errorId,
  ]
    .filter((value) => value !== undefined)
    .join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error !== undefined}
        {...(describedBy === '' ? {} : { 'aria-describedby': describedBy })}
        className={className}
        onChange={(event) => {
          onValueChange(event.target.value);
        }}
        {...props}
      />
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-fg-3">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} role="alert" className="text-xs text-danger-fg">
          {error}
        </p>
      )}
    </div>
  );
}

export interface SelectFieldOption {
  readonly value: string;
  readonly label: string;
}

/**
 * `placeholder` is not decoration here.
 *
 * An empty `value` means *no* value to a Radix select, so a control whose state
 * is legitimately "nothing chosen" — a model left blank for the registry to
 * resolve — renders a blank trigger unless something is given to show instead.
 * A blank control reads as broken, which is worse than the setting it describes.
 */
export function SelectField({
  label,
  hint,
  value,
  options,
  onValueChange,
  disabled,
  placeholder,
}: {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly value: string;
  readonly options: readonly SelectFieldOption[];
  readonly onValueChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}): JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value}
        onValueChange={onValueChange}
        {...(disabled === true ? { disabled } : {})}
      >
        <SelectTrigger id={id} {...(hint === undefined ? {} : { 'aria-describedby': hintId })}>
          <SelectValue {...(placeholder === undefined ? {} : { placeholder })} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-fg-3">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * A switch with its label to the left, which is the one arrangement that reads
 * as a toggle rather than as a field. The whole row is the label element, so the
 * hit target is the sentence and not the 2.25rem control at the end of it.
 */
export function SwitchRow({
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}): JSX.Element {
  const id = useId();

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint !== undefined && <p className="text-xs text-fg-3">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/**
 * The save row.
 *
 * `Revert` appears only while there is something to revert, and both controls
 * disable when the form is clean — a Save button that is always pressable
 * invites a save of nothing, which on this screen means rebuilding the provider
 * and the jail to change nothing at all.
 */
export function SaveBar({
  dirty,
  saving,
  onSave,
  onRevert,
  children,
}: {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly onSave: () => void;
  readonly onRevert: () => void;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" disabled={!dirty || saving} onClick={onSave}>
        {saving ? 'Saving…' : 'Save changes'}
      </Button>
      {dirty && (
        <Button variant="ghost" disabled={saving} onClick={onRevert}>
          Revert
        </Button>
      )}
      {children}
      {/* Announced rather than only coloured: "unsaved changes" is the state a
          user is most likely to leave the page in the middle of. */}
      <span role="status" aria-live="polite" className="text-xs text-fg-3">
        {dirty ? 'Unsaved changes' : ''}
      </span>
    </div>
  );
}
