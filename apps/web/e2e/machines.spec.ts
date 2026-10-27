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
    if (url.pathname === '/api/v1/categories') return route.fulfill({ json: envelope([category]) });
    if (url.pathname === '/api/v1/departments')
      return route.fulfill({ json: envelope([department]) });
    if (url.pathname === '/api/v1/locations')
      return route.fulfill({ json: envelope([location], { page: 1, pageSize: 200, total: 1 }) });
    if (url.pathname === '/api/v1/machines' && request.method() === 'GET')
      return route.fulfill({
        json: envelope([currentMachine], { page: 1, pageSize: 25, total: 1 }),
      });
    if (url.pathname === '/api/v1/machines' && request.method() === 'POST')
      return route.fulfill({
        json: envelope({
          ...machine,
          assetTag: 'HM-000062',
          id: ids.created,
          name: 'New Theatre Ventilator',
        }),
      });
    if (url.pathname === `/api/v1/machines/${ids.machine}` && request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(body).toEqual({ name: 'ICU Ventilator Updated' });
      currentMachine = { ...currentMachine, ...body };
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
    if (url.pathname === `/api/v1/machines/${ids.machine}`)
      return route.fulfill({ json: envelope(currentMachine) });
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
