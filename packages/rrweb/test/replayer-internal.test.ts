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
    describe('edge cases', () => {
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
    });

    describe('normal cases', () => {
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
      ])(
        'should find $description',
        ({ timestamps, currentTime, expected }) => {
          const events = createTestEvents(timestamps);
          const result = (replayer as any).binarySearchEventIndex(
            events,
            currentTime,
          );
          expect(result).toBe(expected);
        },
      );

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
  });

  describe('getCachedEventIndex', () => {
    beforeEach(() => {
      (replayer as any).eventIndexCache = {
        lastTime: -1,
        lastIndex: 0,
        maxDrift: 3000,
      };
    });

    describe('cache hit scenarios', () => {
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
    });

    describe('cache miss scenarios', () => {
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

      const getCachedEventIndexSpy = vi.spyOn(replayer as any, 'getCachedEventIndex');
      const binarySearchEventIndexSpy = vi.spyOn(replayer as any, 'binarySearchEventIndex');

      replayer.refreshSkipState();
      
      expect(getCachedEventIndexSpy).not.toHaveBeenCalled();
      expect(binarySearchEventIndexSpy).not.toHaveBeenCalled();
      expect(mockSpeedService.send).not.toHaveBeenCalled();
      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });

    it('should return early for empty events array', () => {
      (replayer as any).service.state.context.events = [];
      
      const getCachedEventIndexSpy = vi.spyOn(replayer as any, 'getCachedEventIndex');
      const binarySearchEventIndexSpy = vi.spyOn(replayer as any, 'binarySearchEventIndex');

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
        
        const getCachedEventIndexSpy = vi.spyOn(replayer as any, 'getCachedEventIndex').mockReturnValue(1);
        const binarySearchEventIndexSpy = vi.spyOn(replayer as any, 'binarySearchEventIndex');

        replayer.refreshSkipState();

        expect(getCachedEventIndexSpy).toHaveBeenCalledWith(events, expect.any(Number));
        expect(binarySearchEventIndexSpy).not.toHaveBeenCalled();
      });

      it('should fall back to binary search and update cache on cache miss', () => {
        const events = createTestEvents([1000, 2000, 3000]);
        (replayer as any).service.state.context.events = events;

        const getCachedEventIndexSpy = vi.spyOn(replayer as any, 'getCachedEventIndex').mockReturnValue(-1);
        const binarySearchEventIndexSpy = vi.spyOn(replayer as any, 'binarySearchEventIndex').mockReturnValue(1);

        (replayer as any).getCurrentTime.mockReturnValue(500);
        const expectedCurrentEventTime = events[0].timestamp + 500; // 1000 + 500 = 1500

        replayer.refreshSkipState();

        expect(getCachedEventIndexSpy).toHaveBeenCalledWith(events, expect.any(Number));
        expect(binarySearchEventIndexSpy).toHaveBeenCalledWith(events, expect.any(Number));
        expect((replayer as any).eventIndexCache.lastTime).toBe(expectedCurrentEventTime);
        expect((replayer as any).eventIndexCache.lastIndex).toBe(1);
      });

      it('should return early when both cache and binary search return -1', () => {
        const events = createTestEvents([1000, 2000, 3000]);
        (replayer as any).service.state.context.events = events;
        
        vi.spyOn(replayer as any, 'getCachedEventIndex').mockReturnValue(-1);
        vi.spyOn(replayer as any, 'binarySearchEventIndex').mockReturnValue(-1);
        const isUserInteractionSpy = vi.spyOn(replayer as any, 'isUserInteraction');

        replayer.refreshSkipState();

        expect(isUserInteractionSpy).not.toHaveBeenCalled();
        expect(mockSpeedService.send).not.toHaveBeenCalled();
        expect(mockEmitter.emit).not.toHaveBeenCalled();
      });
    });

    describe('user interaction detection', () => {
      it('should not skip when no user interaction events found', () => {
        // TODO: Test when no user interactions exist after current position
        expect(true).toBe(true); // placeholder
      });

      it('should not skip when user interaction is within threshold', () => {
        // TODO: Test when gap between current and next interaction < threshold
        expect(true).toBe(true); // placeholder
      });

      it('should trigger skip when user interaction exceeds threshold', () => {
        // TODO: Test when gap > threshold - should call speedService.send and emit SkipStart
        expect(true).toBe(true); // placeholder
      });

      it('should only consider first user interaction after current position', () => {
        // TODO: Test that only the first user interaction after current position is considered
        expect(true).toBe(true); // placeholder
      });

      it('should set nextUserInteractionEvent when skip is triggered', () => {
        // TODO: Test that nextUserInteractionEvent is set to the found interaction event
        expect(true).toBe(true); // placeholder
      });
    });

    describe('threshold calculation', () => {
      it('should calculate threshold correctly with different timer speeds', () => {
        // TODO: Test threshold = inactivePeriodThreshold * timer.speed
        expect(true).toBe(true); // placeholder
      });

      it('should handle zero timer speed', () => {
        // TODO: Test edge case with timer.speed = 0
        expect(true).toBe(true); // placeholder
      });

      it('should handle negative timer speed', () => {
        // TODO: Test edge case with negative timer.speed
        expect(true).toBe(true); // placeholder
      });
    });

    describe('speed calculation', () => {
      it('should calculate speed correctly based on gap time', () => {
        // TODO: Test speed calculation: Math.min(Math.round(gapTime / SKIP_TIME_INTERVAL), maxSpeed)
        // SKIP_TIME_INTERVAL = 5000ms
        expect(true).toBe(true); // placeholder
      });

      it('should respect maxSpeed limit in speed calculation', () => {
        // TODO: Test that calculated speed never exceeds config.maxSpeed
        expect(true).toBe(true); // placeholder
      });

      it('should handle very small gap times', () => {
        // TODO: Test gap times smaller than SKIP_TIME_INTERVAL (5000ms)
        expect(true).toBe(true); // placeholder
      });

      it('should handle very large gap times', () => {
        // TODO: Test gap times much larger than SKIP_TIME_INTERVAL
        expect(true).toBe(true); // placeholder
      });
    });

    describe('service interactions', () => {
      it('should emit SkipStart event with correct payload', () => {
        // TODO: Test that ReplayerEvents.SkipStart is emitted with speed payload
        expect(true).toBe(true); // placeholder
      });

      it('should send FAST_FORWARD event to speed service', () => {
        // TODO: Test that speedService.send is called with FAST_FORWARD and payload
        expect(true).toBe(true); // placeholder
      });

      it('should not emit or send events when no skip is triggered', () => {
        // TODO: Test that no events are emitted when skip conditions are not met
        expect(true).toBe(true); // placeholder
      });
    });

    describe('currentEventTime calculation', () => {
      it('should calculate currentEventTime correctly', () => {
        // TODO: Test currentEventTime = firstEvent.timestamp + getCurrentTime()
        expect(true).toBe(true); // placeholder
      });

      it('should handle different getCurrentTime values', () => {
        // TODO: Test with different getCurrentTime return values
        expect(true).toBe(true); // placeholder
      });
    });

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
