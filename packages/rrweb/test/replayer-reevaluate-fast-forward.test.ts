/**
 * @vitest-environment jsdom
 */
import { vi } from 'vitest';
import { Replayer } from '../src/replay';
import * as replayModule from '../src/replay';
import { EventType } from '@sentry-internal/rrweb-types';
import type { eventWithTime } from '@sentry-internal/rrweb-types';

describe('Replayer Reevaluate Fast Forward', () => {
  let replayer: Replayer;

  beforeEach(() => {
    const events: eventWithTime[] = [
      {
        type: EventType.DomContentLoaded,
        data: {},
        timestamp: 1000,
      },
      {
        type: EventType.Load,
        data: {},
        timestamp: 2000,
      },
    ];
    replayer = new Replayer(events, {
      skipInactive: true,
      inactivePeriodThreshold: 10000,
      maxSpeed: 360,
    });
  });

  const createTestEvents = (timestamps: number[]): eventWithTime[] => {
    return timestamps.map((timestamp) => ({
      type: EventType.Load,
      data: {},
      timestamp,
    }));
  };

  describe('getCurrentEventIndex', () => {
    it.each([
      {
        timestamps: [],
        currentTime: 1000,
        expected: -1,
        description: 'empty array',
      },
      {
        timestamps: [2000],
        currentTime: 1000,
        expected: -1,
        description: 'single event after current time',
      },
      {
        timestamps: [1000],
        currentTime: 1000,
        expected: 0,
        description: 'single event at current time',
      },
      {
        timestamps: [1000],
        currentTime: 2000,
        expected: 0,
        description: 'single event before current time',
      },
      {
        timestamps: [2000, 3000, 4000],
        currentTime: 1000,
        expected: -1,
        description: 'current time before all events',
      },
      {
        timestamps: [1000, 2000, 3000],
        currentTime: 5000,
        expected: 2,
        description: 'current time after all events',
      },
      {
        timestamps: [1000, 2000, 3000, 4000, 5000],
        currentTime: 3000,
        expected: 2,
        description: 'exact timestamp match in middle of array',
      },
      {
        timestamps: [1000, 2000, 4000, 5000],
        currentTime: 3500,
        expected: 1,
        description: 'last event at or before timestamp when between events',
      },
      {
        timestamps: [1000, 2000, 2000, 2000, 5000],
        currentTime: 2000,
        expected: 3,
        description:
          'multiple events with same timestamp (returns last occurrence)',
      },
    ])(
      'should handle $description',
      ({ timestamps, currentTime, expected }) => {
        const events = timestamps.length ? createTestEvents(timestamps) : [];
        const result = replayModule.getCurrentEventIndex(events, currentTime);
        expect(result).toBe(expected);
      },
    );

    it.each([
      { time: 100, expected: 0, description: 'first element' },
      { time: 100000, expected: 999, description: 'last element' },
      { time: 50000, expected: 499, description: 'middle element' },
      { time: 25000, expected: 249, description: 'quarter position' },
      { time: 75000, expected: 749, description: 'three-quarter position' },
      { time: 99950, expected: 998, description: 'near end' },
    ])(
      'should perform efficiently with large arrays at $description',
      ({ time, expected }) => {
        // Create a large array of events (1000 events: 100, 200, 300, ..., 100000)
        const timestamps = Array.from(
          { length: 1000 },
          (_, i) => (i + 1) * 100,
        );
        const events = createTestEvents(timestamps);

        const startTime = performance.now();
        const result = replayModule.getCurrentEventIndex(events, time);
        const endTime = performance.now();

        expect(result).toBe(expected);
        // Should be fast even with 1000 elements (< 1ms per search)
        expect(endTime - startTime).toBeLessThan(1);
      },
    );
  });

  describe('reevaluateFastForward', () => {
    let mockService: any;
    let mockSpeedService: any;
    let mockEmitter: any;

    const setupMocks = () => {
      mockService = {
        state: {
          context: {
            events: [],
          },
        },
      };

      mockSpeedService = {
        state: {
          context: {
            timer: {
              speed: 1,
            },
          },
        },
        send: vi.fn(),
      };

      mockEmitter = {
        emit: vi.fn(),
      };

      (replayer as any).service = mockService;
      (replayer as any).speedService = mockSpeedService;
      (replayer as any).emitter = mockEmitter;
      (replayer as any).getCurrentTime = vi.fn().mockReturnValue(5000);
      (replayer as any).isUserInteraction = vi.fn();
    };

    const expectNoFastForward = () => {
      expect(mockSpeedService.send).not.toHaveBeenCalled();
      expect(mockEmitter.emit).not.toHaveBeenCalled();
    };

    const expectFastForward = (
      expectedSpeed: number,
      expectedTimestamp?: number,
    ) => {
      expect(mockSpeedService.send).toHaveBeenCalledWith({
        type: 'FAST_FORWARD',
        payload: { speed: expectedSpeed },
      });
      expect(mockEmitter.emit).toHaveBeenCalled();
      if (expectedTimestamp) {
        expect((replayer as any).nextUserInteractionEvent.timestamp).toBe(
          expectedTimestamp,
        );
      }
    };

    beforeEach(() => {
      setupMocks();
      vi.clearAllMocks();
    });

    it('should return early when skipInactive is disabled', () => {
      (replayer as any).config.skipInactive = false;
      const getCurrentEventIndexSpy = vi.spyOn(
        replayModule,
        'getCurrentEventIndex',
      );

      (replayer as any).reevaluateFastForward();
      expect(getCurrentEventIndexSpy).not.toHaveBeenCalled();
      expectNoFastForward();
    });

    it('should return early for empty events array', () => {
      (replayer as any).service.state.context.events = [];
      const getCurrentEventIndexSpy = vi.spyOn(
        replayModule,
        'getCurrentEventIndex',
      );

      (replayer as any).reevaluateFastForward();
      expect(getCurrentEventIndexSpy).not.toHaveBeenCalled();
      expectNoFastForward();
    });

    it('should return early when binary search returns -1', () => {
      const events = createTestEvents([1000, 2000, 3000]);
      (replayer as any).service.state.context.events = events;

      vi.spyOn(replayModule, 'getCurrentEventIndex').mockReturnValue(-1);
      const isUserInteractionSpy = vi.spyOn(
        replayer as any,
        'isUserInteraction',
      );

      (replayer as any).reevaluateFastForward();
      expect(isUserInteractionSpy).not.toHaveBeenCalled();
      expectNoFastForward();
    });

    it('should not fast forward when no user interaction events found', () => {
      const events = createTestEvents([1000, 2000, 3000]);
      (replayer as any).service.state.context.events = events;

      vi.spyOn(replayModule, 'getCurrentEventIndex').mockReturnValue(1);
      (replayer as any).isUserInteraction.mockReturnValue(false); // No user interactions

      (replayer as any).reevaluateFastForward();
      expectNoFastForward();
    });

    it('should not fast forward when user interaction gap is within threshold', () => {
      const events = createTestEvents([1000, 2000, 3000]);
      (replayer as any).service.state.context.events = events;
      (replayer as any).config.inactivePeriodThreshold = 5000;

      vi.spyOn(replayModule, 'getCurrentEventIndex').mockReturnValue(1);
      (replayer as any).isUserInteraction.mockImplementation(
        (event: any) => event.timestamp === 3000,
      );

      (replayer as any).reevaluateFastForward();

      // Gap (1000) < threshold (5000 * 1), so no skip
      expectNoFastForward();
    });

    it('should fast forward when user interaction gap exceeds threshold', () => {
      const events = createTestEvents([1000, 2000, 8000]);
      (replayer as any).service.state.context.events = events;
      (replayer as any).config.inactivePeriodThreshold = 5000;

      vi.spyOn(replayModule, 'getCurrentEventIndex').mockReturnValue(1);
      (replayer as any).isUserInteraction.mockImplementation(
        (event: any) => event.timestamp === 8000,
      );

      (replayer as any).reevaluateFastForward();

      // Gap (6000) > threshold (5000 * 1), so skip should be triggered
      const expectedSpeed = Math.min(Math.round(6000 / 5000), 360);
      expectFastForward(expectedSpeed, 8000);
    });

    it('should work end-to-end with real binary search and trigger fast forward', () => {
      const events = createTestEvents([1000, 2000, 12000]); // 10 second gap
      (replayer as any).service.state.context.events = events;
      (replayer as any).config.inactivePeriodThreshold = 5000;
      (replayer as any).getCurrentTime = vi.fn().mockReturnValue(1500); // Current time is 1000 + 1500 = 2500ms

      (replayer as any).isUserInteraction.mockImplementation(
        (event: any) => event.timestamp === 12000,
      );

      (replayer as any).reevaluateFastForward();
      const expectedSpeed = Math.min(Math.round(10000 / 5000), 360);
      expectFastForward(expectedSpeed, 12000);
    });

    it.each([
      {
        gapTime: 2500,
        maxSpeed: 360,
        expectedSpeed: 1,
        description: 'rounding up (2500ms / 5000ms = 0.5 → 1)',
      },
      {
        gapTime: 6000,
        maxSpeed: 360,
        expectedSpeed: 1,
        description: 'rounding down (6000ms / 5000ms = 1.2 → 1)',
      },
      {
        gapTime: 10000,
        maxSpeed: 360,
        expectedSpeed: 2,
        description: 'exact multiple (10000ms / 5000ms = 2)',
      },
      {
        gapTime: 50000,
        maxSpeed: 360,
        expectedSpeed: 10,
        description: 'large gap under maxSpeed (50000ms / 5000ms = 10)',
      },
      {
        gapTime: 50000,
        maxSpeed: 8,
        expectedSpeed: 8,
        description: 'large gap capped by maxSpeed (50000ms / 5000ms = 10 → 8)',
      },
    ])(
      'should calculate speed correctly for $description',
      ({ gapTime, maxSpeed, expectedSpeed }) => {
        const events = createTestEvents([1000, 2000, 2000 + gapTime]);
        (replayer as any).service.state.context.events = events;
        (replayer as any).config.inactivePeriodThreshold = 1000; // Low threshold to ensure skip
        (replayer as any).config.maxSpeed = maxSpeed;
        (replayer as any).getCurrentTime = vi.fn().mockReturnValue(1000);

        vi.spyOn(replayModule, 'getCurrentEventIndex').mockReturnValue(1);
        (replayer as any).isUserInteraction.mockImplementation(
          (event: any) => event.timestamp === 2000 + gapTime,
        );

        (replayer as any).reevaluateFastForward();
        expectFastForward(expectedSpeed);
      },
    );

    it('should handle currentEventIndex at last position', () => {
      const events = createTestEvents([1000]); // Single event
      (replayer as any).service.state.context.events = events;

      vi.spyOn(replayModule, 'getCurrentEventIndex').mockReturnValue(0);
      const isUserInteractionSpy = vi.spyOn(
        replayer as any,
        'isUserInteraction',
      );

      (replayer as any).reevaluateFastForward();

      // With only one event and currentEventIndex = 0, there are no events after current position
      // So the for loop (i = currentEventIndex + 1; i < events.length) never executes
      expect(isUserInteractionSpy).not.toHaveBeenCalled();
      expectNoFastForward();
    });
  });
});
