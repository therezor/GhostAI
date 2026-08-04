/**
 * What the renderer draws: things that turn a width into rows.
 *
 * A component returns *drawn rows*, not prose — one array entry is one row on
 * screen, and nothing it returns may be wide enough for the terminal to wrap it
 * itself. That single rule is what the renderer's arithmetic rests on, and it
 * is also the reason a resize is survivable at all: a frame that never depends
 * on the terminal to fold anything can simply be asked for again at the new
 * width.
 *
 * The shape is `@earendil-works/pi`'s, which solved this before we did.
 */

const ESC = '\u001b';
/** ST, the standard terminator for a control string. */
const ST = `${ESC}\\`;

/** A width in, rows out. */
export interface Component {
  render(width: number): readonly string[];
}

/**
 * Where the terminal's own cursor belongs, emitted inline by whichever
 * component owns it.
 *
 * An APC string: terminals ignore it, it occupies no columns, and it travels
 * with the text around it — so a component says "here" in the middle of the row
 * it is drawing rather than reporting a coordinate that some other code would
 * have to keep in step with the drawing.
 *
 * Terminated by ST rather than BEL, which is the standard and not a preference.
 * BEL closes an *OSC* string as an xterm extension; nothing says it closes an
 * APC one, and a terminal that waits for ST would swallow everything written
 * after the marker until one arrived. The renderer strips every marker before a
 * frame is written, so this should never reach a terminal at all — which is
 * exactly why it should be the form that is harmless if it ever does.
 *
 * Written as escapes rather than bytes, like everything else here: a literal
 * `0x1b` in a source file is invisible in an editor and unsearchable.
 */
export const CURSOR_MARKER: string = `${ESC}_ghostai:cursor${ST}`;
