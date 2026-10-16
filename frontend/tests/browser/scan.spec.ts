import { fileURLToPath } from 'node:url';
import type { Page, Request } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { json, type MockApi } from './fixtures/api';
import type { ConfigResponse } from '../../src/lib/api/settings';
import { config, createdItem, detectedItems } from './fixtures/data';
import { readDrafts } from './helpers/recovery';
import { analyzePhotos, selectLocation, uploadPhoto } from './helpers/scan';

async function readStoredSession(page: Page) {
	const drafts = await readDrafts(page, 'deployment:user:g1');
	return drafts[0] ?? null;
}

async function createConfirmedScan(page: Page, itemName: string, manufacturer?: string) {
	await selectLocation(page);
	await uploadPhoto(page);
	await analyzePhotos(page);
	await page.getByLabel('Name').fill(itemName);
	if (manufacturer) {
		await page.getByRole('button', { name: 'Extended Fields' }).click();
		await page.getByLabel('Manufacturer').fill(manufacturer);
	}
	await page.getByRole('button', { name: 'Confirm' }).click();
	await expect(page).toHaveURL(/\/summary$/);
}

test('reediting a confirmed item preserves its asset ID and edited custom fields through submission', async ({
	page,
	api,
}) => {
	const creations: unknown[] = [];
	const updates: unknown[] = [];
	api.on('POST', '/api/tools/vision/detect', () =>
		json({
			...detectedItems(['Desk lamp']),
			items: [{ name: 'Desk lamp', quantity: 1, custom_fields: { Warranty: 'One year' } }],
		})
	);
	api.on('POST', '/api/items', (request) => {
		creations.push(request.postDataJSON());
		return json(createdItem('lamp-1'));
	});
	api.on('POST', '/api/items/lamp-1/attachments', () => json({}));
	api.on('PUT', '/api/items/lamp-1', (request) => {
		updates.push(request.postDataJSON());
		return json({});
	});

	await selectLocation(page);
	await uploadPhoto(page);
	await analyzePhotos(page);
	await page.getByLabel('Asset ID', { exact: true }).fill('000-042');
	await page.getByLabel('Warranty', { exact: true }).fill('Two years');
	await page.getByRole('button', { name: 'Confirm', exact: true }).click();
	await expect(page).toHaveURL(/\/summary$/);
	await page.getByRole('button', { name: 'Edit item', exact: true }).click();
	await expect(page.getByLabel('Asset ID', { exact: true })).toHaveValue('000-042');
	await expect(page.getByLabel('Warranty', { exact: true })).toHaveValue('Two years');
	await page.getByLabel('Name', { exact: true }).fill('Edited desk lamp');
	await page.getByRole('button', { name: 'Confirm', exact: true }).click();
	await page.getByRole('button', { name: /Submit All Items/ }).click();
	await expect(page).toHaveURL(/\/success$/);
	expect(creations).toEqual([
		expect.objectContaining({
			items: [
				expect.objectContaining({
					name: 'Edited desk lamp',
					custom_fields: { Warranty: 'Two years' },
				}),
			],
		}),
	]);
	expect(updates).toEqual([{ assetId: '000-042' }]);
});

test('submits a corrected item to the selected location with its photo', async ({ page, api }) => {
	const creations: unknown[] = [];
	const uploads: Request[] = [];
	api.on('POST', '/api/tools/vision/detect', () => json(detectedItems(['Unlabeled lamp'])));
	api.on('POST', '/api/items', (request) => {
		creations.push(request.postDataJSON());
		return json(createdItem('lamp-1'));
	});
	api.on('POST', '/api/items/lamp-1/attachments', (request) => {
		uploads.push(request);
		return json({});
	});

	await createConfirmedScan(page, 'Desk lamp', 'Lumina');
	await page.getByRole('button', { name: /Submit All Items/ }).click();

	await expect(page).toHaveURL(/\/success$/);
	await expect(page.getByRole('heading', { name: 'Success!' })).toBeVisible();
	await expect(page.getByText('1 item added to Storage')).toBeVisible();
	expect(creations).toEqual([
		{
			location_id: 'loc-1',
			items: [
				expect.objectContaining({
					name: 'Desk lamp',
					manufacturer: 'Lumina',
				}),
			],
		},
	]);
	expect(uploads).toHaveLength(1);
	expect(uploads[0].headers()['content-type']).toContain('multipart/form-data');
	expect(uploads[0].postDataBuffer()?.byteLength).toBeGreaterThan(0);
});

test('reload recovers a UI-created scan and its confirmed edits', async ({ page, api }) => {
	api.allowPageError(/navigation aborted/);
	api.on('POST', '/api/tools/vision/detect', () => json(detectedItems(['Unlabeled camera'])));

	await createConfirmedScan(page, 'Recovered camera', 'Acme Optics');
	await expect
		.poll(async () => readStoredSession(page))
		.toMatchObject({
			confirmedItems: [
				expect.objectContaining({ name: 'Recovered camera', manufacturer: 'Acme Optics' }),
			],
		});

	await page.reload();
	await expect(page).toHaveURL(/\/location$/);
	await page.getByRole('button', { name: 'Resume Session' }).click();
	await expect(page).toHaveURL(/\/summary$/);
	await expect(page.getByText('Recovered camera', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Edit item' }).click();
	await expect(page.getByLabel('Manufacturer')).toHaveValue('Acme Optics');
});

test('Start Fresh clears the persisted scan created through the UI', async ({ page, api }) => {
	api.on('POST', '/api/tools/vision/detect', () => json(detectedItems(['Draft radio'])));

	await createConfirmedScan(page, 'Draft radio');
	await expect.poll(async () => readStoredSession(page)).not.toBeNull();

	await page.reload();
	await expect(page).toHaveURL(/\/location$/);
	await page.getByRole('button', { name: 'Start Fresh' }).click();
	await expect.poll(async () => readStoredSession(page)).toBeNull();

	await page.reload();
	await expect(page).toHaveURL(/\/location$/);
	await expect(page.getByRole('button', { name: 'Resume Session' })).toHaveCount(0);
});

const intakeConfig = (overrides: Partial<ConfigResponse>) => () =>
	json(config('api_key', overrides));

/** Scan a QR code through the scanner dialog's upload path (no camera in tests). */
async function scanQrCode(page: Page, rawValue: string) {
	await page.addInitScript((value) => {
		Object.defineProperty(window, 'BarcodeDetector', {
			configurable: true,
			value: class {
				static async getSupportedFormats() {
					return ['qr_code'];
				}
				async detect() {
					return [
						{
							rawValue: value,
							cornerPoints: [
								{ x: 0, y: 0 },
								{ x: 1, y: 0 },
								{ x: 1, y: 1 },
								{ x: 0, y: 1 },
							],
						},
					];
				}
			},
		});
		navigator.mediaDevices.getUserMedia = async () => {
			throw new DOMException('Camera unavailable in test', 'NotAllowedError');
		};
	}, rawValue);
	await page.goto('/location');
	await page.getByRole('button', { name: 'Scan QR Code' }).click();
	const photo = fileURLToPath(
		new URL('../../../tests/assets/multi_item_single_image.jpg', import.meta.url)
	);
	await page.getByRole('dialog').locator('input[type="file"]').setInputFiles(photo);
}

const boxUuid = '0a1b2c3d-0000-4000-8000-000000000001';
const partsBox = {
	id: 'box-1',
	name: 'Parts box',
	asset_id: '000-001',
	location_id: 'loc-1',
	location_name: 'Storage',
	parent_id: 'loc-1',
};

async function analyzeAndSubmit(page: Page, api: MockApi) {
	api.on('POST', '/api/tools/vision/detect', () => json(detectedItems(['Desk lamp'])));
	await page.getByRole('button', { name: 'Continue to Capture' }).click();
	await expect(page).toHaveURL(/\/capture$/);
	await uploadPhoto(page);
	await analyzePhotos(page);
	await page.getByRole('button', { name: 'Confirm', exact: true }).click();
	await expect(page).toHaveURL(/\/summary$/);
	await page.getByRole('button', { name: /Submit All Items/ }).click();
	await expect(page).toHaveURL(/\/success$/);
}

function multipartText(request: Request) {
	return request.postDataBuffer()?.toString('latin1') ?? '';
}

test('uploads the capture photos once to the selected location after items are created', async ({
	page,
	api,
}) => {
	const intakeUploads: Request[] = [];
	api.on('GET', '/api/config', intakeConfig({ container_intake_photos: true }));
	api.on('POST', '/api/tools/vision/detect', () => json(detectedItems(['Unlabeled lamp'])));
	api.on('POST', '/api/items', () => json(createdItem('lamp-1')));
	api.on('POST', '/api/items/lamp-1/attachments', () => json({}));
	api.on('POST', '/api/locations/loc-1/attachments', (request) => {
		intakeUploads.push(request);
		return json({});
	});

	await createConfirmedScan(page, 'Desk lamp');
	await page.getByRole('button', { name: /Submit All Items/ }).click();

	await expect(page).toHaveURL(/\/success$/);
	expect(intakeUploads).toHaveLength(1);
	const body = multipartText(intakeUploads[0]);
	expect(body).toMatch(/filename="intake-\d{8}-\d{6}-1\.jpg"/);
	expect(body).toMatch(/name="primary"\r\n\r\ntrue/);
});

test('item QR codes select the box as parent and receive the intake photos', async ({
	page,
	api,
}) => {
	const creations: unknown[] = [];
	const intakeUploads: Request[] = [];
	api.on('GET', '/api/config', intakeConfig({ container_intake_photos: true }));
	api.on('GET', `/api/items/${boxUuid}`, () => json(partsBox));
	api.on('POST', '/api/items', (request) => {
		creations.push(request.postDataJSON());
		return json(createdItem('lamp-1'));
	});
	api.on('POST', '/api/items/lamp-1/attachments', () => json({}));
	api.on('POST', '/api/items/box-1/attachments', (request) => {
		intakeUploads.push(request);
		return json({});
	});

	await scanQrCode(page, `https://homebox.example/item/${boxUuid}`);
	await expect(page.getByText('Inside: Parts box')).toBeVisible();
	await analyzeAndSubmit(page, api);

	expect(creations).toEqual([
		{
			location_id: 'loc-1',
			items: [expect.objectContaining({ name: 'Desk lamp', parent_id: 'box-1' })],
		},
	]);
	expect(intakeUploads).toHaveLength(1);
	expect(multipartText(intakeUploads[0])).toMatch(/name="primary"\r\n\r\ntrue/);
});

test('asset QR codes resolve to the box before selecting it as parent', async ({ page, api }) => {
	api.on('GET', '/api/items/by-asset/000-001', () => json(partsBox));

	await scanQrCode(page, 'https://homebox.example/a/000-001');

	await expect(page.getByText('Inside: Parts box')).toBeVisible();
	expect(api.requests.map((request) => new URL(request.url()).pathname)).toContain(
		'/api/items/by-asset/000-001'
	);
});

test('unrecognised QR codes show an error and select nothing', async ({ page }) => {
	await scanQrCode(page, 'WIFI:S:guest;T:WPA;P:secret;;');

	await expect(page.locator('p', { hasText: /Invalid QR code/ })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Continue to Capture' })).toHaveCount(0);
});

test('skip item photos leaves new items without per-item uploads', async ({ page, api }) => {
	api.on('GET', '/api/config', intakeConfig({ skip_item_photos: true }));
	api.on('POST', '/api/tools/vision/detect', () => json(detectedItems(['Unlabeled lamp'])));
	api.on('POST', '/api/items', () => json(createdItem('lamp-1')));
	// No attachment routes are declared: any upload would fail the test as an undeclared request.

	await createConfirmedScan(page, 'Desk lamp');
	await page.getByRole('button', { name: /Submit All Items/ }).click();

	await expect(page).toHaveURL(/\/success$/);
	expect(api.requests.filter((request) => request.url().includes('/attachments'))).toEqual([]);
});

test('an intake upload failure warns without failing the created items', async ({ page, api }) => {
	api.on('GET', '/api/config', intakeConfig({ container_intake_photos: true }));
	api.on('POST', '/api/tools/vision/detect', () => json(detectedItems(['Unlabeled lamp'])));
	api.on('POST', '/api/items', () => json(createdItem('lamp-1')));
	api.on('POST', '/api/items/lamp-1/attachments', () => json({}));
	api.on('POST', '/api/locations/loc-1/attachments', () => json({ detail: 'File too large' }, 413));

	await createConfirmedScan(page, 'Desk lamp');
	await page.getByRole('button', { name: /Submit All Items/ }).click();

	await expect(page).toHaveURL(/\/success$/);
	await expect(
		page.locator('p', { hasText: /photo\(s\) could not be attached to the location/ })
	).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Success!' })).toBeVisible();
});
