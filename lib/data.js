import daily from '@/data/daily.json';

export function getLatestDay() {
  return daily.days[0] ?? null;
}

export function getDay(date) {
  return daily.days.find((d) => d.date === date) ?? null;
}

export function getAllDays() {
  return daily.days;
}

export function getCategories() {
  return daily.categories ?? [];
}

export function getMeta() {
  return { generatedAt: daily.generatedAt, sourceRepo: daily.sourceRepo };
}
