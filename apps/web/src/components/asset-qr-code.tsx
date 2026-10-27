'use client';

import { useMemo } from 'react';
import { buildCanonicalAssetUrl, createQrMatrix, qrMatrixPath } from '@/lib/machines/asset-labels';

export function AssetQrCode({
  appOrigin,
  assetTag,
  className,
}: {
  appOrigin: string;
  assetTag: string;
  className?: string;
}) {
  const { path, payload, size } = useMemo(() => {
    const nextPayload = buildCanonicalAssetUrl(appOrigin, assetTag);
    const matrix = createQrMatrix(nextPayload);
    return { path: qrMatrixPath(matrix), payload: nextPayload, size: matrix.length };
  }, [appOrigin, assetTag]);

  return (
    <svg
      aria-label={`QR code for asset ${assetTag}`}
      className={className}
      data-qr-payload={payload}
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
