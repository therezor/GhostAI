/**
 * The mark.
 *
 * Hand-drawn rather than pulled from `lucide-react`, and the reason is the
 * house style rather than the subject: every icon in that set is a 24-unit
 * grid with a 2-unit stroke and *round* caps, which is a deliberately friendly
 * shape. A skull drawn to those rules reads as a sticker.
 *
 * It is a **filled silhouette with knockouts**, not an outline, and that is the
 * decision the drawing rests on. An outlined skull at 24 units has to spend two
 * of them on the stroke, which leaves the sockets three units wide and the
 * teeth a bar; the first attempt here read as a stop sign with two dots. A
 * filled glyph spends every unit on shape, so the same geometry is legible as
 * a 40-unit illustration and as a 16-unit favicon — which it has to be, because
 * `public/favicon.svg` is this path with its colours written out.
 *
 * Three things make it read as a skull rather than as a blob:
 *
 *  - **The teeth are notches in the outline**, not marks inside it. The bottom
 *    edge itself steps up and down, so there is no detail small enough to close
 *    up at favicon size — the silhouette carries it.
 *  - **The sockets come to a point.** A square socket reads as a robot and a
 *    round one as a cartoon; the angled bottom is the whole expression.
 *  - **Every corner is a 45° chamfer or a right angle**, so the shape stays
 *    crisp under antialiasing instead of dissolving into grey.
 *
 * `currentColor` throughout, so it inherits the text tier it is placed in and
 * follows the theme with nothing to do at the call site.
 */

import type { JSX, SVGProps } from 'react';

/**
 * The whole mark as one path: cranium, cheeks and a jaw whose bottom edge is
 * the teeth, followed by the four knockouts.
 *
 * One path and `fill-rule="evenodd"` rather than a shape plus four holes in the
 * background colour — a knockout painted in the background colour is a hole
 * that stops being a hole the moment the mark is placed on any other surface.
 */
export const SKULL_PATH: string =
  // Cranium → cheeks → jaw, with the teeth cut into the bottom edge. The top
  // corners take a small chamfer and the cheeks a longer, steeper one, so the
  // silhouette narrows towards the jaw instead of resolving into a regular
  // octagon — which is what the first draft of this did, and it read as a stop
  // sign. The teeth are shallow tabs on a solid jaw rather than deep ones: cut
  // to the full depth they stop reading as teeth and start reading as legs.
  'M7 2.5h10l3 3V13l-3 4v4.5h-2V20h-2v1.5h-2V20H9v1.5H7V17l-3-4V5.5z' +
  // Sockets: square across the top, meeting at a point below.
  'M7 8h4v3l-2 2-2-2zM13 8h4v3l-2 2-2-2z' +
  // The nasal cavity.
  'M12 14l1.5 2.5h-3z';

export function Skull({
  className,
  ...props
}: Omit<SVGProps<SVGSVGElement>, 'viewBox' | 'children'>): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      // The knockouts are subpaths wound the same way as the outline, so
      // `evenodd` is what makes them holes rather than filled islands.
      fillRule="evenodd"
      className={className}
      {...props}
    >
      <path d={SKULL_PATH} />
    </svg>
  );
}
