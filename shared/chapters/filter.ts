/* SPDX-License-Identifier: GPL-3.0-or-later */

// Shared, API-agnostic chapter-list filtering used by both the 0.8 and 0.9
// ComixDMC sources. Operates on a normalized chapter shape so each version can
// feed its own API item type through the same logic.
//
// Two independent filters (each off by default; the source decides):
//   - mostPopularOnly: when several groups upload the *same* chapter number in
//     the same language, keep only the one with the most votes ("likes").
//   - hidePartials: hide split/part uploads (x.1, x.2, …) once the whole
//     integer chapter x has released. Half-chapters (x.5) are always kept, as
//     they're usually standalone side-stories/omakes rather than partial parts.

// Anything with a chapter number, language and vote count can be filtered.
export interface FilterableChapter {
  // Chapter number; may be fractional (e.g. 10.5, 12.1).
  number: number;
  // Language code (e.g. "en"). Filters never mix languages together.
  language: string;
  // "Likes" / vote count used to pick the most-popular upload.
  votes: number;
}

export interface ChapterFilterOptions {
  mostPopularOnly: boolean;
  hidePartials: boolean;
}

const EPS = 1e-9;

function fractional(n: number): number {
  return n - Math.floor(n);
}

// A "strict partial" is a fractional chapter that isn't a .5 half-chapter —
// i.e. a split part (x.1, x.2, x.25, …) of the whole chapter floor(x).
function isStrictPartial(n: number): boolean {
  const f = fractional(n);
  if (f < EPS) return false; // whole chapter
  if (Math.abs(f - 0.5) < EPS) return false; // .5 half-chapter, keep
  return true;
}

function langKey(language: string, number: number): string {
  return `${language}|${number}`;
}

// Filter a chapter list per the options, preserving input order. Ties on votes
// keep the earliest occurrence, so callers should pass chapters in their
// preferred order (e.g. newest first) for a stable, deterministic result.
export function filterChapters<T extends FilterableChapter>(
  chapters: T[],
  options: ChapterFilterOptions,
): T[] {
  let result = chapters;

  // Which integer chapter numbers exist (per language). Computed from the full
  // input so "the whole chapter released" holds regardless of the most-popular
  // pass below.
  const wholeReleased = new Set<string>();
  if (options.hidePartials) {
    for (const c of chapters) {
      if (fractional(c.number) < EPS) {
        wholeReleased.add(langKey(c.language, c.number));
      }
    }
  }

  if (options.mostPopularOnly) {
    // Keep the highest-voted upload per (language, number). Preserve the first
    // winner's position so ordering stays stable.
    const bestIndexByKey = new Map<string, number>();
    result.forEach((c, i) => {
      const key = langKey(c.language, c.number);
      const prev = bestIndexByKey.get(key);
      if (prev === undefined || c.votes > result[prev]!.votes) {
        bestIndexByKey.set(key, i);
      }
    });
    const keep = new Set(bestIndexByKey.values());
    result = result.filter((_, i) => keep.has(i));
  }

  if (options.hidePartials) {
    result = result.filter((c) =>
      !(isStrictPartial(c.number) &&
        wholeReleased.has(langKey(c.language, Math.floor(c.number))))
    );
  }

  return result;
}
