// Shared helpers for the comix crypto pipeline.
//
// Everything keys off booting the embedded bundle (experiment/ComixBundle.ts)
// and observing it at the JS built-in boundary (atob / TextDecoder) — the
// rotation-proof technique from experiment/EXTRACTING_COMIX_CRYPTO.md. No VM
// internals are touched, so this survives name/structure rotation.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Buffer } from "node:buffer";

type Traces = { atob: Buffer[]; decoderInputs: Buffer[] };
type Stage = {
  sbox: Uint8Array;
  invSbox: Uint8Array;
  key: Uint8Array;
  iv: number;
};
type InterceptorResult =
  | { params?: { _?: string }; data?: unknown }
  | null
  | undefined;
type Interceptor = (x: Record<string, unknown>) => InterceptorResult;

export type ConstantsStage = { sboxB64: string; keyB64: string; iv: number };
export type Constants = {
  bundleId: string;
  algorithm: string;
  rounds: number;
  cfg: string;
  generatedAt: string;
  note: string;
  stages: ConstantsStage[];
  verified?: { signer: boolean; decrypt: boolean };
};

export const ROOT = resolve(import.meta.dirname ?? ".", "../..");
export const BUNDLE_PATH = resolve(ROOT, "experiment/ComixBundle.ts");

// ---------------------------------------------------------------------------
// Bundle source
// ---------------------------------------------------------------------------

export function readBundle() {
  const src = readFileSync(BUNDLE_PATH, "utf8");
  const cfg = src.match(/cfg:\s*"([^"]+)"/)?.[1];
  const bundleId = src.match(/bundleId:\s*"([^"]+)"/)?.[1] ?? "unknown";
  const codeRaw = src.match(/BUNDLE_CODE\s*=\s*"([\s\S]*?)";\s*\n/)?.[1];
  if (!cfg || !codeRaw) {
    throw new Error("Could not parse cfg / BUNDLE_CODE from ComixBundle.ts");
  }
  const code = JSON.parse('"' + codeRaw + '"');
  return { cfg, bundleId, code };
}

// ---------------------------------------------------------------------------
// Sandbox + boot. Satisfies the anti-tamper traps (querySelector native-code
// string, <meta name=cfg>, navigator.appCodeName) or the bundle silently
// corrupts its keys.
// ---------------------------------------------------------------------------

function buildSandbox(cfg: string, traces: Traces) {
  const metaCfg = {
    get content() {
      return cfg;
    },
    getAttribute(n: string) {
      return n === "content" ? cfg : n === "name" ? "cfg" : null;
    },
    name: "cfg",
  };
  const querySelector = (
    s: unknown,
  ) => (typeof s === "string" && s.includes("cfg") ? metaCfg : null);
  const querySelectorAll = (
    s: unknown,
  ) => (typeof s === "string" && s.toLowerCase() === "meta" ? [metaCfg] : []);
  try {
    Object.defineProperty(querySelector, "toString", {
      value: () => "function querySelector() { [native code] }",
    });
    Object.defineProperty(querySelectorAll, "toString", {
      value: () => "function querySelectorAll() { [native code] }",
    });
  } catch { /* querySelectorAll shim is optional */ }

  const realAtob = (s: string) => Buffer.from(s, "base64").toString("binary");
  class TracingTextDecoder {
    _d: TextDecoder;
    constructor(...a: ConstructorParameters<typeof TextDecoder>) {
      this._d = new TextDecoder(...a);
    }
    decode(buf?: AllowSharedBufferSource, opts?: TextDecodeOptions) {
      if (buf) {
        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(
          (buf as ArrayBufferView).buffer ?? (buf as ArrayBuffer),
        );
        traces.decoderInputs.push(Buffer.from(u8));
      }
      return this._d.decode(buf, opts);
    }
  }

  const b: Record<string, unknown> = {
    document: {
      querySelector,
      querySelectorAll,
      getElementsByTagName: (
        t: string,
      ) => (t && t.toLowerCase() === "meta" ? [metaCfg] : []),
      createElement: () => ({ style: {} }),
      head: { appendChild() {}, removeChild() {} },
      body: { appendChild() {}, removeChild() {} },
      cookie: "",
      readyState: "complete",
      addEventListener() {},
      removeEventListener() {},
    },
    location: {
      href: "https://comix.to/",
      origin: "https://comix.to",
      host: "comix.to",
      hostname: "comix.to",
      pathname: "/",
      protocol: "https:",
      search: "",
      hash: "",
    },
    navigator: {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      appCodeName: "Mozilla",
      appName: "Netscape",
      language: "en-US",
      languages: ["en-US", "en"],
      platform: "Win32",
      cookieEnabled: true,
    },
    screen: { width: 1920, height: 1080 },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
    atob: (s: string) => {
      const r = realAtob(s);
      traces.atob.push(Buffer.from(r, "binary"));
      return r;
    },
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    TextEncoder,
    TextDecoder: TracingTextDecoder,
    URL,
    URLSearchParams,
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    queueMicrotask: (cb: () => void) => Promise.resolve().then(cb),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  Object.setPrototypeOf(b, globalThis);
  b.globalThis = b;
  b.window = b;
  b.self = b;
  b.global = b;
  return b;
}

export function bootBundle() {
  const { cfg, bundleId, code } = readBundle();
  const traces = { atob: [], decoderInputs: [] };
  const sb = buildSandbox(cfg, traces);
  const exp = new Function("__sb", `with(__sb){\n${code}\n}`)(sb);
  if (!exp || typeof exp !== "object") {
    throw new Error("bundle did not return an exports object");
  }

  // The axios installer export rotates its name (was `r`, now `i`, …). Find it
  // by behaviour, not name: it is the export that, given an axios-like instance,
  // registers BOTH a request and a response interceptor. (Never key off the
  // export name — it reshuffles every bundle rotation.)
  const makeAxios = () => {
    let reqI: Interceptor | null = null, resI: Interceptor | null = null;
    const ax = {
      interceptors: {
        request: { use: (h: Interceptor) => (reqI = h) },
        response: { use: (h: Interceptor) => (resI = h) },
      },
      defaults: {
        headers: {
          common: {},
          get: {},
          post: {},
          put: {},
          delete: {},
          patch: {},
          head: {},
        },
        transformRequest: [],
        transformResponse: [],
      },
      get() {},
      post() {},
      put() {},
      delete() {},
      patch() {},
      head() {},
    };
    return { ax, getReqI: () => reqI, getResI: () => resI };
  };

  let reqI: Interceptor | null = null,
    resI: Interceptor | null = null,
    installer: string | null = null;
  const swallow = () => {}; // a non-installer export (e.g. the image fetcher) may float a rejecting fetch
  globalThis.addEventListener("unhandledrejection", swallow);
  try {
    for (const k of Object.keys(exp)) {
      if (typeof exp[k] !== "function") continue;
      const probe = makeAxios();
      try {
        const ret = exp[k](probe.ax);
        if (ret && typeof ret.then === "function") ret.then(swallow, swallow);
      } catch {
        continue;
      }
      if (probe.getReqI() && probe.getResI()) {
        installer = k;
        reqI = probe.getReqI();
        resI = probe.getResI();
        break;
      }
    }
  } finally {
    globalThis.removeEventListener("unhandledrejection", swallow);
  }
  if (!installer || !reqI || !resI) {
    throw new Error(
      "could not locate axios installer export (none registered request+response interceptors)",
    );
  }

  const resetTraces = () => {
    traces.atob.length = 0;
    traces.decoderInputs.length = 0;
  };
  return { cfg, bundleId, reqI, resI, traces, resetTraces };
}

// Drive the live signer: returns the `_` token the request interceptor injects.
export function liveSign(reqI: Interceptor, path: string) {
  const c = {
    url: path,
    method: "get",
    baseURL: "https://comix.to/api/v1",
    headers: {},
    params: {} as Record<string, unknown>,
  };
  const out = reqI(c) || c;
  return out?.params?._ ?? "";
}

// Drive the live decrypt: feed {e} with x-enc:1, return the response data.
export function liveDecrypt(resI: Interceptor, eB64: string) {
  const resp = {
    data: { e: eB64 },
    status: 200,
    statusText: "OK",
    headers: { "x-enc": "1" },
    config: { url: "/x", method: "get", baseURL: "https://comix.to/api/v1" },
    request: {},
  };
  const out = resI(resp) ?? resp;
  return out?.data ?? out;
}

// ---------------------------------------------------------------------------
// Cipher primitives (in-process, for extraction + validation)
// ---------------------------------------------------------------------------

export const bytes = (b64: string) =>
  new Uint8Array(Buffer.from(b64, "base64"));
export const invert = (box: ArrayLike<number>) => {
  const r = new Uint8Array(256);
  for (let i = 0; i < 256; i++) r[box[i]] = i;
  return r;
};

// decrypt round: out[i] = invSbox[in[i]] ^ in[i-1] ^ key[i%len]   (in[-1] = iv)
export function decRound(
  inp: Uint8Array,
  invSbox: Uint8Array,
  key: Uint8Array,
  iv: number,
) {
  const n = inp.length, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] =
      (invSbox[inp[i]] ^ (i === 0 ? iv : inp[i - 1]) ^ key[i % key.length]) &
      0xff;
  }
  return out;
}
// encrypt round: out[i] = sbox[ in[i] ^ out[i-1] ^ key[i%len] ]   (out[-1] = iv)
export function encRound(
  inp: Uint8Array,
  sbox: Uint8Array,
  key: Uint8Array,
  iv: number,
) {
  const n = inp.length, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] =
      sbox[(inp[i] ^ (i === 0 ? iv : out[i - 1]) ^ key[i % key.length]) & 0xff];
  }
  return out;
}

// Full pipelines over canonical stages [{sbox,key,iv} in round order 1..N].
// Decrypt applies inverse stages 1..N; encrypt/sign applies forward stages N..1.
export function decryptBytes(ct: Uint8Array, stages: Stage[]) {
  let d = ct;
  for (const s of stages) d = decRound(d, s.invSbox, s.key, s.iv);
  return d;
}
export function encryptBytes(pt: Uint8Array, stages: Stage[]) {
  let d = pt;
  for (let r = stages.length - 1; r >= 0; r--) {
    const s = stages[r];
    d = encRound(d, s.sbox, s.key, s.iv);
  }
  return d;
}

// base64url, no padding (matches the bundle's token encoding).
export const b64url = (u8: Uint8Array) =>
  Buffer.from(u8).toString("base64").replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");

export function utf8Encode(str: string) {
  return new Uint8Array(Buffer.from(str, "utf8"));
}
export function utf8Decode(u8: Uint8Array) {
  return Buffer.from(u8).toString("utf8");
}

export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${
    Object.keys(obj).sort().map((k) =>
      `${JSON.stringify(k)}:${stableJson(obj[k])}`
    ).join(",")
  }}`;
}
