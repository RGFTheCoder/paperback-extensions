import { type TestLogger } from "@paperback/types-0.9";

import { ComixDMC } from "../ComixDMC/main.js";
import sourceInfo from "../ComixDMC/pbconfig.js";
import { registerDefaultTests, TestSuite } from "./suite.js";

export async function runTests(logger: TestLogger) {
  const suite = new TestSuite("ComixDMC tests", logger);
  registerDefaultTests(suite, ComixDMC, sourceInfo);

  await suite.run();
}
