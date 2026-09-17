import { expect, test } from '@playwright/test';

test('shows the Vue DICOM study loader', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveTitle('DICOMassist');
  await expect(page.getByTestId('dicom-drop-zone')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Browse folder' })).toBeVisible();
  await expect(page.getByText('Not for clinical diagnosis')).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test('loads the bundled sample into the Vue viewer and opens analysis chat', async ({ page }) => {
  test.setTimeout(60_000);
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Try sample knee MRI' }).click();
  await expect(page.getByRole('button', { name: 'Analyze' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.getByRole('heading', { name: 'Analysis chat' })).toBeVisible();
  await page.getByLabel('Open settings').click();
  await page.getByRole('button', { name: 'Deep analysis' }).click();
  await expect(page.getByLabel('Max images')).toHaveValue('32');
  await expect(page.getByLabel('Refinement rounds')).toHaveValue('2');
  expect(runtimeErrors).toEqual([]);
});
