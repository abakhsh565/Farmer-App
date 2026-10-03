#!/usr/bin/env node
/**
 * Design-system drift check.
 *
 * The rule this enforces: one change at the source of truth should propagate
 * everywhere. That only holds while nothing bypasses the tokens, so this fails
 * the build on the four kinds of bypass that actually crept in before:
 *
 *   1. arbitrary font sizes      `text-[13px]`      → use a token (text-body-sm)
 *   2. arbitrary colour values   `bg-[#cc785c]`     → use a token
 *   3. physical direction        `pl-4`, `text-left` → ps-4, text-start
 *   4. inline hex in styles                         → use a token
 *
 * Vendored registry code (src/components/ui, src/components/kibo-ui) is skipped:
 * it is third-party source we do not own, and rewriting it would break the next
 * `npx shadcn add`. Everything we author is checked.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = ['node_modules', 'dist', 'archive', '.freebuff'];
const VENDORED = [join('src', 'components', 'ui'), join('src', 'components', 'kibo-ui')];

const RULES = [
  {
    id: 'arbitrary-font-size',
    message: 'arbitrary font size — use a type token (text-body, text-label, text-caption …)',
    pattern: /\btext-\[\d+(?:\.\d+)?(?:px|rem|em)\]/g,
  },
  {
    id: 'arbitrary-colour',
    message: 'arbitrary colour value — use a palette or semantic token',
    pattern: /\b(?:bg|text|border|fill|stroke|ring|shadow)-\[#[0-9a-fA-F]{3,8}\]/g,
  },
  {
    id: 'inline-hex',
    message: 'hardcoded hex colour — use a token',
    pattern: /style=\{\{[^}]*(#[0-9a-fA-F]{3,8})/g,
  },
  {
    id: 'physical-direction',
    message: 'physical direction utility — use the logical equivalent (ps/pe, ms/me, start/end, text-start/end)',
    pattern: /(?:^|[\s"'`{[])((?:ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|text-left|text-right|left|right)-[0-9a-z[])/g,
  },
];

/**
 * Blank out comments, so prose is never mistaken for code.
 *
 * A comment reading "its arrow keys still ran left-to-right" was being reported as
 * a `left-t` physical-direction utility. Failing the build on a word in a sentence
 * is worse than not checking at all: it teaches people to write worse comments.
 *
 * String literals are respected, so a `//` inside a URL is not read as the start of
 * a comment. Comments are replaced with spaces rather than removed, which keeps
 * every character position — and therefore every reported line number — correct.
 */
function blankComments(source) {
  let out = '';
  let index = 0;
  let quote = null;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      // Keep escapes (including an escaped backslash) inside the string intact.
      if (char === '\\') {
        out += char + (next ?? '');
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      out += char;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      let end = index + 2;
      while (end < source.length && !(source[end] === '*' && source[end + 1] === '/')) end += 1;
      end = Math.min(end + 2, source.length);
      out += source.slice(index, end).replace(/[^\n]/g, ' ');
      index = end;
      continue;
    }

    if (char === '/' && next === '/') {
      let end = index;
      while (end < source.length && source[end] !== '\n') end += 1;
      out += source.slice(index, end).replace(/[^\n]/g, ' ');
      index = end;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (SKIP_DIRS.includes(entry)) continue;
    const rel = relative(ROOT, full);
    if (VENDORED.some((v) => rel === v || rel.startsWith(`${v}\\`) || rel.startsWith(`${v}/`))) continue;

    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(tsx|ts)$/.test(entry)) yield full;
  }
}

const findings = [];

for (const file of walk(join(ROOT, 'src'))) {
  const source = readFileSync(file, 'utf8');
  const lines = blankComments(source).split('\n');

  lines.forEach((line, index) => {
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      for (const match of line.matchAll(rule.pattern)) {
        findings.push({
          file: relative(ROOT, file),
          line: index + 1,
          rule: rule.id,
          message: rule.message,
          snippet: match[1] ?? match[0],
        });
      }
    }
  });
}

if (findings.length === 0) {
  console.log('Design check passed — no token bypasses, no physical direction utilities.');
  process.exit(0);
}

console.error(`Design check failed: ${findings.length} bypass(es) of the design tokens.\n`);

for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.snippet}`);
  console.error(`    ${f.message}\n`);
}

console.error('Fix the shared source, not the screen. See docs/DESIGN-SYSTEM.md.');
process.exit(1);
