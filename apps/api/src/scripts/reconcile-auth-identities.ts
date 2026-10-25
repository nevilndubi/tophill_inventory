import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { createClient } from '@supabase/supabase-js';
import { parseApiEnvironment } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { SupabaseAdminService } from '../auth/supabase-admin.service';

const run = async (): Promise<void> => {
  const environment = parseApiEnvironment(process.env);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
  });
  const supabase = createClient(environment.SUPABASE_URL, environment.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });

  try {
    const identityIds = await new SupabaseAdminService(supabase).listIdentityIds();
    const linked = await prisma.user.findMany({
      select: { supabaseUserId: true },
      where: { isSeedData: false, supabaseUserId: { in: [...identityIds] } },
    });
    const linkedIds = new Set(linked.flatMap((user) => user.supabaseUserId ?? []));
    const orphanIds = identityIds.filter((id) => !linkedIds.has(id)).sort();

    process.stdout.write(
      `${JSON.stringify({ identityIds: orphanIds, orphanCount: orphanIds.length })}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
};

run().catch(() => {
  process.stderr.write(
    'Authentication identity reconciliation failed without exposing credentials.\n',
  );
  process.exitCode = 1;
});
