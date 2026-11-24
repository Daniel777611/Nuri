"""Build a repeatable seed for Alpha Community's synthetic parent profiles.

Prints SQL for the authenticated Nuri-Testing project connection. This program
does not open a database connection or handle database credentials.
Re-runs refresh only language, location and bio for accounts bearing the seed
markers. Existing children, preferences and conversations are preserved.
"""

from __future__ import annotations

import argparse
from calendar import monthrange
from datetime import date, datetime, timezone
import json
from pathlib import Path
import re
import uuid
from zoneinfo import ZoneInfo

ALPHA_PROJECT_REF = "kyxnnrmyzmdutqylsxpw"
BOT_EMAIL_SUFFIX = "@alpha-bots.invalid"
PASSWORD_DISABLED = "!nuri-alpha-bot-no-password"
ABOUT_PREFIX = "【Alpha AI 测试家长】"
PERSONAS_PATH = Path(__file__).resolve().parents[1] / "scripts/fixtures/alpha-community-parents.json"
ACTIVITY_LEVELS = {"high", "medium", "low"}
LANGUAGES = {"zh-CN", "zh-TW", "en", "es", "fr", "he", "ja", "ko"}
CONCERNS = {
    "sleep", "food", "emotion", "development", "parenting", "health",
    "childcare", "family", "unknown", "other",
}
_REQUIRED_TEXT_FIELDS = (
    "slug", "name", "role", "roleCode", "occupation", "household", "origin", "location", "timeZone",
    "activity", "voice", "experience", "currentChallenge", "question", "category",
    "concern", "language", "about",
)


def bot_user_id(slug: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"https://alpha-bots.invalid/parents/{slug}"))


def bot_email(slug: str) -> str:
    return slug + BOT_EMAIL_SUFFIX


def load_personas() -> list[dict]:
    rows = json.loads(PERSONAS_PATH.read_text(encoding="utf-8"))
    if not isinstance(rows, list) or len(rows) != 50:
        raise ValueError("The Alpha Community fixture must contain exactly 50 personas")

    slugs: set[str] = set()
    for persona in rows:
        for field in _REQUIRED_TEXT_FIELDS:
            if not isinstance(persona.get(field), str) or not persona[field].strip():
                raise ValueError(f"Missing persona field: {field}")
        slug = persona["slug"]
        if not re.fullmatch(r"[a-z][a-z0-9-]{1,47}", slug) or slug in slugs:
            raise ValueError(f"Invalid or duplicate persona slug: {slug}")
        slugs.add(slug)
        if len(persona["name"]) > 30 or len(persona["location"]) > 60:
            raise ValueError(f"Community profile text is too long: {slug}")
        if len(persona["question"]) > 1000:
            raise ValueError(f"Community question is too long: {slug}")
        if type(persona.get("age")) is not int or not 18 <= persona["age"] <= 85:
            raise ValueError(f"Invalid adult age: {slug}")
        if persona["activity"] not in ACTIVITY_LEVELS or persona["language"] not in LANGUAGES:
            raise ValueError(f"Invalid activity or language: {slug}")
        if persona["roleCode"] not in {"mom", "dad", "grandparent", "other"} or persona["concern"] not in CONCERNS:
            raise ValueError(f"Invalid parent role or concern: {slug}")
        ZoneInfo(persona["timeZone"])
        children = persona.get("children")
        if not isinstance(children, list) or not 1 <= len(children) <= 8:
            raise ValueError(f"Invalid family size: {slug}")
        for child in children:
            months = child.get("ageMonths")
            if type(months) is not int or not 0 <= months <= 215:
                raise ValueError(f"Invalid child age: {slug}")

    if {persona["activity"] for persona in rows} != ACTIVITY_LEVELS:
        raise ValueError("Fixture must include high, medium and low activity")
    return rows


def _birth_date(as_of: date, age_months: int) -> str:
    year, zero_based_month = divmod(as_of.year * 12 + as_of.month - 1 - age_months, 12)
    month = zero_based_month + 1
    return date(year, month, min(as_of.day, monthrange(year, month)[1])).isoformat()


def _child_rows(persona: dict, as_of: date, user_id: str) -> list[dict]:
    children = []
    for index, child in enumerate(persona["children"], start=1):
        nickname = f"孩子 {index}" if persona["language"].startswith("zh-") else f"Child {index}"
        children.append({
            "id": str(uuid.uuid5(uuid.UUID(user_id), f"child:{index}")),
            "nickname": nickname,
            "birth_date": _birth_date(as_of, child["ageMonths"]),
        })
    return children


def _database_rows(personas: list[dict], as_of: date) -> list[dict]:
    rows = []
    for persona in personas:
        slug = persona["slug"]
        user_id = bot_user_id(slug)
        role = persona["roleCode"]
        rows.append({
            "id": user_id,
            "email": bot_email(slug),
            "name": persona["name"],
            "language": persona["language"],
            "role": role,
            "gender_tag": role if role in {"mom", "dad"} else "other",
            "about": (ABOUT_PREFIX + persona["about"])[:300],
            "city": persona["location"],
            "concern": persona["concern"],
            "activity": persona["activity"],
            "children": _child_rows(persona, as_of, user_id),
        })
    return rows


def _sql_json(rows: list[dict]) -> str:
    """Encode data as a SQL escape-string, never executable SQL."""
    data = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    escaped = data.replace("\\", "\\\\").replace("'", "''").replace("$", "\\044")
    return f"E'{escaped}'::jsonb"


def seed_sql(personas: list[dict], *, project_ref: str, as_of: date | None = None) -> str:
    if project_ref != ALPHA_PROJECT_REF:
        raise ValueError("The seed is only for the Nuri-Testing project")
    rows = _database_rows(personas, as_of or datetime.now(timezone.utc).date())
    parents = _sql_json(rows)
    return f"""DO $nuri_alpha_seed$
DECLARE
  parents constant jsonb := {parents};
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('nuri-alpha-community-parents:v1', 0));

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(parents) AS p(doc)
    JOIN public.users u ON u.id = p.doc->>'id' OR u.email = p.doc->>'email'
    WHERE u.id IS DISTINCT FROM p.doc->>'id'
       OR u.email IS DISTINCT FROM p.doc->>'email'
       OR u.hashed_password IS DISTINCT FROM '{PASSWORD_DISABLED}'
       OR u.is_internal IS DISTINCT FROM true
  ) THEN
    RAISE EXCEPTION 'Alpha parent identity collision; no records written';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(parents) AS p(doc)
    CROSS JOIN LATERAL jsonb_array_elements(p.doc->'children') AS c(doc)
    JOIN public.children ch ON ch.id = c.doc->>'id'
    WHERE ch.user_id IS DISTINCT FROM p.doc->>'id'
  ) THEN
    RAISE EXCEPTION 'Alpha child identity collision; no records written';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(parents) AS p(doc)
    JOIN public.community_profiles profile ON profile.user_id = p.doc->>'id'
    WHERE left(profile.about, char_length('{ABOUT_PREFIX}')) IS DISTINCT FROM '{ABOUT_PREFIX}'
  ) THEN
    RAISE EXCEPTION 'Existing profile is missing the Alpha bot marker; no records written';
  END IF;

  INSERT INTO public.users AS existing (
    id, email, nickname, city, parent_role, top_concerns, hashed_password, language,
    is_internal, daily_push, allow_history_training, anonymous_community_share, onboarding_completed
  )
  SELECT p.doc->>'id', p.doc->>'email', p.doc->>'name', p.doc->>'city', p.doc->>'role',
         ARRAY[p.doc->>'concern'], '{PASSWORD_DISABLED}', p.doc->>'language',
         true, false, false, false, true
    FROM jsonb_array_elements(parents) AS p(doc)
  ON CONFLICT (id) DO UPDATE SET language = excluded.language, city = excluded.city
    WHERE existing.email = excluded.email AND existing.hashed_password = '{PASSWORD_DISABLED}'
      AND existing.is_internal
      AND (existing.language, existing.city) IS DISTINCT FROM (excluded.language, excluded.city);

  INSERT INTO public.children (id, user_id, nickname, birth_date)
  SELECT c.doc->>'id', p.doc->>'id', c.doc->>'nickname', (c.doc->>'birth_date')::date
    FROM jsonb_array_elements(parents) AS p(doc)
    CROSS JOIN LATERAL jsonb_array_elements(p.doc->'children') AS c(doc)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.community_profiles AS existing
    (user_id, display_name, about, city_label, gender_tag, intent_codes)
  SELECT p.doc->>'id', p.doc->>'name', p.doc->>'about', p.doc->>'city', p.doc->>'gender_tag',
         CASE p.doc->>'activity'
           WHEN 'high' THEN ARRAY['share_parenting_ideas', 'talk_parenting', 'casual_chat']
           WHEN 'medium' THEN ARRAY['share_parenting_ideas', 'similar_experiences']
           ELSE ARRAY['similar_experiences']
         END
    FROM jsonb_array_elements(parents) AS p(doc)
  ON CONFLICT (user_id) DO UPDATE SET about = excluded.about, city_label = excluded.city_label
    WHERE left(existing.about, char_length('{ABOUT_PREFIX}')) = '{ABOUT_PREFIX}'
      AND (existing.about, existing.city_label) IS DISTINCT FROM (excluded.about, excluded.city_label);

  INSERT INTO public.community_preferences (user_id, parent_message_notifications_enabled, profile_hidden)
  SELECT p.doc->>'id', false, false
    FROM jsonb_array_elements(parents) AS p(doc)
  ON CONFLICT (user_id) DO NOTHING;
END;
$nuri_alpha_seed$;
"""


def verify_sql(personas: list[dict]) -> str:
    rows = _database_rows(personas, datetime.now(timezone.utc).date())
    expected = _sql_json([
        {
            "id": row["id"], "email": row["email"], "activity": row["activity"],
            "language": row["language"], "city": row["city"], "about": row["about"],
            "children": [child["id"] for child in row["children"]],
        }
        for row in rows
    ])
    return f"""WITH expected AS (
  SELECT doc->>'id' AS id, doc->>'email' AS email, doc->>'activity' AS activity,
         doc->>'language' AS language, doc->>'city' AS city, doc->>'about' AS about,
         doc->'children' AS children
    FROM jsonb_array_elements({expected}) AS p(doc)
), verified AS (
  SELECT e.*,
         u.id IS NOT NULL AS provisioned,
         p.user_id IS NOT NULL AS has_profile,
         (u.language, u.city, p.city_label, p.about)
           IS NOT DISTINCT FROM (e.language, e.city, e.city, e.about) AS current_profile,
         (v.user_id IS NOT NULL AND NOT v.profile_hidden) AS visible,
         (v.user_id IS NOT NULL AND NOT v.parent_message_notifications_enabled) AS push_disabled,
         (SELECT count(*) FROM jsonb_array_elements_text(e.children) c(id)
            JOIN public.children ch ON ch.id = c.id AND ch.user_id = e.id) AS kids
    FROM expected e
    LEFT JOIN public.users u
      ON u.id = e.id AND u.email = e.email AND u.hashed_password = '{PASSWORD_DISABLED}'
      AND u.is_internal AND NOT u.daily_push AND NOT u.allow_history_training
    LEFT JOIN public.community_profiles p ON p.user_id = u.id
      AND left(p.about, char_length('{ABOUT_PREFIX}')) = '{ABOUT_PREFIX}'
    LEFT JOIN public.community_preferences v ON v.user_id = u.id
)
SELECT activity, count(*)::integer AS expected_parents,
       (count(*) FILTER (WHERE provisioned AND has_profile AND visible AND push_disabled))::integer AS ready_parents,
       (count(*) FILTER (WHERE current_profile))::integer AS current_profiles,
       array_agg(DISTINCT language ORDER BY language) FILTER (WHERE current_profile) AS current_languages,
       (count(DISTINCT city) FILTER (WHERE current_profile))::integer AS current_cities,
       sum(jsonb_array_length(children))::integer AS expected_children, sum(kids)::integer AS provisioned_children
  FROM verified
 GROUP BY activity
 ORDER BY activity;
"""


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-ref", required=True, choices=[ALPHA_PROJECT_REF])
    parser.add_argument("--verify", action="store_true", help="Print the read-only verification query")
    args = parser.parse_args()
    personas = load_personas()
    print(verify_sql(personas) if args.verify else seed_sql(personas, project_ref=args.project_ref))
