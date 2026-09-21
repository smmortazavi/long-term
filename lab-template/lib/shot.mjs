import fs from 'node:fs';
import path from 'node:path';

/** Save `NN-slug.png` into the run's screenshots folder ($RUN_DIR/screenshots). */
export async function shot(page, step, slug) {
  const dir = path.join(process.env.RUN_DIR, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${String(step).padStart(2, '0')}-${String(slug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'step'}.png`;
  await page.screenshot({ path: path.join(dir, name), fullPage: true });
  return name;
}
