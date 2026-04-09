import { afterEach, beforeEach, vi } from 'vitest';
import { resetStoreState } from './helpers';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

beforeEach(() => {
  resetStoreState();
  vi.useRealTimers();
});

afterEach(() => {
  resetStoreState();
  vi.restoreAllMocks();
});
