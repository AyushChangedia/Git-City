/**
 * timeline.js — playback state. Knows nothing about three.js or the DOM.
 *
 * The whole history plays in roughly 45 seconds no matter how many commits
 * there are, with a floor so a short history does not flicker past.
 */

const TARGET_DURATION_MS = 45000;
const MIN_MS_PER_COMMIT = 80;

export function msPerCommit(commitCount) {
  if (!commitCount) return MIN_MS_PER_COMMIT;
  return Math.max(MIN_MS_PER_COMMIT, TARGET_DURATION_MS / commitCount);
}

export class Timeline {
  /**
   * @param {object} handlers
   * @param {(commit, index) => void} handlers.onCommit  play one commit forward
   * @param {(index) => void} handlers.onSeek            jump anywhere, rebuild
   * @param {() => void} handlers.onChange               UI should refresh
   */
  constructor({ onCommit, onSeek, onChange } = {}) {
    this.commits = [];
    this.index = -1;          // -1 = nothing applied yet
    this.playing = false;
    this.speed = 1;
    this.msPerCommit = MIN_MS_PER_COMMIT;

    this._accumulator = 0;
    this._onCommit = onCommit || (() => {});
    this._onSeek = onSeek || (() => {});
    this._onChange = onChange || (() => {});
  }

  load(commits) {
    this.commits = commits;
    this.index = -1;
    this.msPerCommit = msPerCommit(commits.length);
    this._accumulator = 0;
    this.playing = false;
    this._onSeek(-1);
    this._onChange();
  }

  get count() { return this.commits.length; }
  get current() { return this.commits[this.index] || null; }
  get atEnd() { return this.index >= this.commits.length - 1; }

  play() {
    if (!this.commits.length) return;
    // Replaying from the end should start over rather than sit there.
    if (this.atEnd) this.seek(-1);
    this.playing = true;
    this._accumulator = 0;
    this._onChange();
  }

  pause() {
    this.playing = false;
    this._onChange();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  setSpeed(speed) {
    this.speed = speed;
    this._onChange();
  }

  /** Jump to an absolute index; -1 clears the city. */
  seek(index) {
    const clamped = Math.max(-1, Math.min(index, this.commits.length - 1));
    if (clamped === this.index) return;
    this.index = clamped;
    this._accumulator = 0;
    this._onSeek(clamped);
    this._onChange();
  }

  /** Advance by real elapsed time. Called every animation frame. */
  tick(deltaMs) {
    if (!this.playing || !this.commits.length) return;

    this._accumulator += deltaMs * this.speed;
    const step = this.msPerCommit;

    // Cap the catch-up burst so a stalled tab does not replay the whole repo
    // in a single frame.
    let budget = 8;
    while (this._accumulator >= step && budget-- > 0) {
      this._accumulator -= step;
      if (this.atEnd) {
        this.playing = false;
        this._accumulator = 0;
        this._onChange();
        return;
      }
      this.index++;
      this._onCommit(this.commits[this.index], this.index);
      this._onChange();
    }
    if (budget <= 0) this._accumulator = 0;
  }
}
