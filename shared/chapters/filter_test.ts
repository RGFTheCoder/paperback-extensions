/* SPDX-License-Identifier: GPL-3.0-or-later */
/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { type FilterableChapter, filterChapters } from "./filter.ts";

interface Ch extends FilterableChapter {
  id: string;
}

function ch(id: string, number: number, votes: number, language = "en"): Ch {
  return { id, number, votes, language };
}

const ids = (list: Ch[]) => list.map((c) => c.id);

Deno.test("mostPopularOnly keeps the highest-voted upload per number", () => {
  const chapters = [
    ch("a", 2, 5),
    ch("b", 2, 30),
    ch("c", 2, 10),
    ch("d", 1, 1),
  ];
  const out = filterChapters(chapters, {
    mostPopularOnly: true,
    hidePartials: false,
  });
  assertEquals(ids(out), ["b", "d"]);
});

Deno.test("mostPopularOnly does not collapse across languages", () => {
  const chapters = [
    ch("en5", 5, 3, "en"),
    ch("es5", 5, 99, "es"),
    ch("en5b", 5, 4, "en"),
  ];
  const out = filterChapters(chapters, {
    mostPopularOnly: true,
    hidePartials: false,
  });
  // Top English (en5b) + the only Spanish (es5).
  assertEquals(ids(out).sort(), ["en5b", "es5"]);
});

Deno.test("hidePartials hides x.1/x.2 when integer x exists", () => {
  const chapters = [
    ch("c1", 1, 0),
    ch("c1_1", 1.1, 0),
    ch("c1_2", 1.2, 0),
  ];
  const out = filterChapters(chapters, {
    mostPopularOnly: false,
    hidePartials: true,
  });
  assertEquals(ids(out), ["c1"]);
});

Deno.test("hidePartials keeps partials when the whole chapter is missing", () => {
  const chapters = [
    ch("c2_1", 2.1, 0),
    ch("c2_2", 2.2, 0),
  ];
  const out = filterChapters(chapters, {
    mostPopularOnly: false,
    hidePartials: true,
  });
  assertEquals(ids(out), ["c2_1", "c2_2"]);
});

Deno.test("hidePartials always keeps .5 half-chapters", () => {
  const chapters = [
    ch("c10", 10, 0),
    ch("c10_5", 10.5, 0),
    ch("c10_1", 10.1, 0),
  ];
  const out = filterChapters(chapters, {
    mostPopularOnly: false,
    hidePartials: true,
  });
  assertEquals(ids(out), ["c10", "c10_5"]);
});

Deno.test("partials are per-language", () => {
  const chapters = [
    ch("en1", 1, 0, "en"),
    ch("en1_1", 1.1, 0, "en"), // hidden: en integer 1 exists
    ch("es1_1", 1.1, 0, "es"), // kept: no es integer 1
  ];
  const out = filterChapters(chapters, {
    mostPopularOnly: false,
    hidePartials: true,
  });
  assertEquals(ids(out), ["en1", "es1_1"]);
});

Deno.test("both filters compose: dedupe then hide partials", () => {
  const chapters = [
    ch("c1_lo", 1, 2),
    ch("c1_hi", 1, 50), // winner for chapter 1
    ch("c1_1", 1.1, 99), // partial, hidden because integer 1 exists
    ch("c2_1", 2.1, 4), // partial, kept because integer 2 missing
  ];
  const out = filterChapters(chapters, {
    mostPopularOnly: true,
    hidePartials: true,
  });
  assertEquals(ids(out), ["c1_hi", "c2_1"]);
});

Deno.test("no options is a no-op preserving order", () => {
  const chapters = [ch("a", 3, 1), ch("b", 2, 1), ch("c", 1, 1)];
  const out = filterChapters(chapters, {
    mostPopularOnly: false,
    hidePartials: false,
  });
  assertEquals(ids(out), ["a", "b", "c"]);
});
