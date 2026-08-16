"""
Asking Filmweb what a film is, and deciding whether to believe the answer.

Why this source and not TMDb: TMDb hands out no key without an account, and the
question "which of these is my file" is answered far better by a site that
already publishes, as plain JSON, the three facts needed to check an identity —
the year, the runtime and both the Polish and the original title. Two endpoints
are used, both the ones filmweb.pl's own pages call:

    GET /api/v1/live/search?query=…   titles matching a phrase
    GET /api/v1/film/{id}/preview     year, genres, runtime, titles, countries

Nothing is scraped out of HTML and no login is involved, but this is still
somebody else's server answering a question it was not asked to answer, so the
client here is deliberately slow (one request at a time, a pause between them),
caches everything it reads, and is off until the owner turns it on.

**Matching is the whole problem.** A file called ``Blood Diamond (2006)`` is
easy; ``ARLINGTON ROAD ｜ Jeff Bridges ｜ cały film ｜ lektor po polsku.mp4`` is a
YouTube rip whose name is an advertisement, and ``Batman i Robin`` matches four
different films. So a candidate is not accepted for looking plausible — it has
to agree with what the catalogue already knows, and the strongest witness is one
the file itself provides: **ffprobe has already measured the runtime**. A film
whose title, year and runtime all agree is the film. One that agrees on the
title alone is a guess, and a guess is parked for a person to look at rather
than written into the catalogue.
"""

from __future__ import annotations

import json
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from .naming import SearchSubject

__all__ = [
    "Candidate",
    "FilmwebClient",
    "FilmwebError",
    "Match",
    "best_match",
    "score_candidate",
]

_BASE = "https://www.filmweb.pl/api/v1"

# The site answers in Polish or English depending on this header, and the genre
# dictionary seeded by migration 029 carries both spellings, so only the ids are
# actually read off a response — the locale just has to be a valid one.
_LOCALE = "pl_PL"

_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TryHackXMediaServer/1.0"

# Confidence at or above which a match is written into the catalogue unattended,
# and the margin by which it must beat the runner-up. Both exist because the
# expensive mistake here is silent: a wrong genre looks exactly like a right one
# on screen, and nothing would ever prompt anybody to check it.
ACCEPT_CONFIDENCE = 82
ACCEPT_MARGIN = 12

# Below this a candidate is not even worth showing as an alternative.
OFFER_CONFIDENCE = 30

# How close a search hit's name has to be before its full record is worth
# fetching, and how many are read at most. Both bound the traffic this job
# makes: a search for "Batman" comes back with a dozen titles, and reading every
# one of them costs a request that the name alone has already made pointless.
_PREVIEW_THRESHOLD = 0.55
_MAX_PREVIEWS = 4


class FilmwebError(RuntimeError):
    pass


@dataclass(frozen=True)
class Candidate:
    filmweb_id: int
    entity: str  # "film" or "serial"
    title: str
    original_title: str
    year: int | None
    duration_minutes: int | None
    genre_ids: tuple[int, ...]
    poster_path: str | None = None

    @property
    def url(self) -> str:
        return f"https://www.filmweb.pl/{'serial' if self.entity == 'serial' else 'film'}/-0-{self.filmweb_id}"

    def as_dict(self) -> dict[str, Any]:
        return {
            "filmweb_id": self.filmweb_id,
            "entity": self.entity,
            "title": self.title,
            "original_title": self.original_title,
            "year": self.year,
            "duration_minutes": self.duration_minutes,
            "genre_ids": list(self.genre_ids),
            "url": self.url,
        }


@dataclass
class Match:
    """The outcome of one lookup: what won, how sure, and what else was close."""

    candidate: Candidate | None
    confidence: int
    reasons: list[str] = field(default_factory=list)
    alternatives: list[tuple[Candidate, int]] = field(default_factory=list)

    @property
    def accepted(self) -> bool:
        return self.candidate is not None and self.confidence >= ACCEPT_CONFIDENCE


def _fold(text: str) -> str:
    """A title reduced to what two spellings of it have in common."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(character for character in text if not unicodedata.combining(character))
    text = text.replace("ł", "l").replace("Ł", "L")
    text = re.sub(r"[^0-9a-zA-Z]+", " ", text.lower())
    # Leading articles move around between languages and catalogues.
    text = re.sub(r"^(?:the|a|an)\s+", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _similarity(left: str, right: str) -> float:
    left, right = _fold(left), _fold(right)
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    ratio = SequenceMatcher(None, left, right).ratio()
    # "Batman" against "Batman Forever" is a real containment rather than a
    # coincidence, but it is still not an identity, so it is capped below one.
    if left in right or right in left:
        ratio = max(ratio, 0.88)
    return ratio


class FilmwebClient:
    """
    A polite, cached, blocking reader of the two endpoints above.

    Politeness is not decoration: this runs over a few thousand files, and a
    burst of that size against a site that never agreed to serve it is how an
    address gets blocked. One request at a time, `min_interval` seconds apart,
    and every answer kept on disk so a rerun asks nothing twice.
    """

    def __init__(
        self,
        *,
        cache_path: Path,
        min_interval: float = 1.0,
        timeout_seconds: float = 15.0,
        cache_ttl_seconds: float = 30 * 24 * 3600,
        opener: Any = None,
    ) -> None:
        self._cache_path = cache_path
        self._min_interval = max(0.0, min_interval)
        self._timeout = timeout_seconds
        self._ttl = cache_ttl_seconds
        self._opener = opener or urllib.request.urlopen
        self._last_request = 0.0
        self.requests_made = 0

    def _cache_file(self, key: str) -> Path:
        safe = re.sub(r"[^a-z0-9]+", "-", key.lower()).strip("-")[:120]
        digest = f"{abs(hash(key)):x}" if not safe else safe
        return self._cache_path / f"{digest}.json"

    def _read_cache(self, key: str) -> Any | None:
        path = self._cache_file(key)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(raw, dict) or "stored_at" not in raw:
            return None
        if time.time() - float(raw["stored_at"]) > self._ttl:
            return None
        return raw.get("body")

    def _write_cache(self, key: str, body: Any) -> None:
        try:
            self._cache_path.mkdir(parents=True, exist_ok=True)
            self._cache_file(key).write_text(
                json.dumps({"stored_at": time.time(), "body": body}, ensure_ascii=False),
                encoding="utf-8",
            )
        except OSError:
            # A cache that cannot be written is a slower lookup, not a failure.
            pass

    def _get(self, path: str, cache_key: str) -> Any:
        cached = self._read_cache(cache_key)
        if cached is not None:
            return cached

        wait = self._min_interval - (time.monotonic() - self._last_request)
        if wait > 0:
            time.sleep(wait)

        request = urllib.request.Request(
            _BASE + path,
            headers={
                "Accept": "application/json",
                "X-Locale": _LOCALE,
                "User-Agent": _USER_AGENT,
            },
        )
        try:
            with self._opener(request, timeout=self._timeout) as response:
                payload = response.read()
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise FilmwebError(f"Filmweb request failed: {exc}") from exc
        finally:
            self._last_request = time.monotonic()
            self.requests_made += 1

        try:
            body = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise FilmwebError("Filmweb returned something that is not JSON") from exc
        self._write_cache(cache_key, body)
        return body

    def search(self, title: str, *, limit: int = 6) -> list[dict[str, Any]]:
        """Raw search hits for a phrase: films and series, people dropped."""
        query = title.strip()
        if not query:
            return []
        body = self._get(
            "/live/search?query=" + urllib.parse.quote(query, safe=""),
            f"search-{_fold(query)}",
        )
        hits = []
        for hit in (body or {}).get("searchHits", []) if isinstance(body, dict) else []:
            entity = str(hit.get("type") or "")
            if entity not in {"film", "serial"} or not hit.get("id"):
                continue
            hits.append({"id": int(hit["id"]), "entity": entity, "title": str(hit.get("matchedTitle") or "")})
            if len(hits) >= limit:
                break
        return hits

    def lookup(self, subject: SearchSubject, *, duration_ms: int | None = None) -> Match:
        """
        One subject, start to finish: search, read the plausible hits, decide.

        Only hits whose name is already in the right neighbourhood are read in
        full. A search for "Batman" returns everything with Batman in the title,
        and fetching a preview for each would multiply this job's traffic by
        five for candidates that the title alone has already ruled out.
        """
        hits = self.search(subject.title)
        near = [hit for hit in hits if _similarity(subject.title, hit["title"]) >= _PREVIEW_THRESHOLD]
        candidates = []
        for hit in (near or hits)[:_MAX_PREVIEWS]:
            candidate = self.preview(hit["id"], hit["entity"])
            if candidate is not None:
                candidates.append(candidate)
        return best_match(subject, candidates, duration_ms=duration_ms)

    def preview(self, filmweb_id: int, entity: str) -> Candidate | None:
        """One title's year, runtime, genres and both spellings of its name."""
        body = self._get(f"/film/{filmweb_id}/preview", f"preview-{filmweb_id}")
        if not isinstance(body, dict):
            return None
        title = str((body.get("title") or {}).get("title") or "")
        original = str((body.get("originalTitle") or {}).get("title") or "")
        genre_ids = tuple(
            int(genre["id"]) for genre in body.get("genres") or [] if isinstance(genre, dict) and genre.get("id")
        )
        duration = body.get("duration")
        return Candidate(
            filmweb_id=filmweb_id,
            entity=str(body.get("entityName") or entity),
            title=title or original,
            original_title=original or title,
            year=int(body["year"]) if body.get("year") else None,
            duration_minutes=int(duration) if duration else None,
            genre_ids=genre_ids,
            poster_path=(body.get("poster") or {}).get("path"),
        )


def score_candidate(
    subject: SearchSubject,
    candidate: Candidate,
    *,
    duration_ms: int | None = None,
) -> tuple[int, list[str]]:
    """
    How far a candidate agrees with what is already known, from 0 to 100.

    The title opens the account and the other facts settle it. Year and runtime
    are what make this more than a string comparison: "Batman" matches a dozen
    films by name and exactly one of them is 126 minutes long and came out in
    1989.
    """
    reasons: list[str] = []

    name = max(
        _similarity(subject.title, candidate.title),
        _similarity(subject.title, candidate.original_title),
    )
    score = name * 60.0
    reasons.append(f"title {name:.0%}")

    expected_entity = "serial" if subject.is_episode else "film"
    if candidate.entity != expected_entity:
        # A series and the film made from it share a name and nothing else.
        score -= 25.0
        reasons.append(f"wrong kind ({candidate.entity})")

    if subject.year and candidate.year:
        gap = abs(subject.year - candidate.year)
        if gap == 0:
            score += 22.0
            reasons.append("year exact")
        elif gap == 1:
            # A film released in December reaches Poland in January.
            score += 12.0
            reasons.append("year ±1")
        else:
            score -= min(30.0, 8.0 * gap)
            reasons.append(f"year off by {gap}")
    elif subject.year or candidate.year:
        reasons.append("year unknown on one side")

    # Runtime is the witness the file itself provides, so it is worth as much as
    # the year — but only for a film. A series preview reports one episode's
    # length, or nothing, and comparing that to the episode in hand proves little.
    if duration_ms and candidate.duration_minutes and not subject.is_episode:
        measured = duration_ms / 60000.0
        gap = abs(measured - candidate.duration_minutes)
        if gap <= 2:
            score += 22.0
            reasons.append("runtime matches")
        elif gap <= 6:
            score += 10.0
            reasons.append(f"runtime ~{gap:.0f} min out")
        else:
            score -= min(35.0, gap)
            reasons.append(f"runtime {gap:.0f} min out")
    elif not subject.is_episode:
        reasons.append("runtime not comparable")

    return max(0, min(100, round(score))), reasons


def best_match(
    subject: SearchSubject,
    candidates: list[Candidate],
    *,
    duration_ms: int | None = None,
) -> Match:
    """
    The candidate to believe, if any, and everything else worth offering.

    Two guards stand between a search result and the catalogue. The first is the
    score itself. The second is the **margin**: two candidates that score alike
    mean the evidence does not separate them, and picking the higher one would be
    a coin toss recorded as a fact — so a close pair goes to review even when
    both look good. That is the case the owner asked for: when the system is not
    sure, it says so instead of choosing.
    """
    if not candidates:
        return Match(candidate=None, confidence=0, reasons=["nothing found"])

    ranked = sorted(
        ((candidate, *score_candidate(subject, candidate, duration_ms=duration_ms)) for candidate in candidates),
        key=lambda row: row[1],
        reverse=True,
    )
    winner, confidence, reasons = ranked[0]
    runner_up = ranked[1][1] if len(ranked) > 1 else 0
    alternatives = [(candidate, value) for candidate, value, _ in ranked[1:] if value >= OFFER_CONFIDENCE]

    if confidence >= ACCEPT_CONFIDENCE and (confidence - runner_up) < ACCEPT_MARGIN:
        reasons = [*reasons, f"too close to call ({confidence} vs {runner_up})"]
        # Reported below the bar on purpose: the number is what decides whether
        # this is written unattended, and this one must not be.
        confidence = min(confidence, ACCEPT_CONFIDENCE - 1)

    return Match(candidate=winner, confidence=confidence, reasons=reasons, alternatives=alternatives)
