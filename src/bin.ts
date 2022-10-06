import minimist from "minimist";

import { DEFAULT_GAME_LIMIT } from ".";
import { ManifestFile, ManifestOverrideFile } from "./manifest";
import { SteamGameCacheFile, getSteamClient } from "./steam";
import { WikiGameCacheFile, WikiMetaCacheFile } from "./wiki";
import { saveMissingGames } from "./missing";

interface Cli {
    wiki?: boolean,
    manifest?: boolean,
    stats?: boolean,
    duplicates?: boolean,
    all?: boolean,
    irregularPathUntagged?: boolean,
    skipUntil?: string,
    recent?: boolean,
    missing?: boolean,
    limit?: number,
    steam?: boolean,
}

async function main() {
    const args = minimist<Cli>(process.argv.slice(2), {
        boolean: [
            "wiki",
            "manifest",
            "stats",
            "all",
            "irregularPathUntagged",
            "steam",
            "missing",
        ],
        string: [
            "skipUntil",
        ],
    });

    const wikiCache = new WikiGameCacheFile();
    wikiCache.load();
    const wikiMetaCache = new WikiMetaCacheFile();
    wikiMetaCache.load();
    const steamCache = new SteamGameCacheFile(getSteamClient);
    steamCache.load();
    const manifest = new ManifestFile();
    manifest.load();
    const manifestOverride = new ManifestOverrideFile();
    manifestOverride.load();

    if (args.stats) {
        console.log(`Total games in manifest: ${Object.keys(manifest.data).length}`);
        console.log(`Total games in manifest with files or registry: ${Object.values(manifest.data).filter(x => x.files !== undefined || x.registry !== undefined).length}`);
        console.log(`Total games in manifest without files and registry: ${Object.values(manifest.data).filter(x => x.files === undefined && x.registry === undefined).length}`);
        console.log(`Total games in wiki cache: ${Object.keys(wikiCache.data).length}`);
        process.exit(0);
    }

    if (args.duplicates) {
        const data: {[key: string]: Array<{ name: string; pageId: number }>} = {};
        for (const [name, info] of Object.entries(manifest.data)) {
            const key = JSON.stringify(info);
            let safe = false;
            for (const file of Object.keys(info.files ?? {})) {
                if (file.includes("<game>") || file.includes("<base>")) {
                    safe = true;
                }
            }
            if (safe) {
                continue;
            }
            if (!(key in data)) {
                data[key] = [];
            }
            data[key].push({ name, pageId: wikiCache.data[name]?.pageId ?? 0 });
        }
        for (const games of Object.values(data)) {
            if (games.length > 1) {
                const lines = games.map(({ name, pageId }) => `[${pageId}] ${name}`);
                console.log(`\nSame manifest entry:\n  - ${lines.join("\n  - ")}`);
            }
        }
        process.exit(0);
    }

    try {
        if (args.wiki) {
            if (args.recent) {
                await wikiCache.flagRecentChanges(wikiMetaCache);
            } else if (args.missing) {
                await wikiCache.addNewGames();
            }

            await wikiCache.refresh(
                args.skipUntil,
                args.limit ?? DEFAULT_GAME_LIMIT,
                args.all ?? false,
                args._ ?? [],
            );
        }

        if (args.steam) {
            await steamCache.refresh(
                args.skipUntil,
                args.irregularPathUntagged ?? false,
                args.limit ?? DEFAULT_GAME_LIMIT,
            );
        }

        if (args.manifest) {
            await manifest.updateGames(
                wikiCache.data,
                args._ ?? [],
                steamCache,
                manifestOverride,
            );
        }

        wikiCache.save();
        wikiMetaCache.save();
        steamCache.save();
        manifest.save();
        saveMissingGames(wikiCache.data, manifest.data, manifestOverride.data);
        if (steamCache.steamClient) {
            steamCache.steamClient.logOff();
        }
        process.exit(0);
    } catch (e) {
        wikiCache.save();
        wikiMetaCache.save();
        steamCache.save();
        manifest.save();
        saveMissingGames(wikiCache.data, manifest.data, manifestOverride.data);
        if (steamCache.steamClient) {
            steamCache.steamClient.logOff();
        }
        throw e;
    }
}

main();
