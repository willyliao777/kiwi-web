import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/auth";

const ZERO_WIDTH_CHARS: Record<string, string> = {
  "​": "U+200B Zero Width Space",
  "‌": "U+200C Zero Width Non-Joiner",
  "‍": "U+200D Zero Width Joiner",
  "‎": "U+200E Left-to-Right Mark",
  "‏": "U+200F Right-to-Left Mark",
  "﻿": "U+FEFF BOM / Zero Width No-Break Space",
  "­": "U+00AD Soft Hyphen",
  "⁠": "U+2060 Word Joiner",
};

const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p",
  "с": "c", "х": "x", "В": "B", "Е": "E",
  "К": "K", "М": "M", "Н": "H", "О": "O",
  "Р": "P", "С": "C", "Т": "T", "У": "Y", "Х": "X",
};

const INJECTION_PATTERNS = [
  { regex: /<\/?[a-z_][a-z0-9_-]*(\s[^>]*)?>/gi, kind: "SCRIPT_TAG" },
  { regex: /\[([A-Z][A-Z0-9_\s]*:?[^\]]*)\]/g,   kind: "COMMAND_INJECTION" },
  { regex: /\{\{\{[^}]*\}\}\}/g,                   kind: "BRACE_OVERRIDE" },
  { regex: /\{\{[^}]+\}\}/g,                       kind: "BRACE_OVERRIDE" },
  { regex: /<\|[^|]+\|>/g,                         kind: "SPECIAL_TOKEN" },
];

const INDIRECT_PATTERNS = [
  { regex: /\bignore\s+(all\s+|previous\s+|prior\s+)?instructions\b/gi },
  { regex: /\bforget\s+(everything|all(\s+previous)?|what\s+you\s+were\s+told)\b/gi },
  { regex: /\bdisregard\s+(the\s+above|previous(\s+instructions)?|your\s+instructions)\b/gi },
  { regex: /\bnew\s+(instructions?|task|directive|objective)\s*:/gi },
  { regex: /<!--[\s\S]*?-->/g },
  { regex: /\bnote\s+to\s+(ai|llm|assistant|chatgpt|claude|gpt)\b/gi },
  { regex: /\bdear\s+(ai|assistant|llm)\b/gi },
  { regex: /\byour\s+(new|real|actual|true)\s+(instructions?|task|purpose|goal)\s+(is|are)\b/gi },
  { regex: /\b(do\s+not|don't|stop)\s+follow(ing)?\s+(previous\s+|the\s+)?instructions\b/gi },
];

interface Threat { kind: string; charPos: number; raw: string; }
interface ChunkResult { index: number; threats: Threat[]; sanitized: string; isSuspicious: boolean; }

function scanChunk(text: string, index: number): ChunkResult {
  const threats: Threat[] = [];

  for (let i = 0; i < text.length; i++) {
    if (ZERO_WIDTH_CHARS[text[i]])
      threats.push({ kind: "HIDDEN_CHARACTER", charPos: i, raw: `invisible char ${ZERO_WIDTH_CHARS[text[i]]}` });
  }

  for (let i = 0; i < text.length; i++) {
    if (CONFUSABLES[text[i]])
      threats.push({ kind: "HOMOGLYPH_ATTACK", charPos: i, raw: `'${text[i]}' looks like '${CONFUSABLES[text[i]]}'` });
  }

  for (const { regex, kind } of INJECTION_PATTERNS) {
    let m; regex.lastIndex = 0;
    while ((m = regex.exec(text)) !== null)
      threats.push({ kind, charPos: m.index, raw: m[0].length > 60 ? m[0].slice(0, 60) + "…" : m[0] });
  }

  for (const { regex } of INDIRECT_PATTERNS) {
    let m; regex.lastIndex = 0;
    while ((m = regex.exec(text)) !== null)
      threats.push({ kind: "INDIRECT_INJECTION", charPos: m.index, raw: m[0].length > 60 ? m[0].slice(0, 60) + "…" : m[0] });
  }

  threats.sort((a, b) => a.charPos - b.charPos);

  let sanitized = text;
  for (const char of Object.keys(ZERO_WIDTH_CHARS)) sanitized = sanitized.split(char).join("");
  for (const [from, to] of Object.entries(CONFUSABLES)) sanitized = sanitized.split(from).join(to);
  for (const { regex, kind } of INJECTION_PATTERNS) {
    regex.lastIndex = 0;
    sanitized = sanitized.replace(regex, (m) =>
      kind === "SCRIPT_TAG"
        ? `[neutralized-tag: ${m.replace(/<\/?/g, "").replace(/>/g, "")}]`
        : `[context-mention: ${m.replace(/^\[|\]$/g, "").replace(/^\{\{\{|\}\}\}$/g, "").replace(/^\{\{|\}\}$/g, "").trim()}]`
    );
  }
  for (const { regex } of INDIRECT_PATTERNS) {
    regex.lastIndex = 0;
    sanitized = sanitized.replace(regex, (m) => `[neutralized-indirect: ${m.trim()}]`);
  }

  return { index, threats, sanitized, isSuspicious: threats.length > 0 };
}

export async function POST(req: NextRequest) {
  const authError = await requireApiKey(req);
  if (authError) return authError;

  const { chunks } = await req.json();
  if (!Array.isArray(chunks))
    return NextResponse.json({ error: "chunks must be an array" }, { status: 400 });
  const results = chunks
    .slice(0, 20)
    .map((c, i) => scanChunk(typeof c === "string" ? c.slice(0, 2000) : "", i));
  return NextResponse.json({ results });
}
