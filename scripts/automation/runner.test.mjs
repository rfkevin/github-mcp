import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import ts from 'typescript';
import YAML from 'yaml';

function load(source, require = undefined) {
  const context = { exports: {}, require };
  const javascript = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(javascript, context);
  return context.exports;
}
const { CHECK_RUNNER } = load('src/automation/runner.ts');
const { MANAGED_WORKFLOW } = load('src/automation/workflow.ts', () => ({ CHECK_RUNNER }));
const SHA = 'a'.repeat(40);
const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';

function fixture(t, plan = { version: 1, checks: { quick: ['exit 0'] } }) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'github-mcp-check-runner-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    fs.rmSync(root, { recursive: true });
  });
  fs.mkdirSync(path.join(root, '.mcp'));
  fs.writeFileSync(path.join(root, '.mcp/checks.json'), JSON.stringify(plan));
  const commands = [];
  const execute = (env = {}, head = SHA, filesystem = fs, real = false) => vm.runInNewContext(CHECK_RUNNER, {
    console: { log() {} },
    process: { cwd: () => root, env: {
      ...process.env,
      // Keep fixtures independent from parent workflows such as agent-checks,
      // which export CHECK_SCOPE/CHECK_TARGET/CHECK_REQUEST_ID at job level.
      CHECK_SCOPE: '', CHECK_TARGET: '', CHECK_REQUEST_ID: '',
      CHECK_SHA: SHA, GITHUB_EVENT_NAME: 'push', ...env,
    } },
    require: name => {
      if (name === 'node:fs') return filesystem;
      if (name === 'node:path') return path;
      if (name === 'node:crypto') return crypto;
      if (name === 'node:child_process') return {
        execFileSync: (file, args, options) => {
          if (file === '/usr/bin/git') return head + '\n';
          assert.equal(file, '/bin/bash');
          commands.push({ args, options });
          if (real) return cp.execFileSync(bash, args, options);
          return '';
        },
      };
      throw Error('Unexpected module');
    },
  });
  return { root, commands, execute };
}

test('le YAML généré embarque exactement l’exécuteur et les permissions prévues', () => {
  const workflow = YAML.parse(MANAGED_WORKFLOW);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.checks['runs-on'], 'ubuntu-24.04');
  const step = workflow.jobs.checks.steps.at(-1);
  assert.equal(step.name, 'Run project checks');
  assert.equal(step.run, "node <<'MCP_CHECK_RUNNER'\n" + CHECK_RUNNER + '\nMCP_CHECK_RUNNER\n');
  new vm.Script(CHECK_RUNNER);
  assert.equal(workflow.jobs.checks.steps[1].with['persist-credentials'], false);
});

test('installe une seule fois puis exécute uniquement le profil choisi avec la cible en variable', t => {
  const { execute, commands } = fixture(t, {
    version: 1, workingDirectory: '.', install: ['install'], checks: { quick: ['quick'], unit: ['unit-1', 'unit-2'] },
  });
  execute({ CHECK_SCOPE: 'unit', CHECK_TARGET: 'tests/login.py', GITHUB_TOKEN: 'CANARY',
    ACTIONS_RUNTIME_TOKEN: 'CANARY', GITHUB_ENV: 'CANARY', GITHUB_OUTPUT: 'CANARY' });
  assert.deepEqual(commands.map(command => command.args.at(-1)), ['install', 'unit-1', 'unit-2']);
  for (const command of commands) {
    assert.equal(command.options.env.CHECK_TARGET, 'tests/login.py');
    for (const key of ['GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'GITHUB_ENV', 'GITHUB_OUTPUT']) assert.equal(command.options.env[key], undefined);
  }
});

test('refuse un commit différent, un profil absent et une cible passée comme option avant installation', t => {
  const { execute, commands } = fixture(t);
  assert.throws(() => execute({}, 'b'.repeat(40)), /Commit inattendu/);
  assert.throws(() => execute({ CHECK_SCOPE: 'absent' }), /Profil absent/);
  assert.throws(() => execute({ CHECK_TARGET: '--config=evil' }), /Cible invalide/);
  assert.equal(commands.length, 0);
});

test('refuse un plan lié, un dossier extérieur et les commandes vides', t => {
  const { execute, root, commands } = fixture(t);
  assert.throws(() => execute({}, SHA, { ...fs, lstatSync: () => ({ isSymbolicLink: () => true }) }), /symbolique/);
  let resolves = 0;
  assert.throws(() => execute({}, SHA, { ...fs, realpathSync: () => ++resolves === 1 ? root : path.dirname(root) }), /hors checkout/);
  fs.writeFileSync(path.join(root, '.mcp/checks.json'), JSON.stringify({ version: 1, checks: { quick: [''] } }));
  assert.throws(() => execute(), /Profils invalides/);
  assert.equal(commands.length, 0);
});

test('un monorepo exécute ses commandes dans le sous-dossier déclaré', t => {
  const { execute, root, commands } = fixture(t, { version: 1, workingDirectory: 'apps/web', checks: { quick: ['check'] } });
  fs.mkdirSync(path.join(root, 'apps/web'), { recursive: true });
  execute();
  assert.equal(commands[0].options.cwd, path.join(root, 'apps/web'));
});

test('un dispatch falsifiant la cible sous un titre connu échoue avant toute commande', t => {
  const { execute, commands } = fixture(t);
  const repository = 'owner/project', target = 'tests/login.py';
  const key = crypto.createHash('sha256').update(JSON.stringify(['mcp-checks-v1', repository, SHA, 'quick', target])).digest('hex');
  assert.throws(() => execute({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: repository,
    CHECK_TARGET: 'tests/other.py', CHECK_REQUEST_ID: key }), /non corrélés/);
  assert.equal(commands.length, 0);
  execute({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: repository, CHECK_TARGET: target, CHECK_REQUEST_ID: key });
  assert.equal(commands.length, 1);
});

test('un vrai échec shell arrête le profil et remonte une erreur', { skip: !fs.existsSync(bash) }, t => {
  const { execute, commands } = fixture(t, { version: 1, install: ['exit 17'], checks: { quick: ['exit 0'] } });
  assert.throws(() => execute({}, SHA, fs, true));
  assert.equal(commands.length, 1);
});

test('un vrai shell reçoit la cible sans credential hérité', { skip: !fs.existsSync(bash) }, t => {
  const { execute } = fixture(t, { version: 1, checks: { quick: ['test -z "$GITHUB_TOKEN" && test "$CHECK_TARGET" = "tests/login.py"'] } });
  execute({ CHECK_TARGET: 'tests/login.py', GITHUB_TOKEN: 'CANARY' }, SHA, fs, true);
});
