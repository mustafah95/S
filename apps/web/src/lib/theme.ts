import type { Branding } from '@sofia/shared';

/** Apply branding colours from Settings → Branding as CSS custom properties (no rebuild needed). */
export function applyBranding(b: Pick<Branding, 'colors'> | null | undefined): void {
  if (!b?.colors) return;
  const root = document.documentElement.style;
  root.setProperty('--brand-primary', b.colors.primary);
  root.setProperty('--brand-primary-dark', b.colors.primaryDark);
  root.setProperty('--brand-secondary', b.colors.secondary);
  root.setProperty('--brand-accent', b.colors.accent);
  root.setProperty('--brand-bg', b.colors.background);
  root.setProperty('--brand-surface', b.colors.surface);
  root.setProperty('--brand-text', b.colors.text);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', b.colors.primaryDark);
}
