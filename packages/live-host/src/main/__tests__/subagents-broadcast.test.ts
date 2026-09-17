import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

it('publishes task-only updates to the card and task window without touching call startup', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile(
    'index.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let callback = '';
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(tree) === 'onSubagents'
    )
      callback = node.initializer.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert(callback);
  const publish = tree.statements
    .filter(
      (node) =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === 'publishOverlayState',
    )
    .map((node) => node.getText(tree))
    .join('\n');
  const states: unknown[] = [];
  const tasks: unknown[] = [];
  const context = {
    language: 'en',
    connection: {
      phase: 'ready',
      instanceId: 'one',
      subagentsControlV1: true,
      subagentsV1: { revision: 1 },
    },
    overlayReady: true,
    overlay: {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, state: unknown) => {
          assert.equal(channel, 'live:state');
          states.push(state);
        },
      },
    },
    subagents: {
      update: (_language: string, _ready: boolean, snapshot: unknown) =>
        tasks.push(snapshot),
    },
    publicState: () => ({ subagentsV1: context.connection.subagentsV1 }),
    publishState: () =>
      assert.fail('Task updates must not run call-startup hooks'),
  };
  const update = runInNewContext(
    ts.transpileModule(`${publish}\n(${callback})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  ) as (snapshot: unknown) => void;
  for (const revision of [2, 3]) {
    const snapshot = {
      revision,
      counts: { running: revision, needsAttention: 1 },
    };
    update(snapshot);
    assert.equal(tasks.at(-1), snapshot);
    assert.deepEqual(states.at(-1), { subagentsV1: snapshot });
  }
  context.overlayReady = false;
  update({ revision: 4 });
  assert.equal(tasks.length, 3);
  assert.equal(states.length, 2);
});
