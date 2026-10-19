import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusEvent, EventBus } from "./event-bus.js";

export interface EventBusSuiteContext<Tx> {
  bus: EventBus<Tx>;
  /** Runs `work` in a producer transaction: commits, or rolls back and rethrows when `work` throws. */
  transaction(work: (tx: Tx) => Promise<void>): Promise<void>;
  /** A new bus instance on the same storage, as after a restart of the platform. */
  restart(): EventBus<Tx>;
}

interface TestEvent extends BusEvent {
  data: { n: number };
}

/**
 * The behaviour every event bus must show. Runs against the real adapter and the fake,
 * so the fake stays a faithful stand-in. Each test uses its own event type and
 * subscription names, so tests may share one storage.
 */
export function describeEventBus<Tx>(name: string, setup: () => Promise<EventBusSuiteContext<Tx>> | EventBusSuiteContext<Tx>) {
  describe(`event bus: ${name}`, () => {
    let context: EventBusSuiteContext<Tx>;
    let type: string;
    const buses: EventBus<Tx>[] = [];

    beforeEach(async () => {
      context = await setup();
      buses.push(context.bus);
      type = `dev.tendworks.test.${crypto.randomUUID()}`;
    });

    afterEach(async () => {
      await Promise.all(buses.splice(0).map((bus) => bus.close()));
    });

    const event = (n: number): TestEvent => ({ id: `${type}:${n}`, source: "/tendworks/test", type, data: { n } });
    const publish = (...events: TestEvent[]) =>
      context.transaction(async (tx) => {
        for (const e of events) await context.bus.publish(tx, e);
      });
    const collect = (bus = context.bus, subscription = `sub-${crypto.randomUUID()}`) => {
      const received: number[] = [];
      bus.subscribe<TestEvent>(subscription, async (e) => void received.push(e.data.n), { types: [type] });
      return received;
    };

    it("delivers an event published in a committed transaction", async () => {
      const received = collect();

      await publish(event(1));

      await vi.waitFor(() => expect(received).toEqual([1]));
    });

    it("never delivers an event whose transaction rolled back", async () => {
      const received = collect();

      await expect(
        context.transaction(async (tx) => {
          await context.bus.publish(tx, event(1));
          throw new Error("state change failed");
        }),
      ).rejects.toThrow("state change failed");
      await publish(event(2));

      await vi.waitFor(() => expect(received).toEqual([2]));
    });

    it("delivers events in the order they were published", async () => {
      const received = collect();

      await publish(event(1), event(2));
      await publish(event(3));

      await vi.waitFor(() => expect(received).toEqual([1, 2, 3]));
    });

    it("delivers an event published twice with the same id once", async () => {
      const received = collect();

      await publish(event(1));
      await publish(event(1), event(2));

      await vi.waitFor(() => expect(received).toEqual([1, 2]));
    });

    it("delivers only the event types a subscription asked for", async () => {
      const received = collect();

      await publish({ ...event(1), type: `${type}.other` }, event(2));

      await vi.waitFor(() => expect(received).toEqual([2]));
    });

    it("delivers every event to each subscription independently", async () => {
      const first = collect();
      const second = collect();

      await publish(event(1), event(2));

      await vi.waitFor(() => expect(first).toEqual([1, 2]));
      await vi.waitFor(() => expect(second).toEqual([1, 2]));
    });

    it("delivers an event again when the handler failed, and keeps the order", async () => {
      const received: number[] = [];
      let failures = 0;
      context.bus.subscribe<TestEvent>(
        `sub-${crypto.randomUUID()}`,
        async (e) => {
          if (e.data.n === 1 && failures++ < 2) throw new Error("handler failed");
          received.push(e.data.n);
        },
        { types: [type] },
      );

      await publish(event(1), event(2));

      await vi.waitFor(() => expect(received).toEqual([1, 2]));
      expect(failures).toBe(3);
    });

    it("resumes a subscription after a restart from where it stopped", async () => {
      const subscription = `sub-${crypto.randomUUID()}`;
      const before = collect(context.bus, subscription);
      await publish(event(1));
      await vi.waitFor(() => expect(before).toEqual([1]));
      await context.bus.close();

      await publish(event(2));
      const restarted = context.restart();
      buses.push(restarted);
      const after = collect(restarted, subscription);

      await vi.waitFor(() => expect(after).toEqual([2]));
      expect(before).toEqual([1]);
    });

    it("delivers events published before a new subscription existed", async () => {
      await publish(event(1));

      const received = collect();

      await vi.waitFor(() => expect(received).toEqual([1]));
    });
  });
}
