import type { DanmakuData, DanmakuItem } from "../types";

const ILLEGAL_XML = /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g;
const DANMAKU_TAG = /<d\b([^>]*?)(?:\/>|>([\s\S]*?)<\/d>)/g;
const P_ATTRIBUTE = /\bp\s*=\s*(?:"([^"]*)"|'([^']*)')/;

function stripIllegalXmlChars(xml: string): string {
  return xml.replace(/^\uFEFF/, "").replace(ILLEGAL_XML, "");
}

/** 越界码点（> U+10FFFF）直接丢掉：String.fromCodePoint 会抛 RangeError，整段弹幕就废了。 */
function decodeCodePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : "";
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => decodeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => decodeCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readPAttribute(attributes: string): string | undefined {
  const match = attributes.match(P_ATTRIBUTE);
  return match?.[1] ?? match?.[2];
}

function normalizeText(raw: string): string {
  const trimmed = raw.trim();
  const cdata = trimmed.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return decodeXmlEntities(cdata ? (cdata[1] ?? "") : trimmed).trim();
}

function parseDanmakuTag(match: RegExpMatchArray): DanmakuItem | null {
  const attributes = match[1] ?? "";
  const p = readPAttribute(attributes);
  if (!p) return null;
  const parts = p.split(",");
  const time = Number(parts[0]);
  const mode = Number(parts[1] ?? "1");
  if (!Number.isFinite(time) || !Number.isFinite(mode)) return null;
  // 高级弹幕（7）与代码弹幕（8）的正文是 JSON / 脚本，不是观众的话，不进证据。
  if (mode === 7 || mode === 8) return null;
  const text = normalizeText(match[2] ?? "");
  if (!text) return null;
  return { time, mode, text };
}

export function parseDanmakuXml(xml: string): DanmakuData {
  const cleaned = stripIllegalXmlChars(xml);
  const items: DanmakuItem[] = [];
  for (const match of cleaned.matchAll(DANMAKU_TAG)) {
    const item = parseDanmakuTag(match);
    if (item) items.push(item);
  }
  return { items: items.sort((a, b) => a.time - b.time) };
}
