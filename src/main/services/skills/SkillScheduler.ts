// Background scheduler that periodically refreshes git sources and emits
// "update available" events when a skill's contentHash drifts from the
// source's current scan. Local sources reflect dev edits in real-time and
// are intentionally skipped here.

const DEFAULT_REFRESH_MS = 8 * 60 * 60 * 1000; // 8h, matches qunar's cadence
const STAGGER_MS = 30 * 1000; // wait 30s after start to avoid app-launch contention

export interface SkillSchedulerCallbacks {
  /** Called on each tick. Should not throw — the scheduler swallows rejections. */
  onTick(): Promise<void>;
}

export class SkillScheduler {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private intervalMs: number;

  constructor(
    private callbacks: SkillSchedulerCallbacks,
    intervalMs = DEFAULT_REFRESH_MS
  ) {
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    // First tick after a short stagger (don't slam scan on cold app boot).
    this.timer = setTimeout(() => this.tick(), STAGGER_MS);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  private tick(): void {
    this.callbacks
      .onTick()
      .catch((err) => {
        console.warn('[SkillScheduler] tick failed:', err);
      })
      .finally(() => {
        if (this.started) {
          this.timer = setTimeout(() => this.tick(), this.intervalMs);
        }
      });
  }
}
