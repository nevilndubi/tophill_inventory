import { HealthConnection } from '@/components/health-connection';
import { StatusLanguage } from '@/components/status-language';
import { requireCurrentAppUser } from '@/lib/auth/current-user';

export default async function HomePage() {
  await requireCurrentAppUser('/');

  return (
    <div>
      <div className="max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Hospital equipment, ready at a glance
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
          The workspace is ready for equipment tracking and booking.
        </p>
      </div>

      <div className="mt-8 max-w-xl">
        <HealthConnection />
      </div>

      <StatusLanguage />
    </div>
  );
}
