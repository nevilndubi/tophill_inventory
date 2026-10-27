import type { Metadata } from 'next';
import { ScanLanding } from '@/components/scan-landing';

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: 'Scan asset',
};

export default function ScanPage() {
  return <ScanLanding />;
}
