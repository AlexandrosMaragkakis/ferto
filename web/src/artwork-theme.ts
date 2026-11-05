type RGB = [number, number, number];

const CACHE_KEY = "ferto-artwork-palettes-v1";
const CACHE_LIMIT = 64;
const PALETTE_PROPERTIES = [
  "--paper", "--panel", "--ink", "--line", "--muted", "--focus", "--accent", "--accent-ink", "--accent-edge",
  "--ambient", "--ambient-soft", "--control", "--control-edge", "--control-ink",
];

function hex(rgb: RGB): string {
  return `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function hsl(color: string): [number, number] {
  const [r, g, b] = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  if (delta === 0) return [0, 0];
  const hue = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [(hue * 60 + 360) % 360, delta / (1 - Math.abs(max + min - 1))];
}

function shade(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1)), m = lightness - chroma / 2;
  const channels: RGB = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x]
    : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return hex(channels.map((value) => (value + m) * 255) as RGB);
}

function luminance(color: string): number {
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}

function mix(base: string, tint: string, amount: number): string {
  return hex([1, 3, 5].map((offset) => {
    const start = Number.parseInt(base.slice(offset, offset + 2), 16);
    return start + (Number.parseInt(tint.slice(offset, offset + 2), 16) - start) * amount;
  }) as RGB);
}

/** Sample a tiny canvas; the original artwork stays untouched. */
function artworkColor(image: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, 32, 32);
    const pixels = context.getImageData(0, 0, 32, 32).data;
    const buckets = new Map<number, { weight: number; rgb: RGB; count: number }>();
    let count = 0, colorful = 0, gray = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 128) continue;
      const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
      count++;
      gray += .2126 * r + .7152 * g + .0722 * b;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      // Skip black borders, white lettering and nearly gray pixels when
      // selecting a colour. A mostly monochrome cover stays monochrome.
      if (max < 30 || min > 230 || max - min < 28) continue;
      colorful++;
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      const bucket = buckets.get(key) ?? { weight: 0, rgb: [0, 0, 0], count: 0 };
      // Prefer a visible colour over the same hue buried in deep shadows.
      bucket.weight += (.2 + (max - min) / 255) * (max / 255);
      bucket.rgb[0] += r; bucket.rgb[1] += g; bucket.rgb[2] += b; bucket.count++;
      buckets.set(key, bucket);
    }
    if (!count) return null;
    if (colorful / count < .12) return hex([gray / count, gray / count, gray / count]);
    const dominant = [...buckets.values()].sort((a, b) => b.weight - a.weight)[0];
    return dominant ? hex(dominant.rgb.map((value) => value / dominant.count) as RGB) : null;
  } catch {
    // Canvas may be unavailable or the image host may forbid pixel access.
    return null;
  }
}

/** Local-only palette cache: no API calls or database writes. */
export class ArtworkTheme {
  private readonly cache = new Map<string, string>();
  private color: string | null = null;

  constructor(private readonly root: HTMLElement) {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}");
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        for (const [url, color] of Object.entries(stored).slice(-CACHE_LIMIT)) {
          if (url.length <= 4096 && typeof color === "string" && /^#[\da-f]{6}$/i.test(color)) this.cache.set(url, color);
        }
      }
    } catch { /* A palette must never depend on storage availability. */ }
  }

  cached(url: string): string | null {
    const color = this.cache.get(url);
    if (!color) return null;
    this.cache.delete(url);
    this.cache.set(url, color);
    return color;
  }

  sample(image: HTMLImageElement, url: string): void {
    const color = artworkColor(image);
    if (color) {
      this.cache.delete(url);
      this.cache.set(url, color);
      while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(this.cache))); } catch { /* Keep the memory cache. */ }
    }
    this.show(color);
  }

  show(color: string | null): void {
    this.color = color;
    this.apply();
  }

  apply(): void {
    if (!this.color) {
      delete this.root.dataset.artworkColor;
      for (const property of PALETTE_PROPERTIES) this.root.style.removeProperty(property);
    } else {
      this.root.dataset.artworkColor = this.color;
      const [hue, rawSaturation] = hsl(this.color);
      const saturation = Math.min(rawSaturation, .8);
      const dark = this.root.classList.contains("dark");
      // Keep the page quiet and put the album's colour into the atmosphere.
      // A little artwork tint gives the ivory Next button a warmer finish.
      const accent = dark ? mix("#f0e9dc", shade(hue, saturation * .4, .82), .12)
        : shade(hue, saturation * .42, .24);
      const lightContrast = 1.05 / (luminance(accent) + .05);
      const darkContrast = (luminance(accent) + .05) / .05;
      const ink = shade(hue, saturation * .1, dark ? .94 : .12);
      const values = [
        shade(hue, saturation * .24, dark ? .028 : .96),
        shade(hue, saturation * .22, dark ? .055 : .985),
        ink,
        shade(hue, saturation * .12, dark ? .25 : .78),
        shade(hue, saturation * .08, dark ? .70 : .31),
        shade(hue, saturation * .35, dark ? .78 : .28),
        accent, lightContrast > darkContrast ? "#ffffff" : "#000000",
        dark ? mix("#c6bcaa", shade(hue, saturation * .4, .6), .12) : shade(hue, saturation * .4, .20),
        // Even unblended glow colours keep normal text and focus readable.
        shade(hue, saturation * (dark ? .85 : .5), dark ? .145 : .84),
        shade(hue, saturation * (dark ? .65 : .25), dark ? .09 : .93),
        shade(hue, saturation * .16, dark ? .14 : .98),
        shade(hue, saturation * .15, dark ? .34 : .76),
        ink,
      ];
      PALETTE_PROPERTIES.forEach((property, index) => this.root.style.setProperty(property, values[index]));
    }
    const meta = document.querySelector<HTMLMetaElement>("#theme-color");
    if (meta) meta.content = getComputedStyle(this.root).getPropertyValue("--paper").trim();
  }
}
