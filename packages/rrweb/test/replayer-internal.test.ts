/**
 * @vitest-environment jsdom
 */
import { vi } from 'vitest';
import { Replayer } from '../src/replay';
import { EventType, IncrementalSource } from '@sentry-internal/rrweb-types';
import type { eventWithTime } from '@sentry-internal/rrweb-types';

describe('Replayer Internal Methods', () => {
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

  describe('binarySearchEventIndex', () => {
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
        description: 'single event before timestamp',
      },
      {
        timestamps: [1000],
        currentTime: 1000,
        expected: 0,
        description: 'single event at timestamp',
      },
      {
        timestamps: [1000],
        currentTime: 2000,
        expected: 0,
        description: 'single event after timestamp',
      },
      {
        timestamps: [2000, 3000, 4000],
        currentTime: 1000,
        expected: -1,
        description: 'before all events',
      },
      {
        timestamps: [1000, 2000, 3000],
        currentTime: 5000,
        expected: 2,
        description: 'after all events',
      },
    ])(
      'should handle $description',
      ({ timestamps, currentTime, expected }) => {
        const events = timestamps.length ? createTestEvents(timestamps) : [];
        const result = (replayer as any).binarySearchEventIndex(
          events,
          currentTime,
        );
        expect(result).toBe(expected);
      },
    );

    it.each([
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
      {
        timestamps: [1000, 2000, 3000, 4000],
        currentTime: 1000,
        expected: 0,
        description: 'correct index for first event',
      },
      {
        timestamps: [1000, 2000, 3000, 4000],
        currentTime: 4000,
        expected: 3,
        description: 'correct index for last event',
      },
    ])('should find $description', ({ timestamps, currentTime, expected }) => {
      const events = createTestEvents(timestamps);
      const result = (replayer as any).binarySearchEventIndex(
        events,
        currentTime,
      );
      expect(result).toBe(expected);
    });

    it.each([
      { time: 100, expected: 0, description: 'first element' },
      { time: 100000, expected: 999, description: 'last element' },
      { time: 50000, expected: 499, description: 'middle element' },
      { time: 25000, expected: 249, description: 'quarter position' },
      { time: 75000, expected: 749, description: 'three-quarter position' },
      { time: 99950, expected: 998, description: 'near end (worst case)' },
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
        const result = (replayer as any).binarySearchEventIndex(events, time);
        const endTime = performance.now();

        expect(result).toBe(expected);
        // Binary search should be fast even with 1000 elements (< 5ms per search)
        expect(endTime - startTime).toBeLessThan(5);
      },
    );
  });

  describe('getCachedEventIndex', () => {
    beforeEach(() => {
      (replayer as any).eventIndexCache = {
        lastTime: -1,
        lastIndex: 0,
        maxDrift: 3000,
      };
    });

    it.each([
      {
        cachedTimestamp: 2000,
        cachedIndex: 1,
        currentTime: 2000,
        expected: 1,
        description: 'exact timestamp match',
      },
      {
        cachedTimestamp: 5000,
        cachedIndex: 1,
        currentTime: 7000, // 5000 + 2000 (within maxDrift)
        expected: 1,
        description: 'within maxDrift tolerance',
      },
      {
        cachedTimestamp: 5000,
        cachedIndex: 1,
        currentTime: 8000, // 5000 + 3000 (exactly at maxDrift)
        expected: 1,
        description: 'at maxDrift boundary (positive)',
      },
      {
        cachedTimestamp: 5000,
        cachedIndex: 1,
        currentTime: 2000, // 5000 - 3000 (exactly at maxDrift)
        expected: 1,
        description: 'at maxDrift boundary (negative)',
      },
    ])(
      'should return cached index for $description',
      ({ cachedTimestamp, cachedIndex, currentTime, expected }) => {
        const events = createTestEvents([1000, cachedTimestamp, 9000]);
        (replayer as any).eventIndexCache = {
          lastTime: cachedTimestamp,
          lastIndex: cachedIndex,
          maxDrift: 3000,
        };
        const result = (replayer as any).getCachedEventIndex(
          events,
          currentTime,
        );
        expect(result).toBe(expected);
      },
    );

    it.each([
      {
        cachedTimestamp: 5000,
        cachedIndex: 1,
        currentTime: 8001, // 5000 + 3001 (beyond maxDrift)
        expected: -1,
        description: 'beyond maxDrift tolerance (positive)',
      },
      {
        cachedTimestamp: 5000,
        cachedIndex: 1,
        currentTime: 1999, // 5000 - 3001 (beyond maxDrift)
        expected: -1,
        description: 'beyond maxDrift tolerance (negative)',
      },
      {
        cachedTimestamp: 5000,
        cachedIndex: 5, //Index >= events.length (3)
        currentTime: 5000,
        expected: -1,
        description: 'cache.lastIndex way beyond events.length',
      },
    ])(
      'should return -1 when $description',
      ({ cachedTimestamp, cachedIndex, currentTime, expected }) => {
        const events = createTestEvents([1000, 5000, 9000]);
        (replayer as any).eventIndexCache = {
          lastTime: cachedTimestamp,
          lastIndex: cachedIndex,
          maxDrift: 3000,
        };
        const result = (replayer as any).getCachedEventIndex(
          events,
          currentTime,
        );
        expect(result).toBe(expected);
      },
    );

    it('should return -1 for empty events array', () => {
      const events: eventWithTime[] = [];
      (replayer as any).eventIndexCache = {
        lastTime: 5000,
        lastIndex: 0,
        maxDrift: 3000,
      };
      const result = (replayer as any).getCachedEventIndex(events, 5000);
      expect(result).toBe(-1);
    });

    it('should return -1 when cached event is undefined due to invalid index', () => {
      const events = createTestEvents([1000, 2000]);
      (replayer as any).eventIndexCache = {
        lastTime: 3000,
        lastIndex: 3,
        maxDrift: 3000,
      };
      const result = (replayer as any).getCachedEventIndex(events, 3000);
      expect(result).toBe(-1);
    });
  });

  describe('refreshSkipState', () => {
    let mockService: any;
    let mockSpeedService: any;
    let mockEmitter: any;

    beforeEach(() => {
      // Mock all the dependencies
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

      // Replace replayer dependencies with mocks
      (replayer as any).service = mockService;
      (replayer as any).speedService = mockSpeedService;
      (replayer as any).emitter = mockEmitter;
      (replayer as any).getCurrentTime = vi.fn().mockReturnValue(5000);
      (replayer as any).isUserInteraction = vi.fn();
    });

    it('should return early when skipInactive is disabled', () => {
      (replayer as any).config.skipInactive = false;

      const getCachedEventIndexSpy = vi.spyOn(
        replayer as any,
        'getCachedEventIndex',
      );
      const binarySearchEventIndexSpy = vi.spyOn(
        replayer as any,
        'binarySearchEventIndex',
      );

      replayer.refreshSkipState();

      expect(getCachedEventIndexSpy).not.toHaveBeenCalled();
      expect(binarySearchEventIndexSpy).not.toHaveBeenCalled();
      expect(mockSpeedService.send).not.toHaveBeenCalled();
      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });

    it('should return early for empty events array', () => {
      (replayer as any).service.state.context.events = [];

      const getCachedEventIndexSpy = vi.spyOn(
        replayer as any,
        'getCachedEventIndex',
      );
      const binarySearchEventIndexSpy = vi.spyOn(
        replayer as any,
        'binarySearchEventIndex',
      );

      replayer.refreshSkipState();

      expect(getCachedEventIndexSpy).not.toHaveBeenCalled();
      expect(binarySearchEventIndexSpy).not.toHaveBeenCalled();
      expect(mockSpeedService.send).not.toHaveBeenCalled();
      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });

    describe('cache integration', () => {
      it('should use cached index when cache hit occurs', () => {
        const events = createTestEvents([1000, 2000, 3000]);
        (replayer as any).service.state.context.events = events;

        const getCachedEventIndexSpy = vi
          .spyOn(replayer as any, 'getCachedEventIndex')
          .mockReturnValue(1);
        const binarySearchEventIndexSpy = vi.spyOn(
          replayer as any,
          'binarySearchEventIndex',
        );

        replayer.refreshSkipState();

        expect(getCachedEventIndexSpy).toHaveBeenCalledWith(
          events,
          expect.any(Number),
        );
        expect(binarySearchEventIndexSpy).not.toHaveBeenCalled();
      });

      it('should fall back to binary search and update cache on cache miss', () => {
        const events = createTestEvents([1000, 2000, 3000]);
        (replayer as any).service.state.context.events = events;

        const getCachedEventIndexSpy = vi
          .spyOn(replayer as any, 'getCachedEventIndex')
          .mockReturnValue(-1);
        const binarySearchEventIndexSpy = vi
          .spyOn(replayer as any, 'binarySearchEventIndex')
          .mockReturnValue(1);

        (replayer as any).getCurrentTime.mockReturnValue(500);
        const expectedCurrentEventTime = events[0].timestamp + 500; // 1000 + 500 = 1500

        replayer.refreshSkipState();

        expect(getCachedEventIndexSpy).toHaveBeenCalledWith(
          events,
          expect.any(Number),
        );
        expect(binarySearchEventIndexSpy).toHaveBeenCalledWith(
          events,
          expect.any(Number),
        );
        expect((replayer as any).eventIndexCache.lastTime).toBe(
          expectedCurrentEventTime,
        );
        expect((replayer as any).eventIndexCache.lastIndex).toBe(1);
      });

      it('should return early when both cache and binary search return -1', () => {
        const events = createTestEvents([1000, 2000, 3000]);
        (replayer as any).service.state.context.events = events;

        vi.spyOn(replayer as any, 'getCachedEventIndex').mockReturnValue(-1);
        vi.spyOn(replayer as any, 'binarySearchEventIndex').mockReturnValue(-1);
        const isUserInteractionSpy = vi.spyOn(
          replayer as any,
          'isUserInteraction',
        );

        replayer.refreshSkipState();

        expect(isUserInteractionSpy).not.toHaveBeenCalled();
        expect(mockSpeedService.send).not.toHaveBeenCalled();
        expect(mockEmitter.emit).not.toHaveBeenCalled();
      });
    });

    it('should not skip when no user interaction events found', () => {
      const events = createTestEvents([1000, 2000, 3000]);
      (replayer as any).service.state.context.events = events;

      vi.spyOn(replayer as any, 'getCachedEventIndex').mockReturnValue(-1);
      vi.spyOn(replayer as any, 'binarySearchEventIndex').mockReturnValue(1);
      (replayer as any).isUserInteraction.mockReturnValue(false); // No user interactions

      replayer.refreshSkipState();

      expect(mockSpeedService.send).not.toHaveBeenCalled();
      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });

    it('should not skip when user interaction gap is within threshold', () => {
      const events = createTestEvents([1000, 2000, 3000]); // Gap of 1000ms
      (replayer as any).service.state.context.events = events;
      (replayer as any).config.inactivePeriodThreshold = 5000; // 5000 * 1 = 5000ms threshold

      vi.spyOn(replayer as any, 'getCachedEventIndex').mockReturnValue(-1);
      vi.spyOn(replayer as any, 'binarySearchEventIndex').mockReturnValue(1);
      (replayer as any).isUserInteraction.mockImplementation(
        (event: any) => event.timestamp === 3000,
      );

      replayer.refreshSkipState();

      // Gap (1000) < threshold (5000), so no skip
      expect(mockSpeedService.send).not.toHaveBeenCalled();
      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });

    it('should trigger skip when user interaction gap exceeds threshold', () => {
      const events = createTestEvents([1000, 2000, 8000]); // Gap of 6000ms
      (replayer as any).service.state.context.events = events;
      (replayer as any).config.inactivePeriodThreshold = 5000; // 5000 * 1 = 5000ms threshold
      (replayer as any).config.maxSpeed = 360;

      vi.spyOn(replayer as any, 'getCachedEventIndex').mockReturnValue(-1);
      vi.spyOn(replayer as any, 'binarySearchEventIndex').mockReturnValue(1);
      (replayer as any).isUserInteraction.mockImplementation(
        (event: any) => event.timestamp === 8000,
      );

      replayer.refreshSkipState();

      // Gap (6000) > threshold (5000), so skip should be triggered
      expect(mockSpeedService.send).toHaveBeenCalledWith({
        type: 'FAST_FORWARD',
        payload: { speed: Math.min(Math.round(6000 / 5000), 360) }, // Math.min(1, 360) = 1
      });
      expect(mockEmitter.emit).toHaveBeenCalled();
      expect((replayer as any).nextUserInteractionEvent.timestamp).toBe(8000);
    });

    it.each([
      {
        gapTime: 6000,
        maxSpeed: 360,
        expectedSpeed: 1,
        description: 'small gap (6000ms / 5000ms = 1.2 → 1)',
      },
      {
        gapTime: 10000,
        maxSpeed: 360,
        expectedSpeed: 2,
        description: 'exact multiple (10000ms / 5000ms = 2)',
      },
      {
        gapTime: 12500,
        maxSpeed: 360,
        expectedSpeed: 3,
        description: 'rounding up (12500ms / 5000ms = 2.5 → 3)',
      },
      {
        gapTime: 50000,
        maxSpeed: 360,
        expectedSpeed: 10,
        description: 'large gap under maxSpeed (50000ms / 5000ms = 10)',
      },
      {
        gapTime: 100000,
        maxSpeed: 8,
        expectedSpeed: 8,
        description: 'capped by maxSpeed (100000ms / 5000ms = 20 → 8)',
      },
      {
        gapTime: 2500,
        maxSpeed: 360,
        expectedSpeed: 1,
        description: 'rounding down (2500ms / 5000ms = 0.5 → 1)',
      },
    ])(
      'should calculate speed correctly for $description',
      ({ gapTime, maxSpeed, expectedSpeed }) => {
        const events = createTestEvents([1000, 2000, 2000 + gapTime]);
        (replayer as any).service.state.context.events = events;
        (replayer as any).config.inactivePeriodThreshold = 1000; // Low threshold to ensure skip
        (replayer as any).config.maxSpeed = maxSpeed;

        vi.spyOn(replayer as any, 'getCachedEventIndex').mockReturnValue(-1);
        vi.spyOn(replayer as any, 'binarySearchEventIndex').mockReturnValue(1);
        (replayer as any).isUserInteraction.mockImplementation(
          (event: any) => event.timestamp === 2000 + gapTime,
        );

        replayer.refreshSkipState();

        expect(mockSpeedService.send).toHaveBeenCalledWith({
          type: 'FAST_FORWARD',
          payload: { speed: expectedSpeed },
        });
      },
    );

    describe('edge cases', () => {
      it('should handle single event array', () => {
        // TODO: Test with single event (no events after current position)
        expect(true).toBe(true); // placeholder
      });

      it('should handle events array with only non-user-interaction events', () => {
        // TODO: Test with events that are not user interactions
        expect(true).toBe(true); // placeholder
      });

      it('should handle currentEventIndex at last position', () => {
        // TODO: Test when currentEventIndex is the last event in the array
        expect(true).toBe(true); // placeholder
      });
    });
  });
});
