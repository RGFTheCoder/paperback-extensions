/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import {
  ButtonRow,
  EditSection,
  Form,
  FormConfirmationError,
  type FormItemElement,
  type FormSectionElement,
  LabelRow,
  NavigationRow,
  Section,
  SelectRow,
  StepperRow,
  ToggleRow,
} from "@paperback/types-0.9";

import type { ComixFilter } from "../utils/filter";
import { discoverySections } from "../utils/filter";
import type { ScrambleScheme } from "../../../../shared/descramble/descramble.ts";

// Tile-descramble scheme override, exposed for on-device testing. "auto" keeps the
// 0.9 default (LCG); the others force one scheme so a user can confirm which one
// clears an occasionally-scrambled page.
export const DESCRAMBLE_SCHEME_ITEMS = [
  { id: "auto", title: "Auto (LCG)" },
  { id: "lcg", title: "LCG (ranqd1)" },
  { id: "xorshift", title: "xorshift32" },
  { id: "gf2affine", title: "GF(2)-affine" },
];

// Returns the forced tile-descramble scheme, or null to keep the default (LCG).
export function getDescrambleScheme(): ScrambleScheme | null {
  const val = Application.getState("descramble_scheme") as
    | string[]
    | string
    | undefined;
  const id = Array.isArray(val) ? val[0] : val;
  if (id === "lcg" || id === "xorshift" || id === "gf2affine") return id;
  return null; // "auto" / unset → default scheme
}

function getDeletedDiscoverySections() {
  return (
    (Application.getState("deleted_sections") as
      | { id: string; title: string }[]
      | undefined) ?? []
  );
}

async function setDiscoverySections(newValue: { id: string; title: string }[]) {
  Application.setState(newValue, "sections");
}

async function setDeletedDiscoverySections(
  newValue: { id: string; title: string }[],
) {
  Application.setState(newValue, "deleted_sections");
}

export function getDiscoverySectionsOrder() {
  return (
    (Application.getState("sections") as
      | { id: string; title: string }[]
      | undefined) ??
      discoverySections
  );
}

abstract class BaseSettings extends Form {
  protected async updateValue<T>(value: T, id: string): Promise<void> {
    Application.setState(value, id);
    Application.invalidateDiscoverSections();
    this.reloadForm();
  }
}

class EditableListTestForm extends Form {
  override getSections() {
    const onReorderSelectorId = Application.Selector(
      this as EditableListTestForm,
      "rowDidReorder",
    );
    const onDeletionSelectorId = Application.Selector(
      this as EditableListTestForm,
      "rowDidDelete",
    );

    return [
      {
        ...EditSection("edit", {
          id: "edit",
          header: "Section order",
          footer: "Long press to reorder, swipe to hide",
          items: getDiscoverySectionsOrder().map((item) => this.itemRow(item)),
        }),
        allowDeletion: true,
        allowReorder: true,
        onReorder: onReorderSelectorId,
        onDeletion: onDeletionSelectorId,
      } as unknown as FormSectionElement<unknown>,
      ...(getDeletedDiscoverySections().length > 0
        ? [new AddSectionSelect().getDeletedSections()]
        : []),
      Section("status", [
        ButtonRow("reset", {
          title: "Reset all Sections",
          isHidden: getDeletedDiscoverySections().length == 0,
          onSelect: Application.Selector(
            this as EditableListTestForm,
            "resetFiltersDialog",
          ),
        }),
      ]),
    ];
  }
  async resetFiltersDialog() {
    throw new FormConfirmationError(
      Application.Selector(
        this as EditableListTestForm,
        "handleLimitStatusChangeReset",
      ),
      "Do you want to restore all deleted sections?",
    );
  }
  async handleLimitStatusChangeReset(): Promise<void> {
    await setDiscoverySections(discoverySections);
    await setDeletedDiscoverySections([]);
    this.reloadForm();
  }
  private itemRow(
    item: { id: string; title: string },
  ): FormItemElement<unknown> {
    return LabelRow(item.id, {
      title: item.title,
    });
  }

  async rowDidDelete(index: number): Promise<void> {
    const items = getDeletedDiscoverySections();
    const sections = getDiscoverySectionsOrder();
    const deleted = sections.splice(index, 1);
    deleted.forEach((item) => {
      items.push(item);
    });
    await setDeletedDiscoverySections(items);
    await setDiscoverySections(sections);
    this.reloadForm();
  }

  async rowDidReorder(
    sourceIndex: number,
    destinationIndex: number,
  ): Promise<void> {
    const sections = getDiscoverySectionsOrder();
    const [item] = sections.splice(sourceIndex, 1);
    if (item) {
      sections.splice(destinationIndex, 0, item);
    }
    await setDiscoverySections(sections);
    this.reloadForm();
    Application.invalidateDiscoverSections();
  }
}

class AddSectionSelect {
  onSelectLabelProxy = new Proxy(this, {
    has(target, p) {
      if (typeof p == "string" && p.startsWith("onSelect_")) {
        return true;
      } else {
        return Object.hasOwn(target, p);
      }
    },
    get(target, p) {
      if (typeof p == "string" && p.startsWith("onSelect_")) {
        const rowId = p.slice(9);
        return async () => {
          await target["onSelect"](rowId);
        };
      } else {
        // @ts-ignore
        return target[p];
      }
    },
  });

  deletedForms = getDeletedDiscoverySections();
  getDeletedSections(): FormSectionElement<unknown> {
    return Section(
      { id: "addSectionSelect", footer: "Tap to restore" },
      this.deletedForms.flatMap((item) =>
        LabelRow(item.id, {
          title: item.title,
          onSelect: Application.Selector(
            this.onSelectLabelProxy,
            // @ts-expect-error - dynamic proxy method name is not in the typed keyof
            "onSelect_" + item.id,
          ),
        })
      ),
    );
  }

  async onSelect(rowId: string): Promise<void> {
    const sections = getDiscoverySectionsOrder();
    const selectedDeletedItems = this.deletedForms.filter((item) =>
      item.id === rowId
    );
    sections.push(selectedDeletedItems[0]);
    await setDiscoverySections(sections);
    await setDeletedDiscoverySections(
      this.deletedForms.filter((item) => item.id !== rowId),
    );
    this.deletedForms = getDeletedDiscoverySections();
  }
}

export class MainSettings extends BaseSettings {
  constructor(
    private filter: ComixFilter,
    private onRefresh: () => Promise<void>,
  ) {
    super();
  }

  override getSections() {
    return [
      Section("settings", [
        NavigationRow("Contents", {
          title: "Contents",
          subtitle: "Contents Tags Settings",
          form: new FilterSettings(this.filter),
        }),
        ButtonRow("reload_genres", {
          title: "Reload all Filters",
          onSelect: Application.Selector(
            this as MainSettings,
            "refreshFilters",
          ),
        }),
      ]),
      Section("home_sections", [
        NavigationRow("HomeSections", {
          title: "Home Sections",
          subtitle: "Home Sections Settings",
          form: new SectionSettings(this.filter),
        }),
      ]),
      Section(
        {
          id: "descramble_settings",
          footer:
            "Force the tile-descramble permutation scheme. Leave on Auto unless a page renders scrambled; then try each scheme to find the one that clears it.",
        },
        [
          SelectRow("descramble_scheme", {
            title: "Descramble Scheme",
            subtitle: "Advanced: permutation used to unscramble tiled pages",
            layout: "list",
            value: [getDescrambleScheme() ?? "auto"],
            items: DESCRAMBLE_SCHEME_ITEMS,
            minItemCount: 1,
            maxItemCount: 1,
            onValueChange: Application.Selector(
              this as MainSettings,
              "handleDescrambleSchemeChange",
            ),
          }),
        ],
      ),
    ];
  }
  async refreshFilters() {
    await this.onRefresh();
    this.reloadForm();
  }

  async handleDescrambleSchemeChange(id: string[]) {
    Application.setState(id, "descramble_scheme");
    this.reloadForm();
  }
}

class SectionSettings extends BaseSettings {
  constructor(private filter: ComixFilter) {
    super();
  }

  override getSections() {
    return [
      Section(
        {
          id: "timeRangeSection",
        },
        [
          SelectRow("timeRange", {
            title: "Time Range",
            subtitle:
              "Defines the time range for retrieving top-ranked content on Sections",
            layout: "list",
            value: this.filter.getLimitSettings(),
            items: this.limitMap,
            minItemCount: 1,
            maxItemCount: 1,
            onValueChange: Application.Selector(
              this as SectionSettings,
              "handleLimitStatusChange",
            ),
          }),
          ButtonRow("reset_time", {
            title: "Reset to Default Value",
            onSelect: Application.Selector(
              this as SectionSettings,
              "resetFiltersDialog",
            ),
          }),
        ],
      ),
      ...(this.isEnabled("updatesHot") || this.isEnabled("updatesNew")
        ? [
          Section(
            {
              id: "latestSectionSettings",
              header: "Latest Section Settings",
            },
            [
              ToggleRow("sectionType", {
                title: "Horizontal List View",
                subtitle:
                  "Enable to display the latest sections as a horizontal list. Disable to show it in a table layout",
                value: this.filter.getChapterSectionDiffType(),
                onValueChange: Application.Selector(
                  this as SectionSettings,
                  "handleChapterSectionChange",
                ),
              }),
            ],
          ),
        ]
        : []),
      ...(this.isEnabled("trending_manga") || this.isEnabled("trending_wt")
        ? [
          Section(
            {
              id: "trendingSectionSettings",
              header: "Trending Section Settings",
            },
            [
              ToggleRow("sectionType", {
                title: "Horizontal List View",
                subtitle:
                  "Enable to display the trending sections as a horizontal list. Disable to show it in a table layout",
                value: this.filter.getTrendingSectionDiffType(),
                onValueChange: Application.Selector(
                  this as SectionSettings,
                  "handleTrendingSectionChange",
                ),
              }),
              ToggleRow("allTimes", {
                title: "Filter Trending Sections by Year",
                subtitle: "Enable or disable year-based filtering",
                value: this.filter.getSectionTimesType(),
                onValueChange: Application.Selector(
                  this as SectionSettings,
                  "handleYearTimesChange",
                ),
              }),
              StepperRow("yearSettings", {
                title: "Year",
                subtitle: "Select the year",
                value: this.filter.getYearSettings(),
                minValue: 2023,
                maxValue: new Date().getFullYear(),
                stepValue: 1,
                loopOver: false,
                onValueChange: Application.Selector(
                  this as SectionSettings,
                  "handleYearStatusChange",
                ),
                isHidden: !this.filter.getSectionTimesType(),
              }),
            ],
          ),
        ]
        : []),
      ...(this.isEnabled("recent")
        ? [
          Section(
            {
              id: "recentSectionSettings",
              header: "Recent Section Settings",
            },
            [
              ToggleRow("sectionType", {
                title: "Horizontal List View",
                subtitle:
                  "Enable to display the recent rection as a horizontal list. Disable to show it in a table layout",
                value: this.filter.getRecentSectionDiffType(),
                onValueChange: Application.Selector(
                  this as SectionSettings,
                  "handleRecentSectionChange",
                ),
              }),
            ],
          ),
        ]
        : []),
      Section(
        {
          id: "sectionsOrderSettings",
          header: "Sections Order",
        },
        [
          NavigationRow("sectionOrder", {
            title: "Sections Order",
            subtitle: "Sections Order",
            form: new EditableListTestForm(),
          }),
        ],
      ),
    ];
  }
  get limitMap() {
    return this.filter.sectionLimit.map(({ value, id }) => ({
      title: value,
      id,
    }));
  }
  async handleYearStatusChange(id: number) {
    Application.invalidateDiscoverSections();
    await this.updateValue(id, "year_settings");
  }
  async handleLimitStatusChange(id: string[]): Promise<void> {
    Application.invalidateDiscoverSections();
    await this.updateValue(id, "limit");
  }
  async resetFiltersDialog() {
    throw new FormConfirmationError(
      Application.Selector(
        this as SectionSettings,
        "handleLimitStatusChangeReset",
      ),
      "Do you want to reset this to the default value?",
    );
  }
  async handleLimitStatusChangeReset(): Promise<void> {
    Application.invalidateDiscoverSections();
    await this.updateValue(["1"], "limit");
  }
  async handleYearTimesChange(id: boolean): Promise<void> {
    Application.invalidateDiscoverSections();
    await this.updateValue(id, "yearTimes");
  }
  async handleChapterSectionChange(id: boolean): Promise<void> {
    Application.invalidateDiscoverSections();
    await this.updateValue(id, "chapterSection");
  }
  async handleTrendingSectionChange(id: boolean): Promise<void> {
    Application.invalidateDiscoverSections();
    await this.updateValue(id, "trendingSection");
  }
  async handleRecentSectionChange(id: boolean): Promise<void> {
    Application.invalidateDiscoverSections();
    await this.updateValue(id, "recentSection");
  }
  isEnabled(id: string) {
    return !getDeletedDiscoverySections().some((item) => item.id === id);
  }
}

class FilterSettings extends BaseSettings {
  constructor(private filter: ComixFilter) {
    super();
  }

  get genresMap() {
    return this.filter.genres.map(({ value, id }) => ({ title: value, id }));
  }

  get demogMap() {
    return this.filter.demographic.map(({ value, id }) => ({
      title: value,
      id,
    }));
  }

  get typeMap() {
    return this.filter.contentType.map(({ value, id }) => ({
      title: value,
      id,
    }));
  }

  override getSections() {
    return [
      Section(
        {
          id: "update_settings",
          footer: "Tags Settings",
        },
        [
          SelectRow("hide_genres", {
            title: "Hide Genres",
            subtitle: "Hide Some Genre",
            layout: "list",
            value: this.filter.getHiddenGenresSettings(),
            items: this.genresMap,
            minItemCount: 0,
            maxItemCount: this.genresMap.length,
            onValueChange: Application.Selector(
              this as FilterSettings,
              "handleHideGenresStatusChange",
            ),
          }),
          SelectRow("hide_demog", {
            title: "Hide Demographic Type",
            subtitle: "Hide Some Demographic Type",
            layout: "list",
            value: this.filter.getHiddenDemogSettings(),
            items: this.demogMap,
            minItemCount: 0,
            maxItemCount: this.demogMap.length,
            onValueChange: Application.Selector(
              this as FilterSettings,
              "handleHideDemogStatusChange",
            ),
          }),
        ],
      ),
      Section(
        {
          id: "type_settings",
          footer: "Type Settings",
        },
        [
          SelectRow("type", {
            title: "Content Type",
            subtitle: "Show Only this type of content",
            layout: "list",
            value: this.filter.getShowOnlySettings(),
            items: this.typeMap,
            minItemCount: 0,
            maxItemCount: this.typeMap.length,
            onValueChange: Application.Selector(
              this as FilterSettings,
              "handleShowOnlyStatusChange",
            ),
          }),
        ],
      ),
      Section(
        {
          id: "content_rating",
          footer: "Content Rating",
        },
        [
          SelectRow("content_rating", {
            title: "Content Rating",
            value: this.filter.getDefaultContentRatingSettings(),
            items: this.filter.contentRating,
            layout: "list",
            maxItemCount: 1,
            minItemCount: 1,
            onValueChange: Application.Selector(
              this as FilterSettings,
              "handleContentRatingStatusChange",
            ),
          }),
        ],
      ),
      Section(
        {
          id: "reset_settings",
          footer: "Reset Settings",
        },
        [
          ButtonRow("reset_genres", {
            title: "Reset all Filters",
            onSelect: Application.Selector(
              this as FilterSettings,
              "resetFiltersDialog",
            ),
          }),
        ],
      ),
    ];
  }

  async handleHideGenresStatusChange(id: string[]) {
    Application.invalidateDiscoverSections();
    await this.updateValue(id, "hide_genres");
  }

  async handleContentRatingStatusChange(id: string[]) {
    await this.updateValue(id, "content_rating");
  }

  async handleHideDemogStatusChange(id: string[]) {
    Application.invalidateDiscoverSections();
    await this.updateValue(id, "hide_demog");
  }

  async handleShowOnlyStatusChange(id: string[]) {
    Application.invalidateDiscoverSections();
    await this.updateValue(id, "show_only");
  }
  async resetFiltersDialog() {
    throw new FormConfirmationError(
      Application.Selector(this as FilterSettings, "resetFilters"),
      "Do you want to reset all values?",
    );
  }
  async resetFilters() {
    Application.invalidateDiscoverSections();
    await this.updateValue([], "hide_genres");
    await this.updateValue([], "show_only");
    await this.updateValue([], "hide_demog");
  }
}
