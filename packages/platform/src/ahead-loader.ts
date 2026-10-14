/**
 * Loading what a person will open next, before they open it (PEE-5).
 *
 * Peek's Desk hands in its working set — Topics, the Open work topics, the
 * Starred people, the Screener — as steps, in the order it wants them. Each
 * step reads through the app's own caches on the `ahead` lane of the pacer
 * (`read-pacer.ts`), so it fills what a click would have filled, and the click
 * then draws from it.
 *
 * The rules are the whole of this object:
 *
 * - **In order**, at most `concurrency` steps at once. A later step never
 *   starts before an earlier one.
 * - **Once.** It runs through the list and stops; the app starts another on
 *   the next open.
 * - **The first failure stops it for good.** A step that throws was refused,
 *   timed out, or found the socket unusable; loading on would only spend the
 *   relay's allowance the person's own clicks need. What has loaded stays.
 * - **`stop()`** — sign-out, a new workspace — starts nothing more. Steps
 *   already running finish; their reads were asked.
 *
 * No React and no relay, as the rest of this package.
 */

export interface AheadStep {
  /** Said in the outcome and in the app's diagnostics. */
  label: string
  run: () => Promise<void>
}

export interface AheadOutcome {
  /** The steps that finished, in the order they finished. */
  loaded: string[]
  /** Why it stopped before the end: the failed step and its error, or `'stopped'`. */
  stoppedBy?: { label: string; error: unknown } | 'stopped'
}

export interface AheadLoader {
  stop(): void
  /** Settles when no step is running and none will start. Never rejects. */
  done: Promise<AheadOutcome>
}

export interface AheadLoaderOptions {
  /** Steps running at once. Default 2: a step waits on the relay most of its time. */
  concurrency?: number
}

export function loadAhead(steps: AheadStep[], options: AheadLoaderOptions = {}): AheadLoader {
  const concurrency = Math.max(1, options.concurrency ?? 2)
  const outcome: AheadOutcome = { loaded: [] }
  let next = 0
  let running = 0
  let finish: (outcome: AheadOutcome) => void = () => {}
  const done = new Promise<AheadOutcome>((resolve) => (finish = resolve))

  const halted = () => outcome.stoppedBy !== undefined

  function pump() {
    while (!halted() && running < concurrency && next < steps.length) {
      const step = steps[next++]
      running += 1
      // A run that throws before it returns its promise fails the step like one that rejects.
      Promise.resolve()
        .then(() => step.run())
        .then(
          () => {
            outcome.loaded.push(step.label)
          },
          (error: unknown) => {
            if (!halted()) outcome.stoppedBy = { label: step.label, error }
          },
        )
        .finally(() => {
          running -= 1
          pump()
        })
    }
    if (running === 0 && (halted() || next >= steps.length)) finish(outcome)
  }

  void Promise.resolve().then(pump)
  return {
    stop() {
      if (!halted()) outcome.stoppedBy = 'stopped'
      if (running === 0) finish(outcome)
    },
    done,
  }
}
