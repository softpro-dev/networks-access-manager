"""Scrub anything that looks like a credential out of log text."""

from __future__ import annotations

import logging
import re

_PATTERNS = [
    (re.compile(r"ndc_[A-Za-z0-9]+\.[A-Za-z0-9_\-]+"), "ndc_***"),
    (re.compile(r"(?i)(bearer\s+)\S+"), r"\1***"),
    (re.compile(r"(?i)(x-registration-token|x-enrollment-secret|authorization)([\"']?\s*[:=]\s*[\"']?)[^\s\"',}]+"), r"\1\2***"),
]


def redact(text: str) -> str:
    for pattern, repl in _PATTERNS:
        text = pattern.sub(repl, text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        clean = redact(msg)
        if clean != msg:
            record.msg, record.args = clean, None
        return True
