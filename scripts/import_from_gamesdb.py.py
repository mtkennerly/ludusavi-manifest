#!/usr/bin/env python3

from __future__ import annotations

import argparse
import logging
import re
import sqlite3
import sys
from contextlib import suppress
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap

yaml = YAML()
yaml.indent(mapping=2, sequence=4, offset=2)
yaml.preserve_quotes = False
yaml.width = 4096

SPECIAL_PATH_MAP: Dict[str, Optional[str]] = {
    "%APPDATA%": "<winAppData>",
    "%APPDATA_COMMON%": "<winAppData>",
    "%APPDATA_LOCAL%": "<winLocalAppData>",
    "%APPDATA_LOCALLOW%": "<home>/AppData/LocalLow",
    "%DOCUMENTS%": "<winDocuments>",
    "%PROG_FILES_86%": "C:/Program Files (x86)",
    "%SAVED_GAMES%": "<home>/Saved Games",
    "%SHARED_DOCUMENTS%": "<winPublic>/Documents",
    "%STEAM%": "<base>",
    "%STEAM_CACHE%": "<home>/AppData/Local/Steam",
    "%STEAM_CLOUD%": "<home>/AppData/Local/Steam/userdata",
    "%UPLAY%": "<winAppData>/Ubisoft",
    "%USER_PROFILE%": "<home>",
    "%REGISTRY%": None,
}

SIMILARITY_THRESHOLD = 0.66
DEFAULT_DB_PATH = Path("tmp/games.db")
DEFAULT_EXTERNAL_PATH = Path("data/manifest-extra.yaml")
DEFAULT_WIKI_PATH = Path("data/wiki-game-cache.yaml")
DEFAULT_STEAM_PATH = Path("data/steam-game-cache.yaml")

logger = logging.getLogger(__name__)


def decode_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, bytes):
        for enc in ("utf-8-sig", "utf-8", "latin-1", "cp1252"):
            try:
                return value.decode(enc)
            except UnicodeDecodeError:
                continue
        return value.decode("utf-8", errors="replace")
    return str(value)


def normalize_file_path(path: str) -> str:
    return path.replace("\\", "/").strip()


def normalize_registry_path(path: str) -> str:
    return path.strip()


def normalize_title(value: Any) -> str:
    text = str(value).strip()
    while len(text) >= 2 and text[0] == text[-1] and text[0] in ('"', "'"):
        inner = text[1:-1].strip()
        if not inner:
            break
        text = inner
    text = text.replace("''", "'")
    return text


def normalize_name(value: str) -> str:
    text = str(value).lower().strip()
    text = text.replace("’", "'").replace("“", '"').replace("”", '"')
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_compact_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", normalize_name(value))


def should_preserve_alias(raw_title: str, title: str) -> bool:
    raw_normalized = raw_title.strip()
    if raw_normalized == title:
        return False
    if (
        len(raw_normalized) >= 2
        and raw_normalized[0] == raw_normalized[-1]
        and raw_normalized[0] in ('"', "'")
        and raw_normalized[1:-1].strip() == title
    ):
        return False
    return True


def normalize_manifest_entry(game: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(game)

    if isinstance(normalized.get("alias"), str):
        normalized["alias"] = normalize_title(normalized["alias"])

    for section, normalizer in (
        ("installDir", normalize_file_path),
        ("files", normalize_file_path),
        ("registry", normalize_registry_path),
    ):
        section_data = normalized.get(section)
        if isinstance(section_data, dict):
            normalized_section: Dict[str, Any] = {}
            for key, value in section_data.items():
                normalized_key = normalizer(str(key))
                if (
                    normalized_key in normalized_section
                    and isinstance(normalized_section[normalized_key], dict)
                    and isinstance(value, dict)
                ):
                    existing = normalized_section[normalized_key]
                    incoming_tags = set(value.get("tags", []))
                    existing_tags = set(existing.get("tags", []))
                    if incoming_tags - existing_tags:
                        existing["tags"] = sorted(existing_tags | incoming_tags)
                else:
                    normalized_section[normalized_key] = value
            normalized[section] = normalized_section

    return normalized


def load_wiki_game_ids(
    path: Path,
) -> Tuple[
    Dict[str, Dict[str, Optional[int]]], Dict[str, Set[str]], Dict[str, Set[str]]
]:
    wiki: Dict[str, Dict[str, Optional[int]]] = {}
    normalized: Dict[str, Set[str]] = {}
    compact: Dict[str, Set[str]] = {}
    current_title: Optional[str] = None
    current_steam: Optional[int] = None

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue

            if not line.startswith(" ") and stripped.endswith(":"):
                if current_title is not None:
                    wiki[current_title] = {"steam": current_steam}
                current_title = normalize_title(stripped[:-1])
                current_steam = None
                continue

            if current_title is None:
                continue

            if stripped.startswith("steam:"):
                _, _, value = stripped.partition(":")
                try:
                    current_steam = int(value.strip())
                except ValueError:
                    current_steam = None

    if current_title is not None:
        wiki[current_title] = {"steam": current_steam}

    for title in wiki:
        n = normalize_name(title)
        if n:
            normalized.setdefault(n, set()).add(title)
        c = normalize_compact_name(title)
        if c:
            compact.setdefault(c, set()).add(title)

    return wiki, normalized, compact


def load_steam_cache(path: Path) -> Tuple[Dict[str, Set[int]], Dict[int, str]]:
    install_dirs: Dict[str, Set[int]] = {}
    id_to_install_dir: Dict[int, str] = {}
    current_id: Optional[int] = None

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.endswith(":") and stripped[:-1].isdigit():
                current_id = int(stripped[:-1])
                continue
            if current_id is None:
                continue
            if stripped.startswith("installDir:"):
                _, _, install_dir = stripped.partition(":")
                install_dir = install_dir.strip().strip('"').strip("'")
                id_to_install_dir[current_id] = install_dir
                n = normalize_name(install_dir)
                if n:
                    install_dirs.setdefault(n, set()).add(current_id)
                c = normalize_compact_name(install_dir)
                if c:
                    install_dirs.setdefault(c, set()).add(current_id)

    return install_dirs, id_to_install_dir


def choose_wiki_title(
    title: str,
    wiki_info: Dict[str, Any],
    normalized: Dict[str, Set[str]],
    compact: Dict[str, Set[str]],
) -> Optional[str]:
    if title in wiki_info:
        return title
    n = normalize_name(title)
    if n in normalized and len(normalized[n]) == 1:
        return next(iter(normalized[n]))
    c = normalize_compact_name(title)
    if c in compact and len(compact[c]) == 1:
        return next(iter(compact[c]))
    return None


def choose_steam_id(
    title: str,
    wiki_info: Dict[str, Any],
    install_dirs: Dict[str, Set[int]],
) -> Optional[int]:
    if title in wiki_info and wiki_info[title]["steam"] is not None:
        return wiki_info[title]["steam"]
    n = normalize_name(title)
    if n in install_dirs and len(install_dirs[n]) == 1:
        return next(iter(install_dirs[n]))
    c = normalize_compact_name(title)
    if c in install_dirs and len(install_dirs[c]) == 1:
        return next(iter(install_dirs[c]))
    return None


def similarity_score(a: Set[str], b: Set[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def merge_manifest_entries(existing: dict, incoming: dict) -> dict:
    merged = dict(existing)

    if incoming.get("steam") and not merged.get("steam"):
        merged["steam"] = incoming["steam"]

    for section in ("installDir", "files", "registry"):
        incoming_section = incoming.get(section)
        if not isinstance(incoming_section, dict):
            continue
        existing_section = merged.setdefault(section, {})
        for key, value in incoming_section.items():
            if key not in existing_section:
                existing_section[key] = value
                continue
            if isinstance(existing_section[key], dict) and isinstance(value, dict):
                existing_tags = set(existing_section[key].get("tags", []))
                incoming_tags = set(value.get("tags", []))
                if incoming_tags - existing_tags:
                    existing_section[key]["tags"] = sorted(
                        existing_tags | incoming_tags
                    )

    if incoming.get("alias") and not merged.get("alias"):
        merged["alias"] = incoming["alias"]

    return merged


def normalize_external_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    cleaned: Dict[str, Any] = {}
    for raw_title, game in manifest.items():
        if not isinstance(raw_title, str) or not isinstance(game, dict):
            continue
        title = normalize_title(raw_title)
        if not title:
            continue

        game = normalize_manifest_entry(dict(game))
        if title in cleaned:
            cleaned[title] = merge_manifest_entries(cleaned[title], game)
            if (
                title != raw_title
                and cleaned[title].get("alias") is None
                and should_preserve_alias(raw_title, title)
            ):
                cleaned[title]["alias"] = raw_title
        else:
            if (
                title != raw_title
                and game.get("alias") is None
                and should_preserve_alias(raw_title, title)
            ):
                game["alias"] = raw_title
            cleaned[title] = game
    return cleaned


def sort_manifest(manifest: Dict[str, Any]) -> CommentedMap:
    ordered = CommentedMap()
    for title in sorted(manifest.keys(), key=lambda x: str(x).casefold()):
        ordered[title] = manifest[title]
    return ordered


def extract_paths(game: Dict[str, Any]) -> Tuple[Set[str], Set[str]]:
    files: Set[str] = set()
    registry: Set[str] = set()
    if isinstance(game, dict):
        for p in game.get("files", {}):
            files.add(normalize_file_path(str(p)))
        for p in game.get("registry", {}):
            registry.add(normalize_registry_path(str(p)))
    return files, registry


def build_manifest_index(manifest: Dict[str, Any]) -> Tuple[
    Dict[str, Dict[str, Any]],
    Dict[str, Set[str]],
    Dict[str, Set[str]],
]:
    games: Dict[str, Dict[str, Any]] = {}
    path_index: Dict[str, Set[str]] = {}
    reg_index: Dict[str, Set[str]] = {}

    for title, game in manifest.items():
        files, registry = extract_paths(game)
        games[title] = {
            "game": game,
            "files": files,
            "registry": registry,
        }
        for p in files:
            path_index.setdefault(p, set()).add(title)
        for r in registry:
            reg_index.setdefault(r, set()).add(title)

    return games, path_index, reg_index


def best_match_for_game(
    files: Set[str],
    registry: Set[str],
    games: Dict[str, Dict[str, Any]],
    path_index: Dict[str, Set[str]],
    reg_index: Dict[str, Set[str]],
) -> Tuple[Optional[str], float]:
    candidates: Set[str] = set()
    for p in files:
        candidates |= path_index.get(p, set())
    for r in registry:
        candidates |= reg_index.get(r, set())

    if not candidates:
        return None, 0.0

    best_title = None
    best_score = 0.0
    for candidate in candidates:
        c_files = games[candidate]["files"]
        c_registry = games[candidate]["registry"]
        score = 0.0
        count = 0
        if files or c_files:
            score += similarity_score(files, c_files)
            count += 1
        if registry or c_registry:
            score += similarity_score(registry, c_registry)
            count += 1
        score = score / count if count else 0.0
        if score > best_score:
            best_score = score
            best_title = candidate

    if best_title is not None and best_score >= SIMILARITY_THRESHOLD:
        return best_title, best_score
    return None, best_score


def load_games_from_db(db_path: Path) -> Dict[str, Dict[str, Any]]:
    if not db_path.exists():
        raise FileNotFoundError(f"SQLite DB not found: '{db_path}'")

    try:
        with db_path.open("rb") as f:
            header = f.read(16)
        if not header.startswith(b"SQLite format 3"):
            raise RuntimeError(f"'{db_path}' is not a valid SQLite database.")
    except OSError as e:
        raise RuntimeError(f"Cannot read DB file '{db_path}': {e}") from e

    conn: Optional[sqlite3.Connection] = None
    try:
        conn = sqlite3.connect(str(db_path))
        conn.text_factory = bytes
        cur = conn.cursor()

        cur.execute("SELECT id, GameName FROM GameEntry")
        id_to_name: Dict[int, str] = {
            row[0]: decode_text(row[1]) for row in cur.fetchall()
        }

        id_to_dirs: Dict[int, List[Dict[str, str]]] = {}
        cur.execute("SELECT GameID, SpecialPath, Path, DefinedFiles FROM Directories")
        for row in cur.fetchall():
            gid = row[0]
            id_to_dirs.setdefault(gid, []).append(
                {
                    "sp": decode_text(row[1]),
                    "path": decode_text(row[2]).replace("\\", "/") if row[2] else "",
                    "files": decode_text(row[3]) if row[3] else "",
                }
            )

        id_to_reg: Dict[int, List[str]] = {}
        cur.execute("SELECT GameID, Hive, Path FROM RegistryList")
        for row in cur.fetchall():
            gid = row[0]
            hive = decode_text(row[1]) or ""
            path = decode_text(row[2]).replace("\\", "/") if row[2] else ""
            full_reg = f"{hive}/{path}" if path else hive
            if full_reg:
                id_to_reg.setdefault(gid, []).append(full_reg)

    except sqlite3.DatabaseError as e:
        raise RuntimeError(
            f"Unable to open SQLite DB '{db_path}': {e}.\n"
            "The file may be corrupted or not a valid GSM SQLite export."
        ) from e
    finally:
        if conn:
            conn.close()

    games: Dict[str, Dict[str, Any]] = {}
    for gid, raw_name in id_to_name.items():
        name = normalize_title(raw_name)
        if not name:
            continue

        game: Dict[str, Any] = {}
        files: Dict[str, Dict[str, List[str]]] = {}
        for d in id_to_dirs.get(gid, []):
            if d["sp"] == "%REGISTRY%":
                continue
            ph = SPECIAL_PATH_MAP.get(d["sp"])
            if ph is None:
                continue

            base_path = f"{ph}/{d['path']}" if d["path"] else ph
            if d["files"] and d["files"] != "*.*":
                for file_pattern in d["files"].split("|"):
                    file_pattern = file_pattern.strip()
                    if not file_pattern:
                        continue
                    file_pattern = normalize_file_path(file_pattern)
                    p = f"{base_path}/{file_pattern}"
                    if p not in files:
                        files[p] = {"tags": ["save"]}

        if files:
            game["files"] = files

        registry: Dict[str, Dict[str, List[str]]] = {}
        for r in id_to_reg.get(gid, []):
            if r not in registry:
                registry[r] = {"tags": ["save"]}
        if registry:
            game["registry"] = registry

        if game:
            games[name] = game

    return games


def add_new_paths_to_game(
    title: str,
    game_dict: Dict[str, Any],
    new_files: Set[str],
    new_registry: Set[str],
    games_index: Dict[str, Dict[str, Any]],
    path_index: Dict[str, Set[str]],
    reg_index: Dict[str, Set[str]],
) -> None:
    if new_files:
        existing_files = game_dict.setdefault("files", {})
        for p in sorted(new_files):
            existing_files[p] = {"tags": ["save"]}
        games_index[title]["files"].update(new_files)
        for p in new_files:
            path_index.setdefault(p, set()).add(title)

    if new_registry:
        existing_registry = game_dict.setdefault("registry", {})
        for r in sorted(new_registry):
            existing_registry[r] = {"tags": ["save"]}
        games_index[title]["registry"].update(new_registry)
        for r in new_registry:
            reg_index.setdefault(r, set()).add(title)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fusiona manifiestos de juegos desde base de datos GSM y cachés."
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB_PATH,
        help=f"Ruta a la base de datos SQLite (por defecto: {DEFAULT_DB_PATH})",
    )
    parser.add_argument(
        "--external",
        type=Path,
        default=DEFAULT_EXTERNAL_PATH,
        help=f"Ruta del manifiesto externo YAML (por defecto: {DEFAULT_EXTERNAL_PATH})",
    )
    parser.add_argument(
        "--wiki",
        type=Path,
        default=DEFAULT_WIKI_PATH,
        help=f"Ruta del caché wiki (por defecto: {DEFAULT_WIKI_PATH})",
    )
    parser.add_argument(
        "--steam",
        type=Path,
        default=DEFAULT_STEAM_PATH,
        help=f"Ruta del caché Steam (por defecto: {DEFAULT_STEAM_PATH})",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Muestra información detallada del progreso",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )

    with suppress(Exception):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    logger.info("Loading external manifest from %s", args.external)
    manifest: Dict[str, Any] = {}
    manifest_changed = False

    if args.external.exists():
        try:
            with open(args.external, "r", encoding="utf-8") as f:
                loaded = yaml.load(f) or {}
            if not isinstance(loaded, dict):
                raise ValueError("external manifest is not a mapping")
            cleaned = normalize_external_manifest(loaded)
            manifest = cleaned
            if len(cleaned) != len(loaded):
                manifest_changed = True
            else:
                for raw_title in loaded.keys():
                    if normalize_title(raw_title) != raw_title:
                        manifest_changed = True
                        break
        except Exception as e:
            logger.warning("Unable to load %s: %s", args.external, e)
            logger.info("Rebuilding external manifest from scratch.")
            manifest = {}
            manifest_changed = False

    logger.info("Loading games from DB...")
    try:
        db_games = load_games_from_db(args.db)
    except (FileNotFoundError, RuntimeError) as e:
        logger.error(str(e))
        return 1

    logger.info("Loading wiki cache...")
    wiki_info, wiki_norm, wiki_compact = load_wiki_game_ids(args.wiki)

    logger.info("Loading steam cache...")
    steam_dirs, steam_id_to_dir = load_steam_cache(args.steam)

    logger.info("External manifest: %d games", len(manifest))
    logger.info("DB: %d games", len(db_games))
    logger.info("Wiki: %d titles", len(wiki_info))

    existing_games, path_index, reg_index = build_manifest_index(manifest)

    stats = {"merged": 0, "skipped": 0, "added": 0}

    for title, game in sorted(db_games.items()):
        files, registry = extract_paths(game)
        if not files and not registry:
            continue

        canonical = choose_wiki_title(title, wiki_info, wiki_norm, wiki_compact)
        target_title = canonical or title
        steam_id = choose_steam_id(target_title, wiki_info, steam_dirs)
        if steam_id is not None:
            game.setdefault("steam", {})["id"] = steam_id
            install_dir = steam_id_to_dir.get(steam_id)
            if install_dir:
                game.setdefault("installDir", {})[install_dir] = {}

        if target_title != title:
            game["alias"] = title

        if target_title in existing_games:
            existing = existing_games[target_title]
            new_files = files - existing["files"]
            new_registry = registry - existing["registry"]
            if not new_files and not new_registry:
                stats["skipped"] += 1
                continue

            add_new_paths_to_game(
                target_title,
                existing["game"],
                new_files,
                new_registry,
                existing_games,
                path_index,
                reg_index,
            )
            if target_title != title and existing["game"].get("alias") is None:
                existing["game"]["alias"] = title
            stats["merged"] += 1
            continue

        candidate_title, score = best_match_for_game(
            files, registry, existing_games, path_index, reg_index
        )
        if candidate_title:
            candidate = existing_games[candidate_title]
            new_files = files - candidate["files"]
            new_registry = registry - candidate["registry"]
            if not new_files and not new_registry:
                stats["skipped"] += 1
                continue

            add_new_paths_to_game(
                candidate_title,
                candidate["game"],
                new_files,
                new_registry,
                existing_games,
                path_index,
                reg_index,
            )
            if (
                candidate_title != target_title
                and candidate["game"].get("alias") is None
            ):
                candidate["game"]["alias"] = title
            stats["merged"] += 1
            continue

        manifest[target_title] = game
        existing_games[target_title] = {
            "game": game,
            "files": files,
            "registry": registry,
        }
        for p in files:
            path_index.setdefault(p, set()).add(target_title)
        for r in registry:
            reg_index.setdefault(r, set()).add(target_title)
        stats["added"] += 1

    logger.info("Matched or merged games: %d", stats["merged"])
    logger.info("Skipped duplicate/well-covered games: %d", stats["skipped"])
    logger.info("Added new external games: %d", stats["added"])

    if stats["added"] or stats["merged"] or manifest_changed:
        logger.info("Writing updated external manifest to %s", args.external)
        sorted_manifest = sort_manifest(manifest)
        with open(args.external, "w", encoding="utf-8") as f:
            yaml.dump(sorted_manifest, f)
        logger.info("Done!")
    else:
        logger.info("No changes to write.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
