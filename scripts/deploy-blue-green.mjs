#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const composeFile = resolve(repositoryRoot, 'compose.yaml');
const productionComposeFile = resolve(repositoryRoot, 'deploy/compose.production.yaml');
const productionEnvFile = resolve(repositoryRoot, '.env.production');
const upstreamFile =
  process.env['NGINX_UPSTREAM_FILE'] ?? '/etc/nginx/gatherly-backend-upstream.inc';
const switchHelper =
  process.env['NGINX_SWITCH_HELPER'] ?? '/usr/local/sbin/gatherly-switch-upstream';
const stateFile = process.env['DEPLOYMENT_STATE_FILE'] ?? '/var/lib/gatherly/deployment-state.json';
const backupMarker =
  process.env['BACKUP_SUCCESS_MARKER'] ?? '/var/lib/gatherly/last-backup-success';
const readinessTimeoutSeconds = Number(process.env['DEPLOY_READINESS_TIMEOUT_SECONDS'] ?? 120);
const drainSeconds = Number(process.env['DEPLOY_DRAIN_SECONDS'] ?? 60);
const publicBaseUrl = process.env['DEPLOY_VERIFY_URL'];

const slots = {
  blue: { name: 'blue', port: Number(process.env['BLUE_PORT'] ?? 3101), service: 'app-blue' },
  green: {
    name: 'green',
    port: Number(process.env['GREEN_PORT'] ?? 3102),
    service: 'app-green',
  },
};

const argument = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
};

const runtimeImage = argument('--runtime-image');
const migrationImage = argument('--migration-image');
const revision = argument('--revision');

const requireImmutableImage = (name, value) => {
  if (value === undefined || !/@sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be an immutable @sha256 image reference.`);
  }
  return value;
};

const requireRevision = (value) => {
  if (value === undefined || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('--revision must be a full lowercase Git SHA.');
  }
  return value;
};

const run = (command, args, options = {}) => {
  console.log(`> ${command} ${args.join(' ')}`);
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  });
};

const capture = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();

const digestFrom = (image) => image.slice(image.indexOf('@') + 1);

const releaseEnvironment = (image, releaseRevision) => ({
  ...process.env,
  APP_IMAGE: image,
  MIGRATION_IMAGE: checkedMigrationImage,
  APP_REVISION: releaseRevision,
  APP_IMAGE_DIGEST: digestFrom(image),
});

const composeArguments = (args) => [
  'compose',
  '--env-file',
  productionEnvFile,
  '--file',
  composeFile,
  '--file',
  productionComposeFile,
  ...args,
];

const compose = (environment, args) => run('docker', composeArguments(args), { env: environment });

const composeCapture = (environment, args) =>
  capture('docker', composeArguments(args), { env: environment });

const readActiveSlot = () => {
  const upstream = readFileSync(upstreamFile, 'utf8');
  const match = upstream.match(/^server 127\.0\.0\.1:(\d+);\s*$/);
  if (!match) throw new Error(`Could not parse managed upstream ${upstreamFile}.`);
  const port = Number(match[1]);
  if (port === slots.blue.port) return slots.blue;
  if (port === slots.green.port) return slots.green;
  throw new Error(`Upstream port ${port} is not a managed deployment slot.`);
};

const inactiveSlot = (active) => (active.name === 'blue' ? slots.green : slots.blue);

const inspectService = (environment, service) => {
  const containerId = composeCapture(environment, ['ps', '--quiet', service]);
  if (!containerId) throw new Error(`No container exists for ${service}.`);
  const [inspection] = JSON.parse(capture('docker', ['inspect', containerId]));
  return inspection;
};

const environmentValue = (inspection, name) => {
  const entry = inspection.Config.Env.find((value) => value.startsWith(`${name}=`));
  return entry?.slice(name.length + 1);
};

const assertServiceRunning = (environment, service) => {
  const inspection = inspectService(environment, service);
  if (inspection.State.Running !== true) throw new Error(`${service} is not running.`);
};

const wait = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const fetchOk = async (url, timeoutMs = 5_000) => {
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response;
};

const waitForCandidate = async (slot, expectedRevision) => {
  const deadline = Date.now() + readinessTimeoutSeconds * 1_000;
  const base = `http://127.0.0.1:${slot.port}`;

  while (Date.now() < deadline) {
    try {
      await fetchOk(`${base}/health/ready`, 3_000);
      const version = await (await fetchOk(`${base}/health/version`, 3_000)).json();
      if (version.revision !== expectedRevision || version.slot !== slot.name) {
        throw new Error(`Candidate reported unexpected revision or slot.`);
      }
      await fetchOk(`${base}/api/events?limit=1`, 5_000);
      return;
    } catch {
      await wait(2_000);
    }
  }

  throw new Error(`Candidate ${slot.name} did not become ready before the deadline.`);
};

const verifyPublicPath = async (expectedRevision) => {
  if (publicBaseUrl === undefined) throw new Error('DEPLOY_VERIFY_URL is required.');
  await fetchOk(new URL('/health/ready', publicBaseUrl));
  const version = await (await fetchOk(new URL('/health/version', publicBaseUrl))).json();
  if (version.revision !== expectedRevision) {
    throw new Error(`Public path serves revision ${version.revision ?? 'unknown'}.`);
  }
  await fetchOk(new URL('/api/events?limit=1', publicBaseUrl));
};

const switchTraffic = (port) => {
  run('sudo', [switchHelper, String(port)]);
};

const assertFreshBackup = () => {
  if (!existsSync(backupMarker)) throw new Error(`Backup marker ${backupMarker} is missing.`);
  const ageHours = (Date.now() - statSync(backupMarker).mtimeMs) / 3_600_000;
  if (ageHours > 36) throw new Error(`Last successful backup is ${ageHours.toFixed(1)} hours old.`);
};

const writeDeploymentState = (state) => {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
};

const assertImageRevision = (image, expectedRevision) => {
  const actualRevision = capture('docker', [
    'image',
    'inspect',
    '--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    image,
  ]);
  if (actualRevision !== expectedRevision) {
    throw new Error(`${image} was built from ${actualRevision || 'an unknown revision'}.`);
  }
};

if (process.platform !== 'linux') {
  throw new Error('Blue/green deployment must run on the Linux production host.');
}
if (!existsSync(productionEnvFile)) throw new Error(`${productionEnvFile} does not exist.`);
if (!existsSync(upstreamFile)) throw new Error(`${upstreamFile} does not exist.`);
if (!existsSync(switchHelper)) throw new Error(`${switchHelper} does not exist.`);

const checkedRuntimeImage = requireImmutableImage('--runtime-image', runtimeImage);
const checkedMigrationImage = requireImmutableImage('--migration-image', migrationImage);
const checkedRevision = requireRevision(revision);
const active = readActiveSlot();
const target = inactiveSlot(active);

const bootstrapEnvironment = releaseEnvironment(checkedRuntimeImage, checkedRevision);
const activeInspection = inspectService(bootstrapEnvironment, active.service);
const previousRuntimeImage = activeInspection.Config.Image;
const previousRevision = environmentValue(activeInspection, 'APP_REVISION');
const previousDigest = environmentValue(activeInspection, 'APP_IMAGE_DIGEST');
if (!previousRevision || !previousDigest) {
  throw new Error('Active slot does not expose rollback build metadata.');
}

let trafficChanged = false;
let workersChanged = false;

console.log(`Active slot: ${active.name} (${active.port})`);
console.log(`Candidate slot: ${target.name} (${target.port})`);
console.log(`Runtime image: ${checkedRuntimeImage}`);
console.log(`Migration image: ${checkedMigrationImage}`);

try {
  assertFreshBackup();
  run('docker', ['pull', checkedRuntimeImage]);
  run('docker', ['pull', checkedMigrationImage]);
  assertImageRevision(checkedRuntimeImage, checkedRevision);
  assertImageRevision(checkedMigrationImage, checkedRevision);

  compose(bootstrapEnvironment, [
    '--profile',
    'tools',
    'run',
    '--rm',
    '--no-deps',
    '--no-build',
    'migration',
  ]);

  compose(bootstrapEnvironment, [
    'up',
    '--detach',
    '--force-recreate',
    '--no-deps',
    '--no-build',
    target.service,
  ]);
  await waitForCandidate(target, checkedRevision);

  switchTraffic(target.port);
  trafficChanged = true;
  await verifyPublicPath(checkedRevision);

  workersChanged = true;
  compose(bootstrapEnvironment, [
    'up',
    '--detach',
    '--force-recreate',
    '--no-deps',
    '--no-build',
    'outbox-publisher',
  ]);
  await wait(5_000);
  assertServiceRunning(bootstrapEnvironment, 'outbox-publisher');

  compose(bootstrapEnvironment, [
    'up',
    '--detach',
    '--force-recreate',
    '--no-deps',
    '--no-build',
    'search-consumer',
  ]);
  await wait(5_000);
  assertServiceRunning(bootstrapEnvironment, 'search-consumer');
  await wait(drainSeconds * 1_000);
  compose(bootstrapEnvironment, ['stop', '--timeout', '30', active.service]);

  writeDeploymentState({
    deployedAt: new Date().toISOString(),
    revision: checkedRevision,
    runtimeImage: checkedRuntimeImage,
    migrationImage: checkedMigrationImage,
    slot: target.name,
  });
  console.log(`Deployment complete: ${target.name} serves ${checkedRevision}.`);
} catch (error) {
  console.error(`Deployment failed: ${error instanceof Error ? error.message : String(error)}`);

  if (trafficChanged) {
    try {
      switchTraffic(active.port);
      await verifyPublicPath(previousRevision);
    } catch (rollbackError) {
      console.error(`TRAFFIC ROLLBACK FAILED: ${String(rollbackError)}`);
      console.error(`Keep both slots running and restore ${active.port} manually.`);
      process.exitCode = 1;
      throw rollbackError;
    }
  }

  if (workersChanged && /@sha256:[0-9a-f]{64}$/.test(previousRuntimeImage)) {
    const rollbackEnvironment = {
      ...process.env,
      APP_IMAGE: previousRuntimeImage,
      MIGRATION_IMAGE: checkedMigrationImage,
      APP_REVISION: previousRevision,
      APP_IMAGE_DIGEST: previousDigest,
    };
    try {
      for (const service of ['outbox-publisher', 'search-consumer']) {
        compose(rollbackEnvironment, [
          'up',
          '--detach',
          '--force-recreate',
          '--no-deps',
          '--no-build',
          service,
        ]);
      }
    } catch (workerRollbackError) {
      console.error(`Worker rollback failed: ${String(workerRollbackError)}`);
    }
  }

  try {
    compose(bootstrapEnvironment, ['stop', '--timeout', '30', target.service]);
  } catch (stopError) {
    console.error(`Candidate cleanup failed: ${String(stopError)}`);
  }
  process.exitCode = 1;
}
