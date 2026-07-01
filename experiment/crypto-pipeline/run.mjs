// Orchestrator — extract → generate → validate, in one shot.
//
//   node experiment/crypto-pipeline/run.mjs            # use the embedded bundle
//   node experiment/crypto-pipeline/run.mjs --refresh  # refresh secure.js first
//
// --refresh fetches the live comix.to secure-*.js and regenerates
// experiment/ComixBundle.ts before extracting (needs CF_CLEARANCE / SESSION /
// USER_AGENT env, same as npm run refresh:comix).

import { resolve } from "node:path";
import { ROOT } from "./lib.mjs";
import { extract } from "./extract.mjs";
import { generate } from "./generate.mjs";
import { validate } from "./validate.mjs";

async function run({ refresh }) {
  if (refresh) {
    console.log("== refresh secure.js ==");
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", resolve(ROOT, "experiment/RefreshComixBundle.ts")],
      stdin: "inherit", stdout: "inherit", stderr: "inherit", cwd: ROOT,
    });
    const r = cmd.outputSync();
    if (r.code !== 0) throw new Error("refresh failed — check CF_CLEARANCE / SESSION / USER_AGENT");
  }

  console.log("== extract ==");
  const c = extract();
  console.log(`   bundle ${c.bundleId} — ${c.algorithm}, ${c.rounds} rounds; signer=${c.verified.signer} decrypt=${c.verified.decrypt}`);

  console.log("== generate ==");
  const g = generate();
  console.log(`   wrote ${g.decryptPath}`);
  console.log(`   wrote ${g.signerPath}`);

  console.log("== validate ==");
  const v = await validate();
  if (!v.ok) throw new Error(`validation failed (signer ${v.signFail} fail, decrypt ${v.decFail} fail)`);
  console.log(`\nDONE — signer ${v.signPass} pass, decrypt ${v.decPass} pass. Native files match the live bundle.`);
  return v;
}

run({ refresh: Deno.args.includes("--refresh") })
  .then((v) => Deno.exit(v.ok ? 0 : 1))
  .catch((e) => { console.error(`\nFAILED: ${e?.message ?? e}`); Deno.exit(1); });
