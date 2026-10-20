export default function Loading() {
  return (
    <div aria-label="Loading workspace" role="status" className="animate-pulse">
      <div className="h-10 w-full max-w-2xl rounded-md bg-muted" />
      <div className="mt-4 h-5 w-full max-w-xl rounded-md bg-muted" />
      <div className="mt-8 h-40 w-full max-w-xl rounded-lg border border-border bg-card" />
      <span className="sr-only">Loading workspace</span>
    </div>
  );
}
