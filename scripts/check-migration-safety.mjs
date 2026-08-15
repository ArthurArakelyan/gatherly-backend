#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const base = process.env['MIGRATION_BASE_SHA'];
if (!base || !/^[0-9a-f]{40}$/.test(base)) {
  throw new Error('MIGRATION_BASE_SHA must be a full Git SHA.');
}

const changed = execFileSync(
  'git',
  ['diff', '--name-only', `${base}...HEAD`, '--', 'prisma/migrations/*/migration.sql'],
  { encoding: 'utf8' },
)
  .split(/\r?\n/u)
  .filter(Boolean);

const riskyPatterns = [
  /\bDROP\s+(TABLE|COLUMN|TYPE|INDEX)\b/iu,
  /\bALTER\s+TABLE\b[\s\S]*\bRENAME\b/iu,
  /\bALTER\s+COLUMN\b[\s\S]*\bSET\s+NOT\s+NULL\b/iu,
  /\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/iu,
  /\bTRUNCATE\b/iu,
  /\bDELETE\s+FROM\b/iu,
];

let failed = false;
for (const file of changed) {
  const sql = readFileSync(file, 'utf8');
  const matches = riskyPatterns.filter((pattern) => pattern.test(sql));
  if (matches.length === 0) continue;

  failed = true;
  console.error(`${file} contains contract/destructive SQL.`);
}

if (failed) {
  console.error(
    'Split expansion and contract releases, then document and run the contract manually after compatibility is proven.',
  );
  process.exitCode = 1;
} else {
  console.log(`Checked ${changed.length} changed migration file(s); no contract SQL detected.`);
}
