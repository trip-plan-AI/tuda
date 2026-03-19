import { Suspense } from 'react';
import { AIAssistantPage } from '@/views/ai-assistant';

export default function Page() {
  return (
    <Suspense fallback={<div className="w-full h-screen" />}>
      <AIAssistantPage />
    </Suspense>
  );
}
