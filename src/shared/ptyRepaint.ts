/** Output a PTY prints right after the app resizes or redraws it is a repaint,
 *  not work.
 *
 *  Opening an agent's terminal (focus mode, its room, fullscreen) fits xterm to
 *  the new pane and resizes the PTY, and attaching asks for a same-size redraw.
 *  Either way a TUI like Claude Code reprints its whole screen, tool lines and
 *  all, and under ConPTY even a same-size resize does. Read as activity, that
 *  repaint showed an idle agent as working for seconds (the stream parser saw
 *  old `● Read …` lines) and reset the "quiet for N s" clocks that the worker
 *  wake, queue drain and floor-quiet checks wait on.
 *
 *  Measured on a WSL floor (claude through wsl.exe and ConPTY): the repaint
 *  arrives within ~20 ms of the resize, in one to three chunks. A second is
 *  plenty of margin for a slow machine and a long transcript, and short enough
 *  that genuine work keeps reading as work: a turn in progress keeps printing
 *  (its spinner ticks every ~100 ms) after the window closes, and hook events
 *  are not touched by this at all. */
export const REPAINT_ECHO_MS = 1000;

/** The deadline to store when the app resizes or redraws a PTY at `now`. */
export function repaintEchoUntil(now: number): number {
  return now + REPAINT_ECHO_MS;
}

/** Is output arriving at `now` the repaint of a resize/redraw whose deadline is
 *  `until`? Unset (0 / undefined) means no resize is pending. */
export function isRepaintEcho(until: number | undefined, now: number): boolean {
  return typeof until === 'number' && until > 0 && now < until;
}
