import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const ids = {
  category: '11111111-1111-4111-8111-111111111111',
  department: '22222222-2222-4222-8222-222222222222',
  location: '33333333-3333-4333-8333-333333333333',
  machine: '44444444-4444-4444-8444-444444444444',
};

const envelope = (data: unknown) => ({ data });

async function mockStatusApi(page: Page) {
  let inUse = false;
  let boardRequests = 0;
  await page.route('http://127.0.0.1:3001/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/categories')
      return route.fulfill({ json: envelope([{ id: ids.category, name: 'Ventilators' }]) });
    if (url.pathname === '/api/v1/departments')
      return route.fulfill({
        json: envelope([{ code: 'TEST', id: ids.department, name: 'Test Department' }]),
      });
    if (url.pathname === '/api/v1/locations')
      return route.fulfill({
        json: envelope({
          items: [
            {
              department: { code: 'TEST', id: ids.department, name: 'Test Department' },
              id: ids.location,
              name: 'Ward A',
            },
          ],
          page: 1,
          pageSize: 200,
          total: 1,
        }),
      });
    if (url.pathname === '/api/v1/status/board') {
      boardRequests += 1;
      return route.fulfill({
        headers: { 'x-board-request': String(boardRequests) },
        json: envelope({
          as_of: new Date().toISOString(),
          counts: {
            AVAILABLE_NEEDS_SERVICE: 1,
            AVAILABLE_OK: inUse ? 0 : 1,
            IN_USE: inUse ? 1 : 0,
            OUT_OF_SERVICE: 1,
            RETIRED: 0,
            UNDER_MAINTENANCE: 0,
          },
          items: [
            {
              as_of: new Date().toISOString(),
              asset_tag: 'HM-000061',
              category: { id: ids.category, name: 'Ventilators' },
              department: { code: 'TEST', id: ids.department, name: 'Test Department' },
              display_status: inUse ? 'IN_USE' : 'AVAILABLE_OK',
              id: ids.machine,
              location: { id: ids.location, name: 'Ward A' },
              name: 'Browser proof ventilator',
              next_booking_at: null,
              open_session: inUse
                ? {
                    expected_end_at: null,
                    held_by_current_user: true,
                    holder: {
                      full_name: 'Browser Test User',
                      id: '00000000-0000-4000-8000-000000000001',
                    },
                    id: '55555555-5555-4555-8555-555555555555',
                    overdue: false,
                    started_at: new Date().toISOString(),
                  }
                : null,
              service_due: false,
              stored_condition: 'OPERATIONAL',
              usable: !inUse,
            },
            {
              as_of: new Date().toISOString(),
              asset_tag: 'HM-000062',
              category: { id: ids.category, name: 'Ventilators' },
              department: { code: 'TEST', id: ids.department, name: 'Test Department' },
              display_status: 'OUT_OF_SERVICE',
              id: '66666666-6666-4666-8666-666666666666',
              location: { id: ids.location, name: 'Ward A' },
              name: 'Unsafe ventilator',
              next_booking_at: null,
              open_session: {
                expected_end_at: null,
                held_by_current_user: false,
                holder: { full_name: 'Masked Holder', id: '77777777-7777-4777-8777-777777777777' },
                id: '88888888-8888-4888-8888-888888888888',
                overdue: false,
                started_at: new Date().toISOString(),
              },
              service_due: false,
              stored_condition: 'OUT_OF_SERVICE',
              usable: false,
            },
          ],
          page: 1,
          page_size: 24,
          total: 2,
        }),
      });
    }
    if (url.pathname === `/api/v1/machines/${ids.machine}/check-out`) {
      inUse = true;
      return route.fulfill({ json: envelope({ id: 'session', machineId: ids.machine }) });
    }
    if (url.pathname === `/api/v1/machines/${ids.machine}/check-in`) {
      inUse = false;
      return route.fulfill({ json: envelope({ id: 'session', machineId: ids.machine }) });
    }
    return route.fulfill({
      json: { error: { code: 'NOT_FOUND', details: {}, message: 'Not found' } },
      status: 404,
    });
  });
  return () => boardRequests;
}

async function statusPage(context: BrowserContext, role = 'ADMIN') {
  await context.setExtraHTTPHeaders({ 'x-e2e-role': role });
  const page = await context.newPage();
  const requestCount = await mockStatusApi(page);
  await page.goto('/status');
  return { page, requestCount };
}

test('status board is responsive, filters views and completes check-out/check-in', async ({
  context,
}) => {
  const { page } = await statusPage(context);
  await expect(page.getByRole('heading', { name: 'Live status' })).toBeVisible();
  await expect(page.getByText('Browser proof ventilator')).toBeVisible();
  await expect(page.getByText(/Still checked out by Masked Holder/)).toBeVisible();

  await page.getByRole('button', { name: 'Table view' }).click();
  await expect(page.getByRole('table', { name: 'Live machine status board' })).toBeVisible();
  await page.getByRole('button', { name: 'Grid view' }).click();
  await page.getByRole('button', { name: 'Check out' }).click();
  await page.getByRole('button', { name: 'Check out' }).last().click();
  await expect(page.getByText('Machine checked out.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check in' })).toBeVisible();
  await page.getByRole('button', { name: 'Check in' }).click();
  await page.getByRole('button', { name: 'Check in' }).last().click();
  await expect(page.getByText('Machine checked in.')).toBeVisible();

  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ height: 900, width });
    await page.screenshot({ fullPage: true, path: `.artifacts/task-4.4/status-${width}.png` });
  }
});

test('polling refreshes without a full-page navigation', async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-e2e-role': 'ADMIN' });
  const page = await context.newPage();
  await page.clock.install();
  const requestCount = await mockStatusApi(page);
  await page.goto('/status');
  await expect(page.getByText('Browser proof ventilator')).toBeVisible();
  const initial = requestCount();
  await page.clock.fastForward(35_000);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(requestCount).toBeGreaterThan(initial);
});

test('read-only roles can view status but never receive quick actions', async ({ context }) => {
  const { page } = await statusPage(context, 'VIEWER');
  await expect(page.getByText('Browser proof ventilator')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check out' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Force end' })).toHaveCount(0);
});
