import { NextRequest, NextResponse } from "next/server";

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

function scanToolOutput(toolName: string, output: string) {
  const threats: Threat[] = [];

  for (let i = 0; i < output.length; i++) {
    if (ZERO_WIDTH_CHARS[output[i]])
      threats.push({ kind: "HIDDEN_CHARACTER", charPos: i, raw: `invisible char ${ZERO_WIDTH_CHARS[output[i]]}` });
  }

  for (let i = 0; i < output.length; i++) {
    if (CONFUSABLES[output[i]])
      threats.push({ kind: "HOMOGLYPH_ATTACK", charPos: i, raw: `'${output[i]}' looks like '${CONFUSABLES[output[i]]}'` });
  }

  for (const { regex, kind } of INJECTION_PATTERNS) {
    let m; regex.lastIndex = 0;
    while ((m = regex.exec(output)) !== null)
      threats.push({ kind, charPos: m.index, raw: m[0].length > 60 ? m[0].slice(0, 60) + "…" : m[0] });
  }

  for (const { regex } of INDIRECT_PATTERNS) {
    let m; regex.lastIndex = 0;
    while ((m = regex.exec(output)) !== null)
      threats.push({ kind: "INDIRECT_INJECTION", charPos: m.index, raw: m[0].length > 60 ? m[0].slice(0, 60) + "…" : m[0] });
  }

  threats.sort((a, b) => a.charPos - b.charPos);

  let sanitized = output;
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

  return { toolName, threats, sanitized, isSuspicious: threats.length > 0 };
}

export async function POST(req: NextRequest) {
  const { toolName, output } = await req.json();
  if (typeof toolName !== "string" || typeof output !== "string")
    return NextResponse.json({ error: "toolName and output must be strings" }, { status: 400 });
  const result = scanToolOutput(toolName.slice(0, 100), output.slice(0, 5000));
  return NextResponse.json(result);
}
