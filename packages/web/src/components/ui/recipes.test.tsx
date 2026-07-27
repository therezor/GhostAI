/**
 * The two recipes.
 *
 * What is worth testing about a `cva` call is not that it returns strings — it
 * is the three rules the strings encode: that a caller's `className` beats the
 * recipe's (or the escape hatch is a lie), that every role/variant pairing
 * actually exists (a missing compound variant renders an unstyled pill and
 * nobody notices until it ships), and that a button is not a submit button by
 * accident.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Badge, badgeVariants } from './badge.js';
import { Button } from './button.js';

const TONES = ['neutral', 'accent', 'success', 'warning', 'danger', 'info'] as const;
const VARIANTS = ['soft', 'solid', 'outline'] as const;

describe('Button', () => {
  it('defaults to type=button, so it cannot submit a form by accident', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'button');
  });

  it('still submits when asked to', () => {
    render(<Button type="submit">Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'submit');
  });

  it('lets a caller override a recipe class rather than doubling it', () => {
    render(<Button className="rounded-none">Square</Button>);

    const className = screen.getByRole('button').className;
    expect(className).toContain('rounded-none');
    expect(className).not.toContain('rounded-md');
  });

  it('renders as its child, keeping the classes, so a link stays a link', () => {
    render(
      <Button asChild variant="primary">
        <a href="/somewhere">Go</a>
      </Button>,
    );

    const link = screen.getByRole('link', { name: 'Go' });
    expect(link).toHaveClass('bg-accent');
    expect(link).not.toHaveAttribute('type');
  });

  it('is reachable and operable from the keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Press</Button>);

    await user.tab();
    expect(screen.getByRole('button')).toHaveFocus();

    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('does not fire while disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Press
      </Button>,
    );

    await user.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Badge', () => {
  it('covers every role and variant pairing', () => {
    // A missing compound variant is an unstyled pill — visually a plain word,
    // which is precisely the kind of gap a screenshot review skims past.
    for (const tone of TONES) {
      for (const variant of VARIANTS) {
        const classes = badgeVariants({ tone, variant });
        expect(classes, `${tone}/${variant}`).toMatch(/(?:bg-|border-)/);
        expect(classes, `${tone}/${variant}`).toMatch(/text-/);
      }
    }
  });

  it('never colours text with the fill token', () => {
    // The rule the third gate enforces, asserted from the other direction: the
    // recipe is where a `text-accent` would be most tempting to write.
    for (const tone of TONES) {
      for (const variant of VARIANTS) {
        // `(?![\w-])` and not `\b`: a word boundary matches at the hyphen, so
        // `\btext-accent\b` would also match the correct `text-accent-fg`.
        expect(badgeVariants({ tone, variant })).not.toMatch(
          /(?<![\w-])text-(?:accent|success|warning|danger|info)(?![\w-])/,
        );
      }
    }
  });

  it('is soft and neutral by default, because a badge annotates', () => {
    render(<Badge>queued</Badge>);
    expect(screen.getByText('queued')).toHaveClass('bg-hover');
  });
});
