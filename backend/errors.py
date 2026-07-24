"""Shared service errors for the local Monument backend."""

from __future__ import annotations

import math


class ServiceError(Exception):
    """An expected API failure with a safe client-facing status code."""

    def __init__(self, message: str, status: int = 500, retry_after: int | None = None):
        super().__init__(message)
        self.status = status
        self.retry_after = max(1, math.ceil(retry_after)) if retry_after else None
