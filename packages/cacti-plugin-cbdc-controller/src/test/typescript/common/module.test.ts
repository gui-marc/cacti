import * as publicApi from "../../../main/typescript/public-api";

test("Module can be loaded", () => {
  expect(publicApi).toBeDefined();
});
