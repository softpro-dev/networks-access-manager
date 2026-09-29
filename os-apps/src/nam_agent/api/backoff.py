"""Retry timing (contract §6)."""

from __future__ import annotations

import random
from dataclasses import dataclass, field

AUTH_RETRY_SECONDS = 300.0


@dataclass
class Backoff:
    """Exponential backoff with jitter: 5 s, then doubling, capped at 5 min.

    Delay for attempt n (0-based) is uniform in [d/2, d] with d = min(cap, base * 2**n),
    floored at `base`, so retries start at 5 s and never exceed 300 s.
    """

    base: float = 5.0
    cap: float = 300.0
    rng: random.Random = field(default_factory=random.SystemRandom)
    attempt: int = 0

    def next_delay(self) -> float:
        d = min(self.cap, self.base * (2 ** min(self.attempt, 20)))
        self.attempt += 1
        return max(self.base, min(self.cap, self.rng.uniform(d / 2, d)))

    def reset(self) -> None:
        self.attempt = 0
