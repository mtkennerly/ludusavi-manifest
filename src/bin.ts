import minimist from "minimist";

import { DEFAULT_GAME_LIMIT } from ".";
import { ManifestFile } from "./manifest";
import { SteamGameCacheFile, getSteamClient } from "./steam";
import { WikiGameCacheFile, WikiMetaCacheFile } from "./wiki";
import { saveMissingGames } from "./missing";

interface Cli {
    wiki?: boolean,
    manifest?: boolean,
    stats?: boolean,
    all?: boolean,
    irregularPathUntagged?: boolean,
    skipUntil?: string,
    recent?: boolean,
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

    if (args.stats) {
        console.log(`Total games in manifest: ${Object.keys(manifest.data).length}`);
        console.log(`Total games in manifest with files or registry: ${Object.values(manifest.data).filter(x => x.files !== undefined || x.registry !== undefined).length}`);
        console.log(`Total games in manifest without files and registry: ${Object.values(manifest.data).filter(x => x.files === undefined && x.registry === undefined).length}`);
        console.log(`Total games in wiki cache: ${Object.keys(wikiCache.data).length}`);
        process.exit(0);
    }

    try {
        if (args.wiki) {
            if (args.recent) {
                await wikiCache.flagRecentChanges(wikiMetaCache);
            } else {
                await wikiCache.addNewGames();
            }

            await wikiCache.refresh(
                args.skipUntil,
                args.limit ?? DEFAULT_GAME_LIMIT,
                args.all ?? false,
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
                args._,
                steamCache,
            );
        }

        wikiCache.save();
        wikiMetaCache.save();
        steamCache.save();
        manifest.save();
        saveMissingGames(wikiCache.data, manifest.data);
        if (steamCache.steamClient) {
            steamCache.steamClient.logOff();
        }
        process.exit(0);
    } catch (e) {
        wikiCache.save();
        wikiMetaCache.save();
        steamCache.save();
        manifest.save();
        saveMissingGames(wikiCache.data, manifest.data);
        if (steamCache.steamClient) {
            steamCache.steamClient.logOff();
        }
        throw e;
    }
}

main();
