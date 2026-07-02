import type { TestLogger } from "@paperback/types-0.9";

import { ComixDMC } from "../ComixDMC/main.ts";
import sourceInfo from "../ComixDMC/pbconfig.ts";
import { registerDefaultTests, TestSuite } from "./suite.ts";

export async function runTests(logger: TestLogger) {
  const suite = new TestSuite("ComixDMC tests", logger);
  registerDefaultTests(suite, ComixDMC, sourceInfo);

  await suite.run();
}
