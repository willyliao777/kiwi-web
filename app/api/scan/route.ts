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
  "Р": "P", "С": "C", "Т": "T", "У": "Y",
  "Х": "X",
};

const INJECTION_PATTERNS = [
  { regex: /<\/?[a-z_][a-z0-9_-]*(\s[^>]*)?>/gi, kind: "SCRIPT_TAG" },
  { regex: /\[([A-Z][A-Z0-9_\s]*:?[^\]]*)\]/g, kind: "COMMAND_INJECTION" },
  { regex: /\{\{\{[^}]*\}\}\}/g, kind: "BRACE_OVERRIDE" },
  { regex: /\{\{[^}]+\}\}/g, kind: "BRACE_OVERRIDE" },
  { regex: /<\|[^|]+\|>/g, kind: "SPECIAL_TOKEN" },
];

interface Threat {
  kind: string;
  charPos: number;
  raw: string;
}

function scanText(text: string): { threats: Threat[]; sanitized: string } {
  const threats: Threat[] = [];

  // Scan zero-width chars
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (ZERO_WIDTH_CHARS[char]) {
      threats.push({ kind: "HIDDEN_CHARACTER", charPos: i, raw: `invisible char ${ZERO_WIDTH_CHARS[char]}` });
    }
  }

  // Scan homoglyphs
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (CONFUSABLES[char]) {
      threats.push({ kind: "HOMOGLYPH_ATTACK", charPos: i, raw: `'${char}' looks like '${CONFUSABLES[char]}'` });
    }
  }

  // Scan injection patterns
  for (const { regex, kind } of INJECTION_PATTERNS) {
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(text)) !== null) {
      const raw = match[0].length > 60 ? match[0].slice(0, 60) + "…" : match[0];
      threats.push({ kind, charPos: match.index, raw });
    }
  }

  threats.sort((a, b) => a.charPos - b.charPos);

  // Sanitize
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

  return { threats, sanitized };
}

export async function POST(req: NextRequest) {
  const authError = await requireApiKey(req);
  if (authError) return authError;

  const { text } = await req.json();
  if (!text || typeof text !== "string") {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  const result = scanText(text.slice(0, 5000));
  return NextResponse.json(result);
}
