/**
 * Lets us import the plugin's test-tooling helpers
 * (BesuTestEnvironment / EthereumTestEnvironment) from outside Jest.
 * Those files do `import { expect } from "@jest/globals"` at module load
 * and the real `@jest/globals` throws if loaded outside a Jest worker.
 *
 * Install this BEFORE importing anything that pulls in @jest/globals.
 */

import Module from "node:module";

const noopExpect = () => ({
  toBe: () => {},
  toBeTruthy: () => {},
  toBeFalsy: () => {},
  toBeGreaterThan: () => {},
  toBeDefined: () => {},
  toEqual: () => {},
  toBeInstanceOf: () => {},
  toMatch: () => {},
  not: { toBe: () => {}, toBeTruthy: () => {} },
});

const stub = {
  expect: noopExpect,
  describe: (_name: string, fn: () => void) => fn(),
  it: (_name: string, fn: () => void) => fn(),
  beforeAll: () => {},
  afterAll: () => {},
  beforeEach: () => {},
  afterEach: () => {},
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = Module.prototype as any;
const origRequire = proto.require;
proto.require = function (id: string) {
  if (id === "@jest/globals") return stub;
  return origRequire.apply(this, [id]);
};
