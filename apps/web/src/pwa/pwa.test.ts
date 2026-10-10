import { describe, expect, it } from 'vitest';
import manifestText from '../../public/manifest.webmanifest?raw';
import indexHtml from '../../index.html?raw';
import swSource from '../../public/sw.js?raw';

// Icons are loaded as base64 data URLs so the test needs no Node typings.
const pngs = import.meta.glob<string>('../../public/**/*.png', {
  query: '?inline',
  import: 'default',
  eager: true,
});

function pngSize(dataUrl: string): { width: number; height: number } {
  const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect(Array.from(bytes.slice(0, 8))).toEqual(signature);
  const view = new DataView(bytes.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function findPng(publicPath: string): string | undefined {
  const key = Object.keys(pngs).find((k) => k.endsWith(`/public${publicPath}`));
  return key ? pngs[key] : undefined;
}

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
const manifest = JSON.parse(manifestText) as Record<string, unknown> & { icons: Icon[] };

describe('web app manifest', () => {
  it('has the required fields', () => {
    expect(manifest.name).toBe('Orient');
    expect(manifest.short_name).toBe('Orient');
    expect(manifest.lang).toBe('en');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBe('portrait');
    expect(typeof manifest.description).toBe('string');
    expect(manifest.background_color).toBe('#faf9f5');
    expect(manifest.theme_color).toBe('#faf9f5');
  });

  it('declares 192 and 512 icons and a maskable icon', () => {
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it.each(manifest.icons.map((i) => [i.src, i] as const))('icon %s exists with the declared size', (src, icon) => {
    const data = findPng(src);
    expect(data, `${src} is missing from public/`).toBeDefined();
    const { width, height } = pngSize(data!);
    expect(`${width}x${height}`).toBe(icon.sizes);
    expect(icon.type).toBe('image/png');
  });
});

describe('index.html', () => {
  it('links the manifest, icons and iOS meta tags', () => {
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(indexHtml).toContain('rel="apple-touch-icon"');
    expect(indexHtml).toContain('apple-mobile-web-app-capable');
    expect(indexHtml).toContain('name="theme-color" content="#faf9f5"');
  });

  it('references icon files that exist at the declared size', () => {
    const touch = findPng('/icons/apple-touch-icon.png');
    expect(touch).toBeDefined();
    expect(pngSize(touch!)).toEqual({ width: 180, height: 180 });
    const favicon = findPng('/favicon-32.png');
    expect(favicon).toBeDefined();
    expect(pngSize(favicon!)).toEqual({ width: 32, height: 32 });
  });
});

describe('service worker', () => {
  it('does not cache or intercept requests', () => {
    expect(swSource).not.toMatch(/addEventListener\(\s*['"]fetch['"]/);
    expect(swSource).not.toMatch(/caches\./);
  });
});
