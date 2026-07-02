export const API_BASE = "https://comix.to/api/v1";
export const DOMAIN = "https://comix.to";

// Generic string/date helpers now live in the shared lib and are re-exported
// here so the Comix modules can keep importing them from a single barrel.
export { normalizeString } from "../../lib/strings.ts";
export { parseRelativeTime } from "../../lib/time.ts";

export interface APIResponse<T> {
  status: string; // "ok" | "error"
  message?: string;
  code?: number;
  result: T;
}

export interface APIMangaItem {
  id: number;
  hid: string;
  title: string;
  altTitles?: string[];
  synopsis: string;
  poster: {
    medium: string;
    large: string;
  };
  status: string;
  latestChapter: number;
  ratedAvg: number;
  contentRating: string; // "safe" | "suggestive" | "erotica" | "pornographic"
  type?: string;
  authors?: { id: number; title: string; slug?: string }[];
  artists?: { id: number; title: string; slug?: string }[];
  genres?: { id: number; title: string; slug?: string }[];
  demographics?: { id: number; title: string; slug?: string }[];
  formats?: { id: number; title: string; slug?: string }[];
  tags?: { id: number; title: string; slug?: string }[];
}

export interface APIMeta {
  page?: number;
  lastPage?: number;
  perPage?: number;
  total?: number;
  from?: number;
  to?: number;
  hasNext?: boolean;
  hasPrev?: boolean;
}

export interface APIMangaResult {
  items: APIMangaItem[];
  meta?: APIMeta;
}

export interface APIChapterItem {
  id: number;
  mangaId: number;
  number: number;
  name: string;
  language: string;
  volume: number;
  createdAtFormatted?: string;
  group?: { id: number; name: string };
}

export interface APIChapterResult {
  items: APIChapterItem[];
  meta?: APIMeta;
}

// Post-2026-05-09 shape: `pages` is now an object with a CDN baseUrl and a
// list of items whose `url` is just the filename (e.g. "01.webp") relative
// to baseUrl. The previous shape was a flat array of {url, width, height}
// where `url` was already absolute.
export interface APIPagesResult {
  pages: {
    baseUrl: string;
    items: { url: string; width?: number; height?: number }[];
  };
}

export interface APIGenreItem {
  id: number;
  label: string;
  slug?: string;
}

// /tags/search returns `result` as the array directly, not wrapped in `items`.
export type APIGenreResult = APIGenreItem[];

// Static Filter Definitions
export const CONTENT_TYPES = [
  { id: "manga", label: "Manga" },
  { id: "manhwa", label: "Manhwa" },
  { id: "manhua", label: "Manhua" },
  { id: "other", label: "Other" },
];

export const PUBLICATION_STATUS = [
  { id: "finished", label: "Finished" },
  { id: "releasing", label: "Releasing" },
  { id: "on_hiatus", label: "On Hiatus" },
  { id: "discontinued", label: "Discontinued" },
  { id: "not_yet_released", label: "Not Yet Released" },
];

// Content ratings, ordered from tamest to most explicit. The user's selected
// threshold allows everything at-or-below it (lower index = tamer).
export const CONTENT_RATINGS = [
  { id: "safe", label: "Safe" },
  { id: "suggestive", label: "Suggestive" },
  { id: "erotica", label: "Erotica" },
  { id: "pornographic", label: "Pornographic" },
];

export function isRatingAllowed(
  rating: string | undefined,
  maxRating: string,
): boolean {
  const ratingIdx = CONTENT_RATINGS.findIndex((r) => r.id === rating);
  const maxIdx = CONTENT_RATINGS.findIndex((r) => r.id === maxRating);
  if (ratingIdx === -1) return false; // unknown rating → hide to be safe
  if (maxIdx === -1) return true; // unknown max → fail open (don't drop everything)
  return ratingIdx <= maxIdx;
}

export const ORDER_OPTIONS = [
  { id: "relevance", label: "Best Match" },
  { id: "chapter_updated_at", label: "Updated Date" },
  { id: "created_at", label: "Created Date" },
  { id: "views_7d", label: "Most Views (7 Days)" },
  { id: "views_30d", label: "Most Views (1 Month)" },
  { id: "views_90d", label: "Most Views (3 Months)" },
  { id: "views_total", label: "Total Views" },
  { id: "follows_total", label: "Most Follows" },
];

/*
export const TRENDING_OPTIONS = [
  { id: "7", label: "1 Week" },
  { id: "30", label: "1 Month" },
  { id: "90", label: "3 Months" },
  { id: "180", label: "6 Months" },
  { id: "365", label: "1 Year" },
];
*/
