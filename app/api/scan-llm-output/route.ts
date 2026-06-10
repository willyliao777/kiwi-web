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

const LLM_OUTPUT_PATTERNS = [
  { regex: /\bI\s+am\s+now\s+(acting\s+as|pretending\s+to\s+be|operating\s+as|in\s+(developer|jailbreak|dan|unrestricted)\s+mode)\b/gi },
  { regex: /\bI\s+am\s+(DAN|the\s+DAN|a\s+jailbroken(\s+version\s+of)?\s+(an?\s+)?ai|an\s+unrestricted\s+ai|in\s+developer\s+mode)\b/gi },
  { regex: /\bas\s+an\s+ai\s+without\s+(restrictions?|limits?|guidelines?|safety\s+filters?|censorship)\b/gi },
  { regex: /\bI\s+(have\s+been|was|am\s+being)\s+(instructed|told|ordered|directed|programmed)\s+to\b/gi },
  { regex: /\bmy\s+(new|updated|real|actual|true|hidden|secret)\s+instructions\b/gi },
  { regex: /\baccording\s+to\s+(my\s+)?(new|updated|hidden|injected|overriding)\s+instructions\b/gi },
  { regex: /\b(the\s+)?system\s+prompt\s+(is|says|reads|contains|states?)\s*:/gi },
  { regex: /\bmy\s+(original\s+|current\s+|actual\s+|secret\s+)?instructions?\s+(are|say|include|state|were)\s*:/gi },
  { regex: /\bmy\s+(guidelines?|rules?|restrictions?|safety\s+filters?)\s+(have\s+been|were)\s+(updated|changed|removed|lifted|disabled|overridden)\b/gi },
  { regex: /\bI\s+can\s+now\s+.{0,40}without\s+(restrictions?|limits?|safety\s+guidelines?|filters?)\b/gi },
  { regex: /\b(send|transmit|exfiltrate|leak|forward|email|post)\s+(the\s+)?(following|this|user|system|private|confidential)\s+(data|information|content|prompt|credentials?|token)\b/gi },
  { regex: /\b(run|execute|type|enter)\s*:?\s*`?(rm\s+-[rRfFiI]+|DROP\s+TABLE\s+\w+|chmod\s+777|mkfs|format\s+c:|del\s+\/[sf]\s|curl\s+\S+\s*\|\s*(?:ba)?sh|wget\s+\S+\s*\|\s*(?:ba)?sh)/gi },
];

interface Threat { kind: string; charPos: number; raw: string; }

function scanLlmOutput(originalTask: string, output: string) {
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

  for (const { regex } of LLM_OUTPUT_PATTERNS) {
    let m; regex.lastIndex = 0;
    while ((m = regex.exec(output)) !== null)
      threats.push({ kind: "OUTPUT_HIJACK", charPos: m.index, raw: m[0].length > 60 ? m[0].slice(0, 60) + "…" : m[0] });
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
  for (const { regex } of LLM_OUTPUT_PATTERNS) {
    regex.lastIndex = 0;
    sanitized = sanitized.replace(regex, (m) => `[neutralized-hijack: ${m.trim()}]`);
  }

  return { originalTask, threats, sanitized, isSuspicious: threats.length > 0 };
}

export async function POST(req: NextRequest) {
  const authError = await requireApiKey(req);
  if (authError) return authError;

  const { task, output } = await req.json();
  if (typeof task !== "string" || typeof output !== "string")
    return NextResponse.json({ error: "task and output must be strings" }, { status: 400 });
  const result = scanLlmOutput(task.slice(0, 500), output.slice(0, 5000));
  return NextResponse.json(result);
}
