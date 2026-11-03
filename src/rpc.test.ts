// Failover test on fake servers: no network.
import { describe, expect, it } from "vitest";
import { ConnectionError, makeRpc, type Conn } from "./rpc";

interface Fake {
  up: boolean;
  dropped: boolean;
  flaky: boolean;
  opened: number;
  closed: number;
}

const farm = (hosts: string[]) => {
  const state = new Map<string, Fake>(hosts.map((h) => [h, { up: true, dropped: false, flaky: false, opened: 0, closed: 0 }]));
  const log: string[] = [];
  const connect = async (host: string): Promise<Conn> => {
    const s = state.get(host)!;
    log.push(host);
    if (!s.up) throw new Error(`${host} timed out`);
    s.opened++;
    s.dropped = false;
    let live = true;
    return {
      host,
      request: async (method, ...params) => {
        await Promise.resolve();
        if (!live || s.dropped || s.flaky) throw new ConnectionError("Connection lost");
        if (method === "bad") throw new Error("No such mempool or blockchain transaction", { cause: { code: 2 } });
        return `${host}:${method}:${params.join(",")}`;
      },
      close: () => {
        live = false;
        s.closed++;
      },
    };
  };
  return { state, log, connect };
};

describe("rpc failover", () => {
  it("skips a server that does not answer", async () => {
    const f = farm(["a", "b"]);
    f.state.get("a")!.up = false;
    const rpc = makeRpc(f.connect, ["a", "b"]);
    expect(await (await rpc()).request("m", 1)).toBe("b:m:1");
    expect(f.log).toEqual(["a", "b"]);
  });

  it("reconnects after a drop and retries the request once, starting with the other server", async () => {
    const f = farm(["a", "b"]);
    const rpc = makeRpc(f.connect, ["a", "b"]);
    const r = await rpc();
    expect(await r.request("m")).toBe("a:m:");
    f.state.get("a")!.dropped = true;
    f.state.get("a")!.up = false;
    expect(await r.request("m")).toBe("b:m:");
    expect(f.state.get("a")!.closed).toBe(1);
    expect(f.log).toEqual(["a", "b"]);
    // a drop on b goes back to a, now up again
    f.state.get("a")!.up = true;
    f.state.get("b")!.dropped = true;
    expect(await (await rpc()).request("m")).toBe("a:m:");
    expect(f.log).toEqual(["a", "b", "a"]);
  });

  it("passes a server's own answer through without reconnecting", async () => {
    const f = farm(["a", "b"]);
    const r = await makeRpc(f.connect, ["a", "b"])();
    await expect(r.request("bad")).rejects.toThrow("No such mempool");
    expect(await r.request("m")).toBe("a:m:");
    expect(f.log).toEqual(["a"]);
  });

  it("does not keep a failure: a later call tries again", async () => {
    const f = farm(["a", "b"]);
    f.state.forEach((s) => (s.up = false));
    const rpc = makeRpc(f.connect, ["a", "b"]);
    await expect(rpc()).rejects.toThrow("No Fulcrum server answered");
    f.state.get("b")!.up = true;
    expect(await (await rpc()).request("m")).toBe("b:m:");
  });

  it("opens one new connection when parallel requests hit the same drop", async () => {
    const f = farm(["a", "b"]);
    const r = await makeRpc(f.connect, ["a", "b"])();
    await r.request("m");
    f.state.get("a")!.dropped = true;
    const out = await Promise.all([r.request("x"), r.request("y"), r.request("z")]);
    expect(out).toEqual(["b:x:", "b:y:", "b:z:"]);
    expect(f.state.get("b")!.opened).toBe(1);
    expect(f.log).toEqual(["a", "b"]);
  });

  it("gives up after one retry", async () => {
    const f = farm(["a", "b"]);
    f.state.forEach((s) => (s.flaky = true));
    const r = await makeRpc(f.connect, ["a", "b"])();
    await expect(r.request("m")).rejects.toBeInstanceOf(ConnectionError);
    expect(f.log).toEqual(["a", "b"]);
  });
});
