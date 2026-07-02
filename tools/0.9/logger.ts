// A small recursive logger that builds a plain JSON tree.
//
// Ported from `@paperback/toolchain` (MIT, © Faizan Durrani and contributors);
// see tools/THIRD_PARTY_NOTICES.md for the full MIT license text. Each instance
// wraps one node in the output tree — either an object node (supports `.log`,
// `.scope`, `.list`, `.console`) or an array node (`.scope(name)` appends a new
// `{ name }` entry). Nodes are shared by reference so child writes propagate up.

type ObjectNode = Record<string, unknown>;
type ArrayNode = unknown[];
type Node = ObjectNode | ArrayNode;

interface ConsoleEntry {
  time: number;
  args: unknown[];
  method: string;
}

export class Logger {
  private _node: Node;

  constructor(node: Node = {}) {
    this._node = node;
  }

  private get _isArray(): boolean {
    return Array.isArray(this._node);
  }

  private get _obj(): ObjectNode {
    if (this._isArray) {
      throw new Error(
        "This logger wraps a list — call .scope(name) to create an entry first.",
      );
    }
    return this._node as ObjectNode;
  }

  private get _arr(): ArrayNode {
    if (!this._isArray) {
      throw new Error(
        "This logger wraps an object — use .list(name) to get a list logger.",
      );
    }
    return this._node as ArrayNode;
  }

  log(key: string, value: unknown): this {
    this._obj[key] = value;
    return this;
  }

  scope(name: string): Logger {
    if (this._isArray) {
      const entry: ObjectNode = { name };
      this._arr.push(entry);
      return new Logger(entry);
    }
    if (!(name in this._obj)) this._obj[name] = {};
    return new Logger(this._obj[name] as Node);
  }

  list(name: string): Logger {
    if (!(name in this._obj)) this._obj[name] = [];
    return new Logger(this._obj[name] as Node);
  }

  // Console-compatible shim that captures calls into a `console` array on this
  // node. Assign to a VM context's `console` before running a suite.
  console(): Console {
    if (!Array.isArray(this._obj["console"])) this._obj["console"] = [];
    const entries = this._obj["console"] as ConsoleEntry[];
    const capture = (method: string) => (...args: unknown[]) => {
      entries.push({ time: Date.now(), args, method });
    };
    const noop = () => {};
    return {
      log: capture("log"),
      warn: capture("warn"),
      error: capture("error"),
      info: capture("info"),
      debug: capture("debug"),
      assert: noop,
      clear: noop,
      count: noop,
      countReset: noop,
      dir: noop,
      dirxml: noop,
      group: noop,
      groupCollapsed: noop,
      groupEnd: noop,
      table: noop,
      time: noop,
      timeEnd: noop,
      timeLog: noop,
      timeStamp: noop,
      trace: noop,
      profile: noop,
      profileEnd: noop,
    } as unknown as Console;
  }

  // Deep clone of the current node (and descendants) as a plain JS value.
  raw(): unknown {
    return JSON.parse(JSON.stringify(this._node));
  }
}
