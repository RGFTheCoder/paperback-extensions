/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import {
  ContentRating,
  type ExtensionInfo,
  SourceIntents,
} from "@paperback/types-0.9";

export default {
  name: "ComixTo (DMC)",
  description: "Extension that pulls content from Comix.to.",
  version: "1.10.1-alpha.2",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.EVERYONE,
  capabilities: [
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.SETTINGS_FORM_PROVIDING,
  ],
  badges: [],
  developers: [
    {
      name: "Catta1997",
      github: "https://github.com/Catta1997",
    },
    {
      name: "RGFTheCoder",
      github: "https://github.com/RGFTheCoder",
    },
  ],
} satisfies ExtensionInfo;
