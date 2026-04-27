#!/usr/bin/env node
/**
 * Audit script to detect simulations, fake data, and suspicious patterns
 * in the PPG biometric pipeline.
 * 
 * FAILS if:
 * - Math.random in pipeline biométrico
 * - fake/mock/dummy/simulated in código activo
 * - valores hardcodeados tipo bpm=75, spo2=98, bp=120/80
 * - módulos de glucosa/lípidos/presión sin CalibrationProfile
 * - archivos .cmd/.exe/.zip en el repo
 * 
 * IGNORA:
 * - documentación con palabras como ejemplo prohibido
 * - tests que validen rechazo de simulación
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, extname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SRC_DIR = join(__dirname, '..', 'src');
const ROOT_DIR = join(__dirname, '..');

// Patterns that indicate simulation/fake data (only in production code)
const SUSPICIOUS_PATTERNS = [
  // Random number generation in biometric pipeline
  { pattern: /Math\.random\(\)/, severity: 'CRITICAL', message: 'Math.random() detected - potential simulation' },
  { pattern: /Math\.random\s*\(/, severity: 'CRITICAL', message: 'Math.random usage detected' },
  
  // Fake/Mock/Simulated data indicators
  { pattern: /\bfake\b/i, severity: 'ERROR', message: '"fake" keyword detected' },
  { pattern: /\bmock\b/i, severity: 'ERROR', message: '"mock" keyword detected' },
  { pattern: /\bdummy\b/i, severity: 'ERROR', message: '"dummy" keyword detected' },
  { pattern: /\bsimulated\b/i, severity: 'ERROR', message: '"simulated" keyword detected' },
  { pattern: /\bsimulation\b/i, severity: 'ERROR', message: '"simulation" keyword detected' },
  
  // Hardcoded vital signs
  { pattern: /bpm\s*[=:]\s*7[0-9]|bpm\s*[=:]\s*8[0-9]/i, severity: 'CRITICAL', message: 'Hardcoded BPM value detected' },
  { pattern: /spo2\s*[=:]\s*9[0-9]|spo2\s*[=:]\s*100/i, severity: 'CRITICAL', message: 'Hardcoded SpO2 value detected' },
  { pattern: /120\/80|systolic\s*[=:]\s*120|diastolic\s*[=:]\s*80/i, severity: 'CRITICAL', message: 'Hardcoded blood pressure detected' },
  
  // Suspicious vital sign generation
  { pattern: /glucose.*[=:]\s*\d{2,3}/i, severity: 'WARNING', message: 'Hardcoded glucose value - needs CalibrationProfile' },
  { pattern: /cholesterol.*[=:]\s*\d{2,3}/i, severity: 'WARNING', message: 'Hardcoded cholesterol value - needs CalibrationProfile' },
  { pattern: /hdl.*[=:]\s*\d{2,3}/i, severity: 'WARNING', message: 'Hardcoded HDL value - needs CalibrationProfile' },
  { pattern: /ldl.*[=:]\s*\d{2,3}/i, severity: 'WARNING', message: 'Hardcoded LDL value - needs CalibrationProfile' },
];

// Patterns that are allowed (tests, docs with examples)
const ALLOWLIST_PATTERNS = [
  /\.(test|spec)\.(ts|tsx|js|jsx)$/i,  // Test files
  /__tests__/,                          // Test directories
  /\.md$/i,                            // Markdown documentation
  /\/(docs|scripts|\.githooks)\//,     // Docs and scripts
];

// Forbidden binary extensions
const FORBIDDEN_EXTENSIONS = new Set(['.cmd', '.exe', '.zip', '.rar', '.7z', '.tar', '.gz', '.bin']);

let errors = [];
let warnings = [];
let critical = [];

function isAllowlisted(filePath) {
  return ALLOWLIST_PATTERNS.some(pattern => pattern.test(filePath));
}

function scanFile(filePath, content) {
  const lines = content.split('\n');
  const isTestFile = filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__');
  const isDoc = filePath.endsWith('.md') || filePath.includes('/docs/');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    
    // Skip comments that explain what NOT to do (documentation)
    if (isDoc && (line.includes('DO NOT') || line.includes('prohibido') || line.includes('forbidden'))) {
      continue;
    }
    
    for (const { pattern, severity, message } of SUSPICIOUS_PATTERNS) {
      if (pattern.test(line)) {
        // Skip if in allowlisted file
        if (isAllowlisted(filePath)) {
          // But still warn if it's a production pattern in a test (should be in test-specific way)
          if (severity === 'CRITICAL' && !line.includes('// test:')) {
            warnings.push({
              file: filePath,
              line: lineNum,
              severity: 'WARNING',
              message: `${message} (in allowlisted file, verify it's testing rejection)`,
              code: line.trim()
            });
          }
          continue;
        }
        
        const issue = {
          file: filePath,
          line: lineNum,
          severity,
          message,
          code: line.trim()
        };
        
        if (severity === 'CRITICAL') critical.push(issue);
        else if (severity === 'ERROR') errors.push(issue);
        else warnings.push(issue);
      }
    }
  }
}

function scanDirectory(dir, basePath = '') {
  const entries = readdirSync(dir);
  
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const relativePath = join(basePath, entry);
    const stat = statSync(fullPath);
    
    if (stat.isDirectory()) {
      // Skip node_modules and dist
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') {
        continue;
      }
      scanDirectory(fullPath, relativePath);
    } else {
      // Check forbidden extensions
      const ext = extname(entry).toLowerCase();
      if (FORBIDDEN_EXTENSIONS.has(ext)) {
        critical.push({
          file: relativePath,
          line: 0,
          severity: 'CRITICAL',
          message: `Forbidden binary file type: ${ext}`,
          code: entry
        });
        continue;
      }
      
      // Scan source files
      if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
        try {
          const content = readFileSync(fullPath, 'utf-8');
          scanFile(relativePath, content);
        } catch (e) {
          errors.push({
            file: relativePath,
            line: 0,
            severity: 'ERROR',
            message: `Failed to read file: ${e.message}`,
            code: ''
          });
        }
      }
    }
  }
}

function checkCalibrationProfiles() {
  // Check for glucose/lipid modules without CalibrationProfile
  const suspiciousModules = ['glucose', 'lipid', 'cholesterol', 'hdl', 'ldl', 'bloodpressure'];
  
  for (const module of suspiciousModules) {
    const modulePath = join(SRC_DIR, module);
    if (existsSync(modulePath)) {
      // Check if CalibrationProfile exists in the module
      const profilePath = join(modulePath, 'CalibrationProfile.ts');
      if (!existsSync(profilePath)) {
        critical.push({
          file: `src/${module}/`,
          line: 0,
          severity: 'CRITICAL',
          message: `Biometric module without CalibrationProfile: ${module}`,
          code: 'Missing CalibrationProfile.ts'
        });
      }
    }
  }
}

// Main execution
console.log('🔍 PPG No-Simulation Audit\n');

scanDirectory(SRC_DIR, 'src/');
checkCalibrationProfiles();

// Summary
console.log(`\n📊 Audit Results:`);
console.log(`   Critical: ${critical.length}`);
console.log(`   Errors: ${errors.length}`);
console.log(`   Warnings: ${warnings.length}`);

if (critical.length > 0) {
  console.log(`\n🚨 CRITICAL ISSUES (will fail build):`);
  critical.forEach(issue => {
    console.log(`   ❌ ${issue.file}:${issue.line}`);
    console.log(`      ${issue.message}`);
    if (issue.code) console.log(`      Code: ${issue.code.substring(0, 80)}`);
  });
}

if (errors.length > 0) {
  console.log(`\n❌ ERRORS:`);
  errors.forEach(issue => {
    console.log(`   ${issue.file}:${issue.line}`);
    console.log(`      ${issue.message}`);
  });
}

if (warnings.length > 0) {
  console.log(`\n⚠️  WARNINGS:`);
  warnings.forEach(issue => {
    console.log(`   ${issue.file}:${issue.line} - ${issue.message}`);
  });
}

// Exit code
const totalFailures = critical.length + errors.length;
if (totalFailures > 0) {
  console.log(`\n❌ AUDIT FAILED: ${totalFailures} blocking issues found`);
  process.exit(1);
} else {
  console.log(`\n✅ AUDIT PASSED: No simulation patterns detected`);
  if (warnings.length > 0) {
    console.log(`   (${warnings.length} warnings - review recommended)`);
  }
  process.exit(0);
}
