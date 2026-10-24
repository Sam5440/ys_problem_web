import ArchiveClient from '@/components/ArchiveClient';

export const metadata = { title: '历史归档 · Yawn-Sean 的每日两题' };

export default function ArchivePage() {
  return (
    <>
      <section className="py-10">
        <h1 className="text-3xl font-bold tracking-tight">历史归档</h1>
        <p className="mt-2 text-muted-foreground">
          收录全部历史每日两题，点击日期查看当日题目、提示与题解。
        </p>
      </section>
      <ArchiveClient />
    </>
  );
}
