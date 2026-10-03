'use client';
import { use } from 'react';
import { notFound } from 'next/navigation';
import { Check } from 'lucide-react';
import { PLANNED } from '@/components/nav';
import { Card, PageHeader } from '@/components/ui';

export default function PlannedModulePage({ params }: { params: Promise<{ module: string }> }) {
  const { module } = use(params);
  const m = PLANNED[module];
  if (!m) notFound();
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={m.title} subtitle={`Planned for Phase ${m.phase}. The module switch already exists in Settings.`} />
      <Card>
        <div className="flex items-start gap-4">
          <div className="rounded-xl bg-brand/10 p-3 text-brand"><m.icon className="h-6 w-6" /></div>
          <ul className="space-y-2 text-sm">
            {m.features.map((f) => (
              <li key={f} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 text-emerald-500" />{f}</li>
            ))}
          </ul>
        </div>
      </Card>
    </div>
  );
}
