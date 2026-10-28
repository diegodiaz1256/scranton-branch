/**
 * Settings search: matching over the individual settings, not just the tabs.
 *
 * The Settings modal used to filter its seven tabs by the tab's name, a
 * one-line description and a handful of extra words. Searching for an actual
 * setting ("notificaciones", "telemetry", "modo simple") found nothing, and a
 * hit never pointed at the row it was about. Here every setting is a row of
 * the index, with its visible label and help text in the current UI language
 * plus the English text and a few English synonyms, so either language finds
 * it.
 *
 * Pure: no React, no i18next. The caller hands in translators.
 */

/** One setting, as declared by the UI that renders it. */
export interface SettingDef {
  /** Unique id. Also the DOM anchor (`data-setting-id`) unless `anchor` is set. */
  id: string;
  /** The tab it lives in (the Settings modal's Section value). */
  section: string;
  /** DOM anchor to scroll to when several settings share one block. */
  anchor?: string;
  /** i18n key of the visible label. */
  label: string;
  /** i18n key of the help text under it. */
  desc?: string;
  /** More i18n keys whose text should match but is not shown in results. */
  extra?: string[];
  /** English synonyms, searchable, never shown. */
  keywords?: string;
  /** A whole tab rather than one setting: on a tie, settings rank first. */
  isSection?: boolean;
}

export interface IndexedSetting {
  id: string;
  section: string;
  anchor: string;
  /** Label in the current UI language, for the result row. */
  label: string;
  /** Folded label text (both languages). */
  labelHay: string;
  /** Folded text of everything searchable. */
  hay: string;
  isSection: boolean;
}

export type Translate = (key: string) => string;

/** Lowercase and strip accents, so "configuración" matches "configuracion". */
export function foldText(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** The words of a query, folded. Punctuation splits words like spaces do. */
export function queryWords(query: string): string[] {
  return foldText(query).split(/[\s,.;:/()"'¿?¡!]+/).filter(Boolean);
}

/** A translator answers with the key itself when it has no string; that is
 *  not text worth matching ("settings.general.foo" would match "general"). */
const txt = (t: Translate, key: string | undefined): string => {
  if (!key) return '';
  const v = t(key);
  return typeof v === 'string' && v !== key ? v : '';
};

/**
 * Resolve the definitions into searchable rows. `t` is the current language;
 * `tEn` (optional) adds the English text so an English word still finds a
 * setting while the UI is in Spanish.
 */
export function indexSettings(defs: readonly SettingDef[], t: Translate, tEn?: Translate): IndexedSetting[] {
  return defs.map((d) => {
    const label = txt(t, d.label) || d.id;
    const labelEn = tEn ? txt(tEn, d.label) : '';
    const parts = [label, labelEn, txt(t, d.desc), tEn ? txt(tEn, d.desc) : ''];
    for (const k of d.extra ?? []) parts.push(txt(t, k), tEn ? txt(tEn, k) : '');
    parts.push(d.keywords ?? '', d.id);
    return {
      id: d.id,
      section: d.section,
      anchor: d.anchor ?? d.id,
      label,
      labelHay: foldText(`${label} ${labelEn}`),
      hay: foldText(parts.join(' ')),
      isSection: d.isSection === true
    };
  });
}

const startsWord = (hay: string, w: string): boolean => {
  let i = hay.indexOf(w);
  while (i !== -1) {
    if (i === 0 || !/[a-z0-9]/.test(hay[i - 1])) return true;
    i = hay.indexOf(w, i + 1);
  }
  return false;
};

/**
 * Every word of the query must appear somewhere in the row. Rows whose label
 * holds the words, and words that start a word rather than sit inside one,
 * rank first; on a tie a setting beats a whole tab, then index order (the
 * order the settings appear on screen) decides.
 */
export function searchSettings(index: readonly IndexedSetting[], query: string, limit = 40): IndexedSetting[] {
  const words = queryWords(query);
  if (!words.length) return [];
  const scored: Array<{ row: IndexedSetting; score: number; i: number }> = [];
  index.forEach((row, i) => {
    let score = 0;
    for (const w of words) {
      if (!row.hay.includes(w)) return;
      if (startsWord(row.labelHay, w)) score += 4;
      else if (row.labelHay.includes(w)) score += 3;
      else if (startsWord(row.hay, w)) score += 2;
      else score += 1;
    }
    scored.push({ row, score, i });
  });
  scored.sort((a, b) => b.score - a.score || Number(a.row.isSection) - Number(b.row.isSection) || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.row);
}
