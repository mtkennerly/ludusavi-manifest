#!/usr/bin/env python3

import io
import locale
import os
import sqlite3
import sys
from pathlib import Path

from ruamel.yaml import YAML

yaml = YAML()
yaml.indent(mapping=2, sequence=4, offset=2)
yaml.preserve_quotes = True
yaml.width = 4096

SPECIAL_PATH_MAP = {
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


def decode_text(value) -> str:
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


def load_games_from_db(db_path):
    conn = sqlite3.connect(db_path)
    conn.text_factory = bytes
    cur = conn.cursor()

    cur.execute("SELECT id, GameName FROM GameEntry")
    id_to_name = {row[0]: decode_text(row[1]) for row in cur.fetchall()}

    # Load Directories
    id_to_dirs = {}
    cur.execute("SELECT GameID, SpecialPath, Path, DefinedFiles FROM Directories")
    for row in cur.fetchall():
        gid = row[0]
        if gid not in id_to_dirs:
            id_to_dirs[gid] = []
        id_to_dirs[gid].append(
            {
                "sp": decode_text(row[1]),
                "path": decode_text(row[2]).replace("\\", "/") if row[2] else "",
                "files": decode_text(row[3]) if row[3] else "",
            }
        )

    # Load Registry
    id_to_reg = {}
    cur.execute("SELECT GameID, Hive, Path FROM RegistryList")
    for row in cur.fetchall():
        gid = row[0]
        if gid not in id_to_reg:
            id_to_reg[gid] = []
        hive = decode_text(row[1]) or ""
        path = decode_text(row[2]).replace("\\", "/") if row[2] else ""
        full_reg = f"{hive}/{path}" if path else hive
        if full_reg:
            id_to_reg[gid].append(full_reg)
    conn.close()

    games = {}
    for gid, name in id_to_name.items():
        game = {}
        files = {}
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
                    file_pattern = file_pattern.replace("\\", "/")
                    p = f"{base_path}/{file_pattern}"
                    if p not in files:
                        files[p] = {"tags": ["save"]}
            else:
                # Some rows only contain a base folder with no specific files.
                # We skip bare "*.*" paths because they are not useful for manifest entries.
                continue

        if files:
            game["files"] = files

        registry = {}
        for r in id_to_reg.get(gid, []):
            if r not in registry:
                registry[r] = {"tags": ["save"]}
        if registry:
            game["registry"] = registry
        if game:
            games[name] = game
    return games


def main():
    # Ensure unicode-safe output on Windows consoles.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    external_path = Path("data/manifest-extra.yaml")
    print(f"Loading external manifest source from {external_path}...")

    manifest = {}
    if external_path.exists():
        try:
            with open(external_path, "r", encoding="utf-8") as f:
                manifest = yaml.load(f) or {}
            if not isinstance(manifest, dict):
                raise ValueError("external manifest is not a mapping")
        except Exception as e:
            print(
                f"Warning: unable to load existing {external_path}: {e}.",
                file=sys.stderr,
            )
            print("Rebuilding external manifest from scratch.")
            manifest = {}

    print("Loading games from DB...")
    db_games = load_games_from_db("tmp/games.db")
    print(f"External manifest has {len(manifest)} games")
    print(f"DB has {len(db_games)} games")

    missing = {k: v for k, v in db_games.items() if k not in manifest}
    print(f"Games missing from external source: {len(missing)}")

    if not missing:
        print("Nothing to add!")
        return 0

    print("\nMissing games (first 20 shown):")
    for name in sorted(missing.keys())[:20]:
        print(f"  - {name}")

    print("\nAppending to external manifest source...")
    manifest.update(missing)

    with open(external_path, "w", encoding="utf-8") as f:
        yaml.dump(manifest, f)

    print("Done!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
