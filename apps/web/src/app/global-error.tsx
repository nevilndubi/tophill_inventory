'use client';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
          <h1>Tophill Inventory could not start</h1>
          <p>Reload the application. If the problem continues, contact the administrator.</p>
          <button type="button" onClick={reset}>
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
