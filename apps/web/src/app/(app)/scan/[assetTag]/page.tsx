import type { Metadata } from 'next';
import { machineAssetTagSchema } from '@app/shared';
import { ScannedMachine } from '@/components/scanned-machine';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ assetTag: string }>;
}): Promise<Metadata> {
  const parsed = machineAssetTagSchema.safeParse((await params).assetTag);
  return {
    robots: { follow: false, index: false },
    title: parsed.success ? `Asset ${parsed.data}` : 'Asset not found',
  };
}

export default async function ScannedAssetPage({
  params,
}: {
  params: Promise<{ assetTag: string }>;
}) {
  return <ScannedMachine rawAssetTag={(await params).assetTag} />;
}
