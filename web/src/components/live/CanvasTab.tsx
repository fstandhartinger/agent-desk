import { lazy, Suspense } from 'react';

const LiveCanvasPanel = lazy(() => import('../../canvas/LiveCanvasPanel'));

export default function CanvasTab() {
  return <Suspense fallback={null}><LiveCanvasPanel /></Suspense>;
}
