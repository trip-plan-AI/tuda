import { Suspense } from 'react';
import { PlannerPage } from '@/views/planner';

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PlannerPage />
    </Suspense>
  );
}
