import { notFound } from 'next/navigation';
import DayView from '@/components/DayView';
import { getDay, getAllDays } from '@/lib/data';
import { formatDateCN } from '@/lib/render';

export const dynamicParams = false;

export function generateStaticParams() {
  return getAllDays().map((d) => ({ date: d.date }));
}

export async function generateMetadata({ params }) {
  const { date } = await params;
  return { title: `${formatDateCN(date)} · 小羊肖恩的每日两题` };
}

export default async function DayPage({ params }) {
  const { date } = await params;
  const day = getDay(date);
  if (!day) notFound();
  return <DayView day={day} latest={false} />;
}
