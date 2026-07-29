/**
 * The composer.
 *
 * Four behaviours, each of which is invisible when it breaks and infuriating
 * when it does: Enter sends and Shift+Enter does not, the box grows with the
 * text, an attachment is uploaded when it is chosen rather than when Send is
 * pressed, and the `@` popover is drivable without touching the mouse.
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Attachment } from '@ghostai/protocol';

import { Composer } from './composer.js';
import { renderWithProviders, stubFetch } from '@/test/render.js';

interface Sent {
  readonly text: string;
  readonly attachments: readonly Attachment[];
}

function mount(overrides: Partial<React.ComponentProps<typeof Composer>> = {}): {
  readonly sent: Sent[];
  readonly stops: number[];
} {
  const sent: Sent[] = [];
  const stops: number[] = [];

  renderWithProviders(
    <Composer
      busy={false}
      queueDepth={0}
      connected
      configured
      onSend={(text, attachments) => sent.push({ text, attachments })}
      onStop={() => stops.push(1)}
      {...overrides}
    />,
  );

  return { sent, stops };
}

const box = (): HTMLElement => screen.getByRole('textbox', { name: 'Message' });

/** The hidden `<input type="file">` the Attach button clicks for the user. */
const filePicker = (): HTMLInputElement => {
  const input = document.body.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('no file input rendered');
  return input;
};

describe('sending', () => {
  it('sends on Enter and starts a new line on Shift+Enter', async () => {
    const user = userEvent.setup();
    const { sent } = mount();

    await user.type(box(), 'first line{Shift>}{Enter}{/Shift}second line');
    expect(sent).toEqual([]);

    await user.keyboard('{Enter}');

    expect(sent).toEqual([{ text: 'first line\nsecond line', attachments: [] }]);
    // The composer clears, because the message is gone.
    expect(box()).toHaveValue('');
  });

  it('refuses to send nothing', async () => {
    const user = userEvent.setup();
    mount();

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    await user.type(box(), '   ');
    // Whitespace is nothing.
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('grows with the text without measuring anything', async () => {
    const user = userEvent.setup();
    mount();

    await user.type(box(), 'one{Shift>}{Enter}{/Shift}two');

    // The mirror is what sizes the grid cell; the textarea stretches to fill
    // it. No `scrollHeight` read, and no pixel height written anywhere.
    const mirror = document.body.querySelector('.composer__mirror');
    expect(mirror?.textContent).toBe('one\ntwo\n');
    expect(box().getAttribute('style')).toBeNull();
  });

  it('offers Stop instead of Send while a turn is running, and still queues', async () => {
    const user = userEvent.setup();
    const { sent, stops } = mount({ busy: true, queueDepth: 2 });

    expect(screen.getByText(/2 messages waiting/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop the current turn' }));
    expect(stops).toHaveLength(1);

    // Enter still sends: the hub queues it, and disabling the box would lose
    // the sentence the user is halfway through.
    await user.type(box(), 'and another thing{Enter}');
    expect(sent).toEqual([{ text: 'and another thing', attachments: [] }]);
  });

  it('says so when the socket is down', () => {
    mount({ connected: false });

    expect(screen.getByText(/Offline/)).toBeInTheDocument();
  });

  it('says nothing at all when there is nothing happening', () => {
    // The line under the box carries transient state only. A keyboard hint that
    // is identical on every render for the life of the install is documentation,
    // and it was taking the width the context budget needed — it lives on the
    // welcome screen now.
    mount();

    expect(screen.queryByText(/Enter to send/)).not.toBeInTheDocument();
    expect(screen.queryByText(/A turn is running/)).not.toBeInTheDocument();
  });

  it('still says when a turn is running, because that changes what Enter does', () => {
    mount({ busy: true });

    expect(screen.getByText(/A turn is running/)).toBeInTheDocument();
  });

  it('counts what is queued alongside whatever else is true', () => {
    mount({ busy: true, queueDepth: 2 });

    expect(screen.getByText(/A turn is running/)).toBeInTheDocument();
    expect(screen.getByText(/2 messages waiting/)).toBeInTheDocument();
  });
});

describe('the @ autocomplete', () => {
  it('opens on @, moves with the arrow keys and accepts with Enter', async () => {
    const user = userEvent.setup();
    const { sent } = mount();

    await user.type(box(), 'scope this @');

    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('@kb:'),
      expect.stringContaining('@mcp:'),
      expect.stringContaining('@skill:'),
    ]);
    // Focus stays in the textarea; `aria-activedescendant` is what tells a
    // screen reader which option the arrow keys are on.
    expect(box()).toHaveAttribute('aria-activedescendant', 'composer-mentions-0');

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(box()).toHaveAttribute('aria-activedescendant', 'composer-mentions-2');

    await user.keyboard('{Enter}');

    // Enter accepted the suggestion rather than sending the message.
    expect(sent).toEqual([]);
    expect(box()).toHaveValue('scope this @skill:');
  });

  it('closes on Escape and stays closed until the next keystroke', async () => {
    const user = userEvent.setup();
    mount();

    await user.type(box(), '@k');
    expect(screen.getAllByRole('option')).toHaveLength(1);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();

    await user.keyboard('b');
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('offers nothing once the namespace is chosen', async () => {
    const user = userEvent.setup();
    mount();

    await user.type(box(), '@kb:handbook');

    // There is no knowledge base to list before Phase 3, and a menu reading
    // "no results" for a feature that was never turned on reads as broken.
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });
});

describe('attachments', () => {
  it('uploads on selection, not on send, and sends the signed URL', async () => {
    const user = userEvent.setup();
    stubFetch({
      '/api/files/upload': [
        201,
        {
          path: 'uploads/abc-note.txt',
          sizeBytes: 5,
          mimeType: 'text/plain',
          signedUrl: { url: '/api/media/token', expiresAtMs: 2_000 },
        },
      ],
    });
    const { sent } = mount();

    await user.upload(filePicker(), new File(['hello'], 'note.txt', { type: 'text/plain' }));

    // A four-second upload starting when Send is pressed is four seconds of a
    // button that appears to have done nothing.
    expect(await screen.findByText('5 B')).toBeInTheDocument();

    await user.type(box(), 'look at this{Enter}');

    expect(sent[0]?.attachments).toEqual([
      // The signed URL, not the workspace path: the path means nothing outside
      // this machine, and a provider has to be able to fetch the bytes.
      { type: 'text/plain', url: '/api/media/token', name: 'note.txt', sizeBytes: 5 },
    ]);
  });

  it('reports a failed upload on the chip rather than losing it silently', async () => {
    const user = userEvent.setup();
    stubFetch({
      '/api/files/upload': [413, { error: { code: 'bad_request', message: 'Too large' } }],
    });
    mount();

    await user.upload(filePicker(), new File(['x'], 'big.bin'));

    expect(await screen.findByText('failed')).toBeInTheDocument();
  });

  it('drops a staged file on request', async () => {
    const user = userEvent.setup();
    stubFetch({
      '/api/files/upload': [201, { path: 'uploads/a-x.txt', sizeBytes: 1, mimeType: 'text/plain' }],
    });
    mount();

    await user.upload(filePicker(), new File(['x'], 'x.txt'));

    await user.click(await screen.findByRole('button', { name: 'Remove x.txt' }));

    await waitFor(() => {
      expect(screen.queryByText('x.txt')).not.toBeInTheDocument();
    });
  });
});

describe('the file picker', () => {
  it('is opened by a labelled button rather than by a bare input', async () => {
    const user = userEvent.setup();
    mount();

    const click = vi.spyOn(filePicker(), 'click').mockImplementation(() => undefined);

    await user.click(screen.getByRole('button', { name: 'Attach a file' }));

    expect(click).toHaveBeenCalledOnce();
  });
});

describe('with no model configured', () => {
  it('says what is missing rather than failing on send', () => {
    // Chat stays in the nav and the route still renders: everything else on a
    // fresh install works, and a nav that changes shape underneath the user is
    // a worse answer than a control that says why it is off.
    mount({ configured: false });

    expect(box()).toBeDisabled();
    expect(box()).toHaveAttribute('placeholder', 'No model configured yet');
  });

  it('cannot send, however the text got there', () => {
    const { sent } = mount({ configured: false });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(sent).toHaveLength(0);
  });
});
