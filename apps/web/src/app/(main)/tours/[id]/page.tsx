import { TourDetailPage } from '@/views/tour-detail';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TourDetailPage tourId={parseInt(id, 10)} />;
}
