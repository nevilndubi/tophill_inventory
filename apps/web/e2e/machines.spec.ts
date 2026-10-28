import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const ids = {
  category: '11111111-1111-4111-8111-111111111111',
  department: '22222222-2222-4222-8222-222222222222',
  location: '33333333-3333-4333-8333-333333333333',
  machine: '44444444-4444-4444-8444-444444444444',
  created: '55555555-5555-4555-8555-555555555555',
};

const category = {
  defaultMaxBookingMinutes: 240,
  defaultServiceIntervalDays: 90,
  description: 'Life support equipment',
  id: ids.category,
  is_deletable: false,
  machine_count: 1,
  name: 'Ventilators',
};
const department = {
  code: 'ICU',
  id: ids.department,
  is_deletable: false,
  location_count: 1,
  machine_count: 1,
  manager: null,
  name: 'Intensive Care',
  user_count: 2,
};
const location = {
  building: 'Main',
  department: { code: department.code, id: department.id, name: department.name },
  floor: '1',
  id: ids.location,
  is_deletable: false,
  machine_count: 1,
  name: 'ICU Bay A',
  room: 'A-01',
};
const machine = {
  allowBookingWhenNeedsService: false,
  assetTag: 'HM-000061',
  bufferMinutes: 15,
  category: { id: category.id, name: category.name },
  commissionedOn: '2025-01-02',
  condition: 'OPERATIONAL',
  department: { code: department.code, id: department.id, name: department.name },
  description: 'Adult intensive-care ventilator',
  id: ids.machine,
  isBookable: true,
  registryStatus: 'ACTIVE',
  lastServicedAt: '2026-09-01T06:00:00.000Z',
  location: { id: location.id, name: location.name },
  manufacturer: 'acme medical',
  maxBookingMinutes: 240,
  model: 'Breath Pro',
  name: 'ICU Ventilator 01',
  nextServiceDueAt: '2026-11-30T06:00:00.000Z',
  purchaseDate: '2024-12-01',
  requiresApproval: true,
  serialNumber: 'vent-0001',
  serviceIntervalDays: 90,
  warrantyExpiresOn: '2027-12-01',
};

const envelope = (data: unknown, meta?: Record<string, unknown>) => ({
  data,
  ...(meta ? { meta } : {}),
});

async function mockApi(page: Page) {
  let currentMachine = { ...machine };
  let attachments: Array<Record<string, unknown>> = [];
  await page.route('https://storage.test/**', async (route) => {
    if (route.request().method() === 'PUT') return route.fulfill({ status: 200 });
    return route.fulfill({ body: '%PDF-1.7\n%%EOF', contentType: 'application/pdf', status: 200 });
  });
  await page.route('http://127.0.0.1:3001/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/machines/import/template')
      return route.fulfill({
        body: 'name,category,manufacturer,model,serial_number,department,location_department,location,description,purchase_date,warranty_expires_on,commissioned_on,service_interval_days,last_serviced_at,is_bookable,requires_approval,allow_booking_when_needs_service,max_booking_minutes,buffer_minutes\r\n',
        contentType: 'text/csv; charset=utf-8',
        headers: { 'content-disposition': 'attachment; filename="machine-import-template-v1.csv"' },
        status: 200,
      });
    if (url.pathname === '/api/v1/machines/import' && request.method() === 'POST') {
      const content = request.postData() ?? '';
      const rejected = content.includes('BAD-DATE');
      const commit = url.searchParams.get('mode') !== 'dry_run';
      return route.fulfill({
        json: envelope({
          can_commit: !rejected,
          committed_count: commit && !rejected ? 1 : 0,
          file_sha256: 'a'.repeat(64),
          mode: url.searchParams.get('mode') ?? 'dry_run',
          rows: [
            {
              errors: rejected
                ? [
                    {
                      code: 'IMPORT_FIELD_INVALID',
                      field: 'purchase_date',
                      message: 'Purchase date must use YYYY-MM-DD',
                    },
                  ]
                : [],
              preview: {
                manufacturer: 'acme',
                name: 'Import ventilator',
                serial_number: 'import-001',
              },
              row: 2,
              status: rejected ? 'rejected' : 'create',
              warnings: [],
            },
          ],
          summary: {
            create: rejected ? 0 : 1,
            rejected: rejected ? 1 : 0,
            skipped_conflict: 0,
            skipped_existing: 0,
            skipped_existing_deleted: 0,
          },
          template_version: 'v1',
        }),
      });
    }
    if (url.pathname === '/api/v1/categories') return route.fulfill({ json: envelope([category]) });
    if (url.pathname === '/api/v1/departments')
      return route.fulfill({ json: envelope([department]) });
    if (url.pathname === '/api/v1/locations')
      return route.fulfill({ json: envelope([location], { page: 1, pageSize: 200, total: 1 }) });
    if (url.pathname === '/api/v1/machines' && request.method() === 'GET') {
      const registry = url.searchParams.get('registry') ?? 'active';
      const visible =
        registry === 'all' ||
        (registry === 'active' && currentMachine.registryStatus === 'ACTIVE') ||
        (registry === 'deleted' && currentMachine.registryStatus === 'DELETED');
      return route.fulfill({
        json: envelope(visible ? [currentMachine] : [], {
          page: 1,
          pageSize: 25,
          total: visible ? 1 : 0,
        }),
      });
    }
    if (url.pathname === '/api/v1/machines' && request.method() === 'POST')
      return route.fulfill({
        json: envelope({
          ...machine,
          assetTag: 'HM-000062',
          id: ids.created,
          name: 'New Theatre Ventilator',
        }),
      });
    if (url.pathname.startsWith('/api/v1/machines/by-tag/')) {
      const tag = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      if (tag === machine.assetTag && currentMachine.registryStatus === 'ACTIVE')
        return route.fulfill({ json: envelope(currentMachine) });
      return route.fulfill({
        status: 404,
        json: {
          error: { code: 'MACHINE_NOT_FOUND', details: {}, message: 'Machine not found' },
        },
      });
    }
    if (url.pathname === `/api/v1/machines/${ids.machine}` && request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(body).toEqual({ name: 'ICU Ventilator Updated' });
      currentMachine = { ...currentMachine, ...body };
      return route.fulfill({ json: envelope(currentMachine) });
    }
    if (url.pathname === `/api/v1/machines/${ids.machine}` && request.method() === 'DELETE') {
      expect(request.postDataJSON()).toEqual({ reason: 'Registry record correction' });
      currentMachine = { ...currentMachine, registryStatus: 'DELETED' };
      return route.fulfill({ json: envelope(currentMachine) });
    }
    if (url.pathname === `/api/v1/machines/${ids.machine}/restore` && request.method() === 'POST') {
      currentMachine = { ...currentMachine, registryStatus: 'ACTIVE' };
      return route.fulfill({ json: envelope(currentMachine) });
    }
    if (url.pathname === `/api/v1/machines/${ids.machine}/attachments`)
      return route.fulfill({ json: envelope(attachments) });
    if (url.pathname === `/api/v1/machines/${ids.machine}/attachments/sign-upload`)
      return route.fulfill({
        json: envelope({
          expiresAt: '2026-10-27T10:15:00.000Z',
          intentToken: 'intent-redacted',
          uploadUrl: 'https://storage.test/upload-redacted',
        }),
      });
    if (url.pathname === '/api/v1/attachments/confirm') {
      const created = {
        fileName: 'inspection.pdf',
        id: '66666666-6666-4666-8666-666666666666',
        sizeBytes: 14,
        typeLabel: 'PDF document',
        uploadedAt: '2026-10-27T10:00:00.000Z',
        uploader: { fullName: 'Test administrator' },
      };
      attachments = [created];
      return route.fulfill({ json: envelope(created) });
    }
    if (url.pathname === '/api/v1/attachments/66666666-6666-4666-8666-666666666666/url')
      return route.fulfill({
        json: envelope({
          expiresAt: '2026-10-27T10:05:00.000Z',
          url: 'https://storage.test/download-redacted',
        }),
      });
    if (
      url.pathname === '/api/v1/attachments/66666666-6666-4666-8666-666666666666' &&
      request.method() === 'DELETE'
    ) {
      const deleted = attachments[0];
      attachments = [];
      return route.fulfill({ json: envelope(deleted) });
    }
    if (url.pathname === `/api/v1/machines/${ids.created}`)
      return route.fulfill({
        json: envelope({
          ...machine,
          assetTag: 'HM-000062',
          id: ids.created,
          name: 'New Theatre Ventilator',
        }),
      });
    if (url.pathname === `/api/v1/machines/${ids.machine}`) {
      if (
        currentMachine.registryStatus === 'DELETED' &&
        url.searchParams.get('include_deleted') !== 'true'
      ) {
        return route.fulfill({
          status: 404,
          json: {
            error: { code: 'MACHINE_NOT_FOUND', details: {}, message: 'Machine not found' },
          },
        });
      }
      return route.fulfill({ json: envelope(currentMachine) });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND', details: {}, message: 'Not found' } },
    });
  });
}

async function rolePage(context: BrowserContext, role: string) {
  await context.setExtraHTTPHeaders({ 'x-e2e-role': role });
  const page = await context.newPage();
  await mockApi(page);
  return page;
}

test('BIOMED_TECH can view and submit a changed-field-only edit', async ({ context }) => {
  const page = await rolePage(context, 'BIOMED_TECH');
  await page.goto('/machines');
  await expect(page.getByRole('heading', { name: 'Machines' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Register machine' })).toHaveCount(0);
  await page.getByRole('link', { name: machine.name }).first().click();
  await expect(page).toHaveURL(new RegExp(`/machines/${ids.machine}`));
  await expect(page.getByText(machine.assetTag)).toHaveCount(1);
  await page.getByRole('link', { name: 'Edit machine' }).click();
  await page.getByLabel('Machine name').fill('ICU Ventilator Updated');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/machines/${ids.machine}$`));
  await expect(page.getByRole('heading', { name: 'ICU Ventilator Updated' })).toBeVisible();
});

test('ADMIN can register a machine and sees its generated asset tag', async ({ context }) => {
  const page = await rolePage(context, 'ADMIN');
  await page.goto('/machines/new');
  await page.getByLabel('Machine name').fill('New Theatre Ventilator');
  await page.getByLabel('Category').selectOption(ids.category);
  await page.getByLabel('Manufacturer').fill('Acme Medical');
  await page.getByLabel('Model').fill('Breath Pro');
  await page.getByLabel('Serial number').fill('VENT-0002');
  await page.getByLabel('Owning department').selectOption(ids.department);
  await page.getByLabel('Location', { exact: true }).selectOption(ids.location);
  await page.getByRole('button', { name: 'Register machine' }).click();
  await expect(page).toHaveURL(new RegExp(`/machines/${ids.created}$`));
  await expect(page.getByText(/Machine registered as HM-000062/)).toBeVisible();
  await expect(page.getByText(/can leave gaps/i)).toBeVisible();
});

test('ADMIN downloads the template, validates messy CSV and confirms a clean CSV', async ({
  context,
}) => {
  const page = await rolePage(context, 'ADMIN');
  await page.goto('/machines/import');
  await expect(page.getByRole('heading', { name: 'Import machines' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download template' }).click();
  expect((await download).suggestedFilename()).toBe('machine-import-template-v1.csv');

  await page.getByLabel('Choose machine import CSV').setInputFiles({
    buffer: Buffer.from('header\nBAD-DATE'),
    mimeType: 'text/csv',
    name: 'messy.csv',
  });
  await page.getByRole('button', { name: 'Preview and validate' }).click();
  await expect(page.getByText(/Purchase date must use YYYY-MM-DD/)).toBeVisible();

  await page.getByLabel('Choose machine import CSV').setInputFiles({
    buffer: Buffer.from('header\nclean'),
    mimeType: 'text/csv',
    name: 'clean.csv',
  });
  await page.getByRole('button', { name: 'Preview and validate' }).click();
  await expect(page.getByText('Import ventilator')).toBeVisible();
  await page.getByRole('button', { name: 'Import all rows' }).click();
  await expect(page.getByText(/1 machines were registered/)).toBeVisible();
});

test('roles without machine:create cannot open import directly', async ({ context }) => {
  const page = await rolePage(context, 'BIOMED_TECH');
  await page.goto('/machines/import');
  await expect(page).toHaveURL(/\/forbidden$/);
});

test('a read-only role cannot open the registration form directly', async ({ context }) => {
  const page = await rolePage(context, 'STAFF');
  await page.goto('/machines/new');
  await expect(page).toHaveURL(/\/forbidden$/);
  await expect(page.getByText('403 — Permission denied')).toBeVisible();
});

test('ADMIN can upload, view and delete a private machine attachment', async ({ context }) => {
  const page = await rolePage(context, 'ADMIN');
  await page.goto(`/machines/${ids.machine}?tab=files`);
  await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible();
  await expect(page.getByText('No files yet')).toBeVisible();
  await page.getByLabel('Choose attachment').setInputFiles({
    buffer: Buffer.from('%PDF-1.7\n%%EOF'),
    mimeType: 'application/pdf',
    name: 'inspection.pdf',
  });
  await expect(page.getByText('inspection.pdf')).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('heading', { name: 'Delete inspection.pdf?' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete attachment' }).click();
  await expect(page.getByText('No files yet')).toBeVisible();
});

test('ADMIN removes and restores a machine while QR lookup and files follow registry visibility', async ({
  context,
}) => {
  const page = await rolePage(context, 'ADMIN');
  await page.goto(`/machines/${ids.machine}?tab=files`);
  await page.getByLabel('Choose attachment').setInputFiles({
    buffer: Buffer.from('%PDF-1.7\n%%EOF'),
    mimeType: 'application/pdf',
    name: 'inspection.pdf',
  });
  await expect(page.getByText('inspection.pdf')).toBeVisible();

  await page.getByRole('button', { name: 'Remove from active registry' }).click();
  await page.getByLabel('Reason (required)').fill('Registry record correction');
  await page.getByRole('button', { name: 'Remove machine' }).click();
  await expect(page).toHaveURL(/\/machines\?registry=deleted$/);
  await expect(
    page
      .getByText(/Removed from (?:active )?registry/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();

  await page.goto(`/scan/${machine.assetTag}`);
  await expect(page.getByText('Machine not found')).toBeVisible();
  await page.goto(`/machines/${ids.machine}?tab=files`);
  await expect(page.getByText('Removed from the active registry')).toBeVisible();
  await expect(page.getByText(/Attachments remain private and hidden/)).toBeVisible();
  await expect(page.getByText('inspection.pdf')).toHaveCount(0);

  await page.getByRole('button', { name: 'Restore to active registry' }).click();
  await page.getByRole('button', { name: 'Restore machine' }).click();
  await expect(page).toHaveURL(new RegExp(`/machines/${ids.machine}$`));
  await page.goto(`/scan/${machine.assetTag}`);
  await expect(page.getByRole('heading', { name: machine.name })).toBeVisible();
  await page.goto(`/machines/${ids.machine}?tab=files`);
  await expect(page.getByText('inspection.pdf')).toBeVisible();
});

test('read-only roles cannot request deleted registry views or see registry controls', async ({
  context,
}) => {
  const page = await rolePage(context, 'STAFF');
  await page.goto('/machines');
  await expect(page.getByLabel('Registry visibility')).toHaveCount(0);
  await page.getByRole('link', { name: machine.name }).first().click();
  await expect(page.getByRole('button', { name: /active registry/i })).toHaveCount(0);
});

test('mobile QR journey preserves the scan target through login and shows the machine', async ({
  browser,
}) => {
  const context = await browser.newContext({
    extraHTTPHeaders: { 'x-e2e-auth': 'signed-out', 'x-e2e-role': 'STAFF' },
    viewport: { height: 800, width: 360 },
  });
  const page = await context.newPage();
  await mockApi(page);
  await page.goto(`/scan/${machine.assetTag}`);
  await expect(page).toHaveURL(new RegExp(`/login\\?returnTo=%2Fscan%2F${machine.assetTag}$`));
  await page.getByLabel('Email address').fill('browser@example.invalid');
  await page.getByLabel('Password').fill('not-a-real-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`/scan/${machine.assetTag}$`));
  await expect(page.getByRole('heading', { name: machine.name })).toBeVisible();
  await expect(page.getByText('Operational')).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/scan/${machine.assetTag}$`));
  await expect(page.getByRole('heading', { name: machine.name })).toBeVisible();
  await page.screenshot({ fullPage: true, path: '.artifacts/task-3.6/scan-mobile.png' });
  await context.close();
});

test('unknown QR tags use the safe not-found view without leaking lookup detail', async ({
  context,
}) => {
  const page = await rolePage(context, 'VIEWER');
  await page.goto('/scan/HM-999999');
  await expect(page.getByText('Machine not found')).toBeVisible();
  await expect(page.getByText(/check the printed tag/i)).toBeVisible();
});

test('bulk label selection uses one matching-list call and produces exact physical presets', async ({
  context,
}) => {
  const page = await rolePage(context, 'ADMIN');
  let matchingCalls = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/machines' && url.searchParams.get('pageSize') === '100') {
      matchingCalls += 1;
    }
  });
  await page.goto('/machines');
  await page.getByRole('button', { name: 'Select all matching' }).click();
  await expect(page.getByText('1 matching machine selected.')).toBeVisible();
  expect(matchingCalls).toBe(1);
  await page.getByRole('link', { name: 'Print labels (1)' }).click();
  const sheetCell = page.locator('.machine-label--sheet').first();
  await expect(sheetCell).toBeVisible();
  const cellBox = await sheetCell.boundingBox();
  expect(cellBox?.width).toBeCloseTo(264.57, 0);
  expect(cellBox?.height).toBeCloseTo(139.84, 0);
  await page.goto(`/machines/${ids.machine}/label`);
  const single = page.locator('.machine-label--single');
  await expect(single).toBeVisible();
  const singleBox = await single.boundingBox();
  expect(singleBox?.width).toBeCloseTo(377.95, 0);
  expect(singleBox?.height).toBeCloseTo(188.98, 0);
});

for (const width of [360, 768, 1280]) {
  test(`deleted registry workflow remains usable at ${width}px`, async ({ browser }) => {
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-e2e-role': 'ADMIN' },
      viewport: { height: 900, width },
    });
    const page = await context.newPage();
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await mockApi(page);
    await page.goto(`/machines/${ids.machine}`);
    await page.getByRole('button', { name: 'Remove from active registry' }).click();
    await page.getByLabel('Reason (required)').fill('Registry record correction');
    await page.getByRole('button', { name: 'Remove machine' }).click();
    await expect(page).toHaveURL(/\/machines\?registry=deleted$/);
    await expect(
      page
        .getByText(/Removed from (?:active )?registry/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    await page.screenshot({
      fullPage: true,
      path: `.artifacts/task-3.8/deleted-registry-${width}.png`,
    });
    expect(browserErrors).toEqual([]);
    await context.close();
  });
}

for (const width of [360, 768, 1280]) {
  test(`scan and single-label views remain usable at ${width}px`, async ({ browser }) => {
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-e2e-role': 'ADMIN' },
      viewport: { height: 900, width },
    });
    const page = await context.newPage();
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    await mockApi(page);
    await page.goto(`/scan/${machine.assetTag}`);
    await expect(page.getByRole('heading', { name: machine.name })).toBeVisible();
    await page.screenshot({
      fullPage: true,
      path: `.artifacts/task-3.6/scan-${width}.png`,
    });
    await page.goto(`/machines/${ids.machine}/label`);
    await expect(page.getByRole('heading', { name: 'Print asset label' })).toBeVisible();
    await page.screenshot({
      fullPage: true,
      path: `.artifacts/task-3.6/label-${width}.png`,
    });
    expect(browserErrors).toEqual([]);
    await context.close();
  });
}

for (const width of [360, 768, 1280]) {
  test(`machine import remains usable at ${width}px`, async ({ browser }) => {
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-e2e-role': 'ADMIN' },
      viewport: { height: 900, width },
    });
    const page = await context.newPage();
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await mockApi(page);
    await page.goto('/machines/import');
    await expect(page.getByRole('heading', { name: 'Import machines' })).toBeVisible();
    await page.screenshot({
      fullPage: true,
      path: `.artifacts/task-3.7/import-${width}.png`,
    });
    expect(browserErrors).toEqual([]);
    await context.close();
  });
}

for (const width of [360, 768, 1280]) {
  test(`machine list remains usable at ${width}px`, async ({ browser }) => {
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-e2e-role': 'ADMIN' },
      viewport: { height: 900, width },
    });
    const page = await context.newPage();
    await mockApi(page);
    await page.goto('/machines');
    await expect(page.getByRole('heading', { name: 'Machines' })).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'ICU Ventilator 01' }).filter({ visible: true }).first(),
    ).toBeVisible();
    await page.screenshot({
      fullPage: true,
      path: `.artifacts/task-3.4/machines-${width}.png`,
    });
    await context.close();
  });
}
