import type { ColorLike } from './types';

/** 归一化 RGBA（每分量 0..1） */
export type RGBA = [number, number, number, number];

const NAMED: Record<string, RGBA> = {
    transparent: [0, 0, 0, 0],
    black: [0, 0, 0, 1],
    white: [1, 1, 1, 1],
    red: [1, 0, 0, 1],
    green: [0, 0.5, 0, 1],
    blue: [0, 0, 1, 1],
    yellow: [1, 1, 0, 1],
    cyan: [0, 1, 1, 1],
    magenta: [1, 0, 1, 1],
    gray: [0.5, 0.5, 0.5, 1],
    grey: [0.5, 0.5, 0.5, 1],
    orange: [1, 0.647, 0, 1],
};

/**
 * 解析颜色为归一化 RGBA。支持：
 *   - 数组 [r,g,b,a]（0..1）
 *   - #rgb / #rgba / #rrggbb / #rrggbbaa
 *   - rgb(r,g,b) / rgba(r,g,b,a)（r/g/b 为 0..255，a 为 0..1）
 *   - 常见颜色名
 * 无法解析时返回 fallback（默认不透明黑）。
 */
export function parseColor(input: ColorLike | undefined, fallback: RGBA = [0, 0, 0, 1]): RGBA {
    if (input == null) return fallback;
    if (Array.isArray(input)) {
        return [clamp01(input[0]), clamp01(input[1]), clamp01(input[2]), clamp01(input[3] ?? 1)];
    }
    const s = input.trim().toLowerCase();

    if (NAMED[s]) return NAMED[s];

    if (s[0] === '#') {
        return parseHex(s) ?? fallback;
    }

    const m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
        const parts = m[1].split(',').map((x) => parseFloat(x.trim()));
        if (parts.length >= 3) {
            return [
                clamp01(parts[0] / 255),
                clamp01(parts[1] / 255),
                clamp01(parts[2] / 255),
                clamp01(parts[3] ?? 1),
            ];
        }
    }
    return fallback;
}

function parseHex(s: string): RGBA | null {
    let hex = s.slice(1);
    // 展开 #rgb / #rgba 短写
    if (hex.length === 3 || hex.length === 4) {
        hex = hex.split('').map((c) => c + c).join('');
    }
    if (hex.length !== 6 && hex.length !== 8) return null;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return [r / 255, g / 255, b / 255, a];
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
