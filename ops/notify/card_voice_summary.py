"""Build the one-line startup summary inside the existing private card record."""
import re

from card_artifacts import card_title


def store_voice_summary(card):
    title = card_title(card.get("text", ""), card.get("parse_mode") == "HTML")
    title = re.sub(r'https?://\S+|\ba#[0-9a-f]{6}\b', '', title, flags=re.I)
    card["voice_summary"] = " ".join(title.split())[:200]
