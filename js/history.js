/**
 * history.js — what a commit stream says about the city before anything is
 * drawn.
 *
 * Three questions, all answered by reading the whole dataset once and all
 * answered before the first frame:
 *
 *   which files will ever exist, so every plot can be laid at frame 0
 *   which are the landmarks, so a spire does not sprout and vanish
 *   how tall the city will get, so the camera and the shadow box are framed
 *     for the finished city rather than the empty one
 *
 * This was inside City, which needs a WebGL context to construct, so none of
 * it could be checked. It is arithmetic over plain objects; it belongs here.
 */

/** Spires go on this many buildings, as landmarks. */
export const LANDMARK_COUNT = 3;

const filesOf = (commit) => (commit && commit.files) || [];

/**
 * Every path the dataset ever mentions, in the order it is first seen.
 *
 * Including paths that only ever appear as removed. A fetch window can open
 * after a file was added, so its deletion is the only record of it; giving it
 * a plot costs one foundation plate and keeps the street grid from shifting
 * when that commit lands.
 */
export function allPaths(commits) {
  const paths = new Set();
  for (const commit of commits || []) {
    for (const file of filesOf(commit)) {
      if (file && file.path) paths.add(file.path);
    }
  }
  return [...paths];
}

/**
 * The largest line count each file ever reaches.
 *
 * A removal reports the lines it deleted, not a size, so it is not a peak.
 */
export function peakLines(commits) {
  const peak = new Map();
  for (const commit of commits || []) {
    for (const file of filesOf(commit)) {
      if (!file || !file.path || file.status === 'removed') continue;
      const lines = Number.isFinite(file.lines) ? file.lines : 0;
      peak.set(file.path, Math.max(peak.get(file.path) ?? 0, lines));
    }
  }
  return peak;
}

/**
 * The landmark paths: the tallest few over the whole history.
 *
 * Chosen from the history rather than from the current frame, so a spire does
 * not appear and disappear as a file is edited. Ties break on the path, so the
 * same dataset always picks the same landmarks.
 */
export function landmarks(commits, count = LANDMARK_COUNT) {
  return new Set(
    [...peakLines(commits)]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, Math.max(0, count))
      .map(([path]) => path)
  );
}

/** The largest line count the dataset will ever show, for any file. */
export function peakOfAll(commits) {
  let most = 0;
  for (const lines of peakLines(commits).values()) {
    if (lines > most) most = lines;
  }
  return most;
}
