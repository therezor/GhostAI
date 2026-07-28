/**
 * The one window size, shared by the runner and the capture script.
 *
 * Wide enough to be past the shell's `md` breakpoint, so "is the sidebar inline
 * or in a drawer" is decided here rather than by whatever viewport a runner
 * defaults to. And the same on both sides of the fidelity comparison — a
 * reference measured at another width is not a reference.
 *
 * It lives under `src/` rather than in `playwright.config.ts` because the
 * config is outside every package's `src`, and a spec reaching up to it is the
 * deep relative import the repo bans everywhere else for good reasons.
 */
export const VIEWPORT: { readonly width: number; readonly height: number } = {
  width: 1440,
  height: 900,
};
