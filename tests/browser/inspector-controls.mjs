/** Navigate like a user before exercising a control in the compact inspector. */
export async function inspectorControl(page, selector) {
  const control =
    typeof selector === 'string' ? page.locator(selector) : selector;
  const location = await control.evaluate((element) => {
    if (!element.closest('.inspector')) return null;
    return {
      tab: element
        .closest('[role="tabpanel"]')
        ?.getAttribute('aria-labelledby'),
      context: element.closest('[data-inspector-context]')?.dataset
        .inspectorContext,
    };
  });
  if (!location) return control;
  if (location.context && !(await control.isVisible()))
    await page
      .getByRole('tab', { name: location.context, exact: true })
      .click();
  if (location.tab) {
    const tab = page.locator('#' + location.tab);
    if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  }
  // Ancestors are returned in document order, so outer disclosures open first.
  const details = control.locator('xpath=ancestor::details');
  for (let i = 0; i < (await details.count()); i++) {
    const parent = details.nth(i);
    if (!(await parent.evaluate((element) => element.open)))
      await parent.locator(':scope > summary').click();
  }
  return control;
}
