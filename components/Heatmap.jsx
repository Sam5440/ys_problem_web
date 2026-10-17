'use client';

import { cn } from '@/lib/utils';

const CELL = 11;
const PITCH = 13;
const GUTTER = 36;
const TOP = 20;

// Fills mirror the upstream wall (#EBEDF0 empty / #40C463 one / #216E39 both /
// #CBCDF0 skipped), adapted to the dark tokens of this site.
const FILL_EMPTY = 'var(--muted)';
const FILL_SKIPPED = 'oklch(0.42 0.06 300 / 55%)';
const FILL_ONE = 'oklch(0.52 0.11 152)';
const FILL_BOTH = 'oklch(0.72 0.17 152)';

const WEEKDAY_LABELS = [
  { row: 1, text: '一' },
  { row: 3, text: '三' },
  { row: 5, text: '五' },
];
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

const DAY_MS = 86400000;

function toUTC(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`);
}
function fmt(date) {
  return date.toISOString().slice(0, 10);
}
function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function describe(date, score, skipped) {
  if (skipped) return `${date} · 上游未放题`;
  if (score === 2) return `${date} · 两题全对`;
  if (score === 1) return `${date} · 做出 1 题`;
  if (score === 0) return `${date} · 未提交`;
  return `${date} · 尚未参与`;
}

/**
 * GitHub-style contribution wall for one player.
 * `series` is the player's per-day scores (oldest first), `skipped` the dates
 * upstream published no problem — those days simply have no cell.
 */
export default function Heatmap({ series, currentDate, skipped = [], window: windowKind = 'year' }) {
  const skippedSet = skipped instanceof Set ? skipped : new Set(skipped);
  const scoreByDate = new Map(series.map((d) => [d.date, d.score]));

  const end = toUTC(currentDate);
  let start = windowKind === 'all' && series.length ? toUTC(series[0].date) : addDays(end, -52 * 7 + 1);
  start = addDays(start, -start.getUTCDay()); // align columns to Sunday

  const weeks = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const date = fmt(d);
    const isSkipped = skippedSet.has(date);
    const score = isSkipped ? undefined : scoreByDate.get(date);
    const weekIdx = Math.floor((d - start) / DAY_MS / 7);
    if (!weeks[weekIdx]) weeks[weekIdx] = { days: new Array(7).fill(null), first: null };
    const week = weeks[weekIdx];
    if (!week.first) week.first = new Date(d);
    week.days[d.getUTCDay()] = { date, score, skipped: isSkipped && score === undefined };
  }
  // Label a column when its month changes, but never on the first (partial)
  // column and never closer than 3 columns to the previous label — otherwise
  // two labels collide into e.g. "9月10月".
  const labelCols = new Map();
  let lastLabelCol = -Infinity;
  weeks.forEach((week, col) => {
    if (!week?.first) return;
    const prev = weeks[col - 1];
    if (col > 0 && prev?.first && week.first.getUTCMonth() !== prev.first.getUTCMonth() && col - lastLabelCol >= 3) {
      labelCols.set(col, MONTHS[week.first.getUTCMonth()]);
      lastLabelCol = col;
    }
  });

  const width = GUTTER + weeks.length * PITCH;
  const height = TOP + 7 * PITCH + 4;

  return (
    <figure className="space-y-2">
      <div className="overflow-x-auto pb-1">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto max-w-full"
          role="img"
          aria-label="每日打卡热力图"
        >
          {WEEKDAY_LABELS.map(({ row, text }) => (
            <text key={row} x={GUTTER - 8} y={TOP + row * PITCH + 9} textAnchor="end" fontSize="9" fill="var(--muted-foreground)">
              {text}
            </text>
          ))}
          {weeks.map((week, col) => {
            const nodes = [];
            if (labelCols.has(col)) {
              nodes.push(
                <text key={`m-${col}`} x={GUTTER + col * PITCH} y="11" fontSize="9" fill="var(--muted-foreground)">
                  {labelCols.get(col)}
                </text>,
              );
            }
            week.days.forEach((day, row) => {
              if (!day) return;
              const fill = day.skipped
                ? FILL_SKIPPED
                : day.score === 2
                  ? FILL_BOTH
                  : day.score === 1
                    ? FILL_ONE
                    : FILL_EMPTY;
              nodes.push(
                <rect key={day.date} x={GUTTER + col * PITCH} y={TOP + row * PITCH} width={CELL} height={CELL} rx="2.5" fill={fill}>
                  <title>{describe(day.date, day.score, day.skipped)}</title>
                </rect>,
              );
            });
            return <g key={col}>{nodes}</g>;
          })}
        </svg>
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          少
          <i className="inline-block size-2.5 rounded-[3px]" style={{ background: FILL_EMPTY }} />
          <i className="inline-block size-2.5 rounded-[3px]" style={{ background: FILL_ONE }} />
          <i className="inline-block size-2.5 rounded-[3px]" style={{ background: FILL_BOTH }} />
          多
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block size-2.5 rounded-[3px]" style={{ background: FILL_SKIPPED }} />
          未放题
        </span>
        <span className={cn('hidden sm:inline')}>未提交 / 尚未参与为灰色空格</span>
      </figcaption>
    </figure>
  );
}
