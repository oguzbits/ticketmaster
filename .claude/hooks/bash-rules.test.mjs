import { describe, expect, it } from 'vitest';

import { checkBashCommand } from './bash-rules.mjs';

const ctx = {
  projectDir: '/work/proj',
  cwd: '/work/proj',
  homeDir: '/home/user',
  tmpRoots: ['/tmp', '/private/tmp'],
};

const blocked = (command, context = ctx) => checkBashCommand(command, context);

describe('allowed commands', () => {
  it.each([
    'pnpm check',
    'pnpm test && pnpm lint',
    'git status',
    'git log --oneline -5',
    'git diff --stat',
    'git add .env.example',
    'cat package.json',
    'rm file.txt',
    'rm -rf dist',
    'rm -rf apps/*/dist',
    'rm -rf node_modules',
    'rm -rf ./apps/web/dist',
    'rm -rf /tmp/scratch',
    'rm -rf /private/tmp/scratch/build',
    'FOO=1 pnpm test',
    'node --env-file=.env.local spikes/parse-gemini.mjs --model m --files 04',
    'echo "a b" | wc -c',
  ])('%s', (command) => {
    expect(blocked(command)).toBeNull();
  });
});

describe('git commit and push', () => {
  it.each([
    'git commit -m x',
    'git commit',
    'git commit -am x',
    'git push',
    'git push origin main',
    'git push -u origin feature/x',
    'git -C . push',
    'git -c user.name=x commit -m y',
    'pnpm check && git commit -m x',
  ])('allows %s', (command) => {
    expect(blocked(command)).toBeNull();
  });

  it.each([
    'git push --force',
    'git push origin main --force',
    'git push --force-with-lease',
    'git push -f',
    'git push -fu origin main',
    'git push origin +main',
    'git push --delete origin feature',
    'git push origin -d feature',
    'git push --mirror',
    'bash -c "git push --force"',
    'sudo git push -f',
    'eval "git push --force"',
  ])('blocks the destructive push %s', (command) => {
    expect(blocked(command)).toMatch(/git push is blocked/);
  });

  it.each([
    'git commit --no-verify -m x',
    'git commit -n -m x',
    'git commit -nm x',
    "sh -c 'git commit --no-verify -m x'",
  ])('blocks skipping the hooks with %s', (command) => {
    expect(blocked(command)).toMatch(/git commit is blocked/);
  });
});

describe('recursive rm', () => {
  it.each([
    'rm -rf /',
    'rm -rf /*',
    'rm -rf ~',
    'rm -rf ~/',
    'rm -rf ~/Documents',
    'rm -rf $HOME',
    'rm -rf "$HOME/x"',
    'rm -rf ..',
    'rm -rf ../other',
    'rm -rf .',
    'rm -rf ./',
    'rm -rf *',
    'rm -rf ./*',
    'rm -rf .git',
    'rm -rf .git/objects',
    'rm -rf /work/proj',
    'rm -rf /work',
    'rm -Rf /etc',
    'rm -fr /usr',
    'rm --recursive --force /var',
    'sudo rm -rf /',
    'ls && rm -rf ~',
    'git ls-files | xargs rm -rf',
    'rm -rf /tmp',
    'rm -rf /tmp/*',
    'rm -rf $(pwd)',
    'bash -c "rm -rf ~"',
  ])('blocks %s', (command) => {
    expect(blocked(command)).toMatch(/rm/i);
  });

  it('respects a subdirectory as cwd', () => {
    const sub = { ...ctx, cwd: '/work/proj/apps/web' };
    expect(blocked('rm -rf dist', sub)).toBeNull();
    expect(blocked('rm -rf ..', sub)).toBeNull();
    expect(blocked('rm -rf ../..', sub)).toMatch(/rm/i);
  });
});

describe('secret files', () => {
  it.each([
    'cat .env',
    'cat .env.local',
    'cat ../../.env.production',
    'grep KEY .env.local',
    'head -n 2 .env',
    'source .env.local',
    'cp .env.local /tmp/x',
    'tail id_rsa',
    'cat cert.pem',
    'node --env-file=.env.local script.js',
    'node --env-file=.env.local spikes/../script.mjs',
    'node --env-file=.env.local spikes/sub/x.mjs',
    'node --env-file=.env.production spikes/x.mjs',
    'node --env-file=.env.local spikes/x.mjs; cat .env.local',
    'node --env-file=.env.local spikes/x.mjs .env.local',
    'node --env-file=.env.local -e "console.log(process.env)"',
    'bash -c "cat .env"',
  ])('blocks %s', (command) => {
    expect(blocked(command)).toMatch(/secrets file/);
  });
});
