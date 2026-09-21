export const VERDICTS = ['PASS', 'FAIL', 'UNCERTAIN', 'NEEDS-HUMAN'];

/**
 * The verdict on a report's title line: `# <title> — <ROLE> — <VERDICT>`.
 * Tolerant on purpose, since a model writes the file: trailing `**`, a hyphen
 * for the em dash, or lower case must not turn a finished run into a stuck one.
 * Only the last dash-separated segment counts, so a title containing "fail"
 * is never mistaken for a verdict.
 */
export function parseVerdict(line) {
  let text = String(line).trim().replace(/^#+/, '').trim();
  const segments = text.includes('—') || text.includes('–') ? text.split(/[—–]/) : text.split(' - ');
  const last = segments[segments.length - 1] ?? '';
  const word = last
    .trim()
    .replace(/^[*`_\s]+|[*`_\s]+$/g, '')
    .toUpperCase()
    .replace(/\s+/g, '-');
  return VERDICTS.includes(word) ? word : null;
}

/** The verdict of a whole report: its first non-empty line. */
export function reportVerdict(md) {
  const first = String(md).split('\n').find((l) => l.trim());
  return first ? parseVerdict(first) : null;
}

/** One paragraph of reasoning: under `## Verdict`, else the first paragraph after the title. Capped at 300 chars. */
export function reportSummary(md) {
  const lines = String(md).split('\n');
  let start = lines.findIndex((l) => l.trimStart().startsWith('## Verdict'));
  start = start >= 0 ? start + 1 : lines.findIndex((l) => l.trim()) + 1;
  const para = [];
  for (const l of lines.slice(start)) {
    const t = l.trim();
    if (t.startsWith('#') || t === '') {
      if (para.length) break;
      continue;
    }
    para.push(t);
  }
  const text = para.join(' ');
  return text.length <= 300 ? text : `${text.slice(0, 299)}…`;
}

/** Folder-safe name from a title: lower case, runs of anything else become one dash, at most 48 characters. */
export function slugify(title) {
  const s = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return s || 'scenario';
}

export function uniqueSlug(base, taken) {
  if (!taken(base)) return base;
  for (let n = 2; ; n += 1) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

/** `admin` → `ADMIN`, `shop manager` → `SHOP_MANAGER`: the <ROLE> of TARGET_<ROLE>_USERNAME. */
export function roleEnvKey(role) {
  return String(role)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

/** `NN-<slug>.png`, the only file names served out of a run's screenshot folder. */
export const SCREENSHOT_RE = /^\d{2,3}-[a-z0-9][a-z0-9-]*\.png$/;

export function scenarioTemplate(title) {
  return `# ${title.trim()}

## Preconditions

-

## Role

admin

## Steps

| # | Step | Expected result |
|---|------|-----------------|
| 1 |      |                 |

## Notes

-
`;
}
