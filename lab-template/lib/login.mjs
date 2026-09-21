// Sign-in helper. Credentials come from the environment only, never from arguments or files.
export const roleEnvKey = (role) =>
  String(role).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();

export const baseUrl = () => (process.env.TARGET_BASE_URL || '').replace(/\/$/, '');

export function credentials(role) {
  const key = roleEnvKey(role);
  const username = process.env[`TARGET_${key}_USERNAME`];
  const password = process.env[`TARGET_${key}_PASSWORD`];
  if (!username) throw new Error(`no credentials for role "${role}" (TARGET_${key}_USERNAME is not set)`);
  return { username, password: password ?? '' };
}

/**
 * Sign in as `role` using the selectors the target defines. Selectors that are
 * blank fall back to common defaults; adjust here if the product's form differs.
 */
export async function login(page, role) {
  const { username, password } = credentials(role);
  const sel = {
    user: process.env.TARGET_LOGIN_USERNAME_FIELD || 'input[name="username"], input[type="email"], #username',
    pass: process.env.TARGET_LOGIN_PASSWORD_FIELD || 'input[type="password"]',
    submit: process.env.TARGET_LOGIN_SUBMIT || 'button[type="submit"]',
    check: process.env.TARGET_LOGIN_CHECK || '',
  };
  await page.goto(baseUrl());
  await page.locator(sel.user).first().fill(username);
  await page.locator(sel.pass).first().fill(password);
  await page.locator(sel.submit).first().click();
  if (sel.check) await page.locator(sel.check).first().waitFor({ timeout: 15000 });
  else await page.waitForLoadState('networkidle');
}
