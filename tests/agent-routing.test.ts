import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { INSTRUCTIONS } from '../src/instructions.js';

type Manifest = {
  contributes: {
    chatSkills?: { path: string }[];
    languageModelTools: { name: string; modelDescription: string }[];
  };
};

async function readManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(resolve('package.json'), 'utf8')) as Manifest;
}

test('the Squeze skill is contributed to VS Code and its file exists', async () => {
  const skills = (await readManifest()).contributes.chatSkills ?? [];
  assert.deepEqual(skills.map(skill => skill.path), ['./skills/squeze/SKILL.md']);
  await access(resolve(skills[0].path));
});

test('the skill, the context tool and the instructions all tell the agent to try Squeze before grep', async () => {
  const skill = await readFile(resolve('skills/squeze/SKILL.md'), 'utf8');
  assert.match(skill.match(/^description: (.+)$/m)?.[1] ?? '', /before grep/);
  const context = (await readManifest()).contributes.languageModelTools.find(tool => tool.name === 'squeze_context');
  assert.match(context?.modelDescription ?? '', /before grep/);
  assert.match(INSTRUCTIONS, /before grep/);
});
