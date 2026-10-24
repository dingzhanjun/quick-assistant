"""Fuzzy menu search for big menus (the agent's `search_menu` tool).

Runs in memory over the menu the agent fetched from the database when the call started, so it is always
current and needs no extra service. It is built for spoken, mis-heard input:

- exact / containment / character-bigram overlap / edit-similarity on the dish names;
- a lower-weight match on ingredient words in the description ("something with shrimp").
"""
from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

_NON_WORD = re.compile(r"[\W_]+", re.UNICODE)
_WORDS = re.compile(r"[a-z0-9]+")
# Filler words people say around a dish name; they must not take part in matching.
_STOPWORDS = {
    "something", "anything", "some", "with", "without", "the", "and", "for", "please", "want", "would", "like",
    "dish", "dishes", "have", "you", "any", "your", "order", "get", "can", "could", "give", "one", "two",
    "three", "that", "this", "one", "what", "does", "contain", "has", "include",
}


def normalize(text: str | None) -> str:
    """Lower-case, full-width -> ascii, and drop spaces and punctuation."""
    return _NON_WORD.sub("", unicodedata.normalize("NFKC", text or "").casefold())


def _words(text: str | None) -> set[str]:
    return set(_WORDS.findall(unicodedata.normalize("NFKC", text or "").casefold()))


def _bigrams(s: str) -> set[str]:
    return {s[i : i + 2] for i in range(len(s) - 1)} or {s}


def _similarity(a: str, b: str) -> float:
    """0-100 similarity of two normalized strings."""
    if not a or not b:
        return 0.0
    if a == b:
        return 100.0
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    if len(short) >= 2 and short in long_:  # "chicken" inside "kungpaochicken"
        return 85 + 10 * len(short) / len(long_)
    if len(long_) > 2.5 * len(short):  # a long phrase vs a short name only matches by coincidence
        return 0.0
    A, B = _bigrams(a), _bigrams(b)
    dice = 2 * len(A & B) / (len(A) + len(B))
    return max(80 * dice, 75 * SequenceMatcher(None, a, b).ratio())


def score_item(query: str, item: dict) -> float:
    qn = normalize(query)
    if not qn:
        return 0.0
    best = _similarity(qn, normalize(item.get("name")))
    content = {w for w in _words(query) if len(w) >= 3 and w not in _STOPWORDS}
    # A sentence like "something with eggplant": judge each content word on its own and take the AVERAGE,
    # so a dish that matches only one of several words ("curry chicken" for "kung pow chicken") cannot
    # outrank a dish that matches the whole phrase.
    if content and len(_words(query)) > 1:
        per_word = []
        for w in content:
            per_word.append(_similarity(w, normalize(item.get("name"))))
        best = max(best, 0.9 * sum(per_word) / len(per_word))
    if content & _words(item.get("description")):
        best = max(best, 55.0)
    return best


def menu_categories(items: list[dict]) -> list[dict]:
    """The distinct categories used by the items, in the restaurant's order ({name, position})."""
    seen: dict[str, dict] = {}
    for i in items:
        for c in i.get("categories") or []:
            seen.setdefault(c["name"], c)
    return sorted(seen.values(), key=lambda c: (c.get("position", 0), c["name"]))


def score_category(query: str, cat: dict) -> float:
    qn = normalize(query)
    return _similarity(qn, normalize(cat.get("name"))) if qn else 0.0


class MenuIndex:
    def __init__(self, items: list[dict]) -> None:
        self.items = items
        self.categories = menu_categories(items)

    def match_category(self, query: str, min_score: float = 85.0) -> dict | None:
        """The category the caller is asking about ("drinks"), if the query names one."""
        scored = [(score_category(query, c), c) for c in self.categories]
        scored = [t for t in scored if t[0] >= min_score]
        return max(scored, key=lambda t: t[0])[1] if scored else None

    def items_in(self, cat: dict) -> list[dict]:
        return [i for i in self.items if any(c["name"] == cat["name"] for c in i.get("categories") or [])]

    def search(self, query: str, limit: int = 5, min_score: float = 50.0) -> list[tuple[float, dict]]:
        scored = [(score_item(query, i), i) for i in self.items]
        hits = [(s, i) for s, i in scored if s >= min_score]
        # best score first; among equals prefer the shorter (more specific-looking) name
        hits.sort(key=lambda t: (-round(t[0], 1), len(t[1].get("name", ""))))
        return hits[:limit]
