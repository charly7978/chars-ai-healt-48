#!/usr/bin/env node
/**
 * No-simulation audit for the Forensic PPG monitor.
 *
 * FAILS the build if production code under src/ contains:
 *   - Math.random()
 *   - identifiers: mock, fake, dummy, simulated, simulation, synthetic,
 *                  placeholder, demo value
 *   - hardcoded vital values (bpm=72, spo2=98, 120/80, etc.)
 *   - hardcoded glucose / cholesterol / hdl / ldl numeric constants
 *   - forbidden binary file types
 *
 * IGNORES:
 *   - test files  (*.test.*, *.spec.*, **__tests__**)
 *   - markdown docs
 *   - the audit scripts themselves
 *   - JSON metadata (e.g. tailwind.config.lov.json)
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR  = join(__dirname, '..');
const SRC_DIR   = join(ROOT_DIR, 'src');

const SUSPICIOUS = [
  { re: /Math\.random\s*\(/,                 sev: 'CRITICAL', msg: 'Math.random() in production' },
  { re: /\bmock\b/i,                         sev: 'ERROR',    msg: '"mock" identifier' },
  { re: /\bfake\b/i,                         sev: 'ERROR',    msg: '"fake" identifier' },
  { re: /\bdummy\b/i,                        sev: 'ERROR',    msg: '"dummy" identifier' },
  { re: /\bsimulated\b/i,                    sev: 'ERROR',    msg: '"simulated" identifier' },
  { re: /\bsimulation\b/i,                   sev: 'ERROR',    msg: '"simulation" identifier' },
  { re: /\bsynthetic\b/i,                    sev: 'ERROR',    msg: '"synthetic" identifier' },
  { re: /\bplaceholder\b/i,                  sev: 'ERROR',    msg: '"placeholder" identifier' },
  { re: /\bdemo[-_ ]?value\b/i,              sev: 'ERROR',    msg: '"demo value" literal' },
  { re: /\bplaceholder[-_ ]?(value|vital|bpm|spo2)\b/i, sev: 'ERROR', msg: '"placeholder vital" literal' },

  // Hardcoded vital constants in production code
  { re: /\bbpm\s*[:=]\s*(?:[6-9]\d|1[0-4]\d)\b/i,       sev: 'CRITICAL', msg: 'Hardcoded BPM literal' },
  { re: /\bspo2\s*[:=]\s*(?:8\d|9\d|100)\b/i,           sev: 'CRITICAL', msg: 'Hardcoded SpO2 literal' },
  { re: /\b120\s*\/\s*80\b/,                            sev: 'CRITICAL', msg: 'Hardcoded BP 120/80' },
  { re: /\bsystolic\s*[:=]\s*1\d{2}\b/i,                sev: 'CRITICAL', msg: 'Hardcoded systolic literal' },
  { re: /\bdiastolic\s*[:=]\s*\d{2}\b/i,                sev: 'CRITICAL', msg: 'Hardcoded diastolic literal' },
  { re: /\bglucose\s*[:=]\s*\d{2,3}\b/i,                sev: 'ERROR',    msg: 'Hardcoded glucose literal' },
  { re: /\bcholesterol\s*[:=]\s*\d{2,3}\b/i,            sev: 'ERROR',    msg: 'Hardcoded cholesterol literal' },
  { re: /\bhdl\s*[:=]\s*\d{2,3}\b/i,                    sev: 'ERROR',    msg: 'Hardcoded HDL literal' },
  { re: /\bldl\s*[:=]\s*\d{2,3}\b/i,                    sev: 'ERROR',    msg: 'Hardcoded LDL literal' },
];

const FORBIDDEN_EXT = new Set(['.cmd', '.exe', '.zip', '.rar', '.7z', '.tar', '.gz', '.bin']);

const ALLOW_FILE = (p) =>
  /\.(test|spec)\.[jt]sx?$/.test(p) ||
  p.includes('__tests__/') ||
  p.endsWith('.md') ||
  p.endsWith('.json') ||
  p.includes('/scripts/') ||
  p.includes('/docs/');

const issues = { critical: [], error: [], warning: [] };

function scanFile(rel, full) {
  const content = readFileSync(full, 'utf-8');
  const lines   = content.split('\n');
  const allow   = ALLOW_FILE(rel);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip pure-comment lines that explicitly forbid the pattern (documentation).
    const stripped = line.trim();
    if (/^\/\/|^\*|^#/.test(stripped) &&
        /(NOT allowed|forbidden|prohibido|do not|never)/i.test(stripped)) continue;

    for (const { re, sev, msg } of SUSPICIOUS) {
      if (!re.test(line)) continue;
      if (allow) continue; // allowlisted file → ignore production rules
      const issue = { file: rel, line: i + 1, sev, msg, code: line.trim().slice(0, 120) };
      if (sev === 'CRITICAL') issues.critical.push(issue);
      else if (sev === 'ERROR') issues.error.push(issue);
      else issues.warning.push(issue);
    }
  }
}

function walk(dir, base) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    const rel  = join(base, entry).replace(/\\/g, '/');
    const st   = statSync(full);
    if (st.isDirectory()) { walk(full, rel); continue; }

    const ext = extname(entry).toLowerCase();
    if (FORBIDDEN_EXT.has(ext)) {
      issues.critical.push({ file: rel, line: 0, sev: 'CRITICAL', msg: `Forbidden binary: ${ext}`, code: entry });
      continue;
    }
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) scanFile(rel, full);
  }
}

console.log('🔍 PPG No-Simulation Audit\n');
walk(SRC_DIR, 'src');

console.log(`\n📊 Results:`);
console.log(`   Critical: ${issues.critical.length}`);
console.log(`   Errors:   ${issues.error.length}`);
console.log(`   Warnings: ${issues.warning.length}`);

const print = (label, list) => {
  if (!list.length) return;
  console.log(`\n${label}:`);
  list.forEach((i) => console.log(`   ${i.file}:${i.line}  ${i.msg}\n      ${i.code}`));
};
print('🚨 CRITICAL', issues.critical);
print('❌ ERROR',    issues.error);
print('⚠️  WARNING', issues.warning);

const failures = issues.critical.length + issues.error.length;
if (failures) {
  console.log(`\n❌ AUDIT FAILED: ${failures} blocking issues`);
  process.exit(1);
}
console.log('\n✅ AUDIT PASSED: production code is simulation-free');
process.exit(0);
