import assert from "node:assert/strict";
import test from "node:test";
import { installWorkspaceRail, visibleWorkspaceState, workspacePlaces } from "./workspace-rail.mjs";

const server = { id: "own-server", name: "My server", origin: "https://self.example.test", kind: "remote" };
const cloud = { id: "old-cloud", name: "Old Cloud", origin: "https://old.example.test", home: true };
const saved = { activeId: server.id, environments: [server, cloud] };

test("keeps self-hosted servers and leaves stored Cloud records intact", () => {
  assert.deepEqual(visibleWorkspaceState(saved).environments, [server]);
  assert.equal(saved.environments.length, 2);
  assert.equal(visibleWorkspaceState({ ...saved, activeId: cloud.id }).activeId, "local");
  const places = workspacePlaces(saved);
  assert.equal(places.length, 2);
  assert.equal(places[1].id, server.id);
  assert.equal(places[1].active, true);
  assert.ok(!JSON.stringify(places).includes(server.origin));
});

test("only the window's rail may read or mutate the server inventory", async () => {
  const handlers = new Map(), opened = [], forgotten = [];
  installWorkspaceRail({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    guard: handler => handler, lists: event => event.rail === true, beside: () => true,
    places: () => workspacePlaces(saved), open: id => opened.push(id), forget: id => forgotten.push(id),
    add: { choices: () => ({ address: true, link: true }), run: () => {} }, targets: () => [],
  });
  const remote = handlers.get("workspaces:places")({ rail: false });
  assert.deepEqual(remote.places, []);
  assert.equal(remote.add.cloud, false);
  assert.throws(() => handlers.get("workspaces:open")({ rail: false }, server.id));
  handlers.get("workspaces:open")({ rail: true }, server.id);
  assert.deepEqual(opened, [server.id]);
  assert.throws(() => handlers.get("workspaces:open")({ rail: true }, cloud.id));
  assert.throws(() => handlers.get("workspaces:add")({ rail: true }, "cloud"));
  assert.equal((await handlers.get("workspaces:remove")({ rail: true }, server.id)).outcome, "removed");
  assert.deepEqual(forgotten, [server.id]);
  assert.ok(![...handlers.keys()].some(channel => channel.startsWith("cloud-")));
});
