import * as minimist from "minimist";

import { ManifestFile } from "./manifest";
import { SteamGameCacheFile, getSteamClient } from "./steam";
import { WikiGameCacheFile, WikiMetaCacheFile } from "./wiki";
import { saveMissingGames } from "./missing";

interface Cli {
    cache?: boolean,
    manifest?: boolean,
    stats?: boolean,
    all?: boolean,
    existing?: boolean,
    missing?: boolean,
    unchecked?: boolean,
    unsupportedOs?: boolean,
    unsupportedPath?: boolean,
    irregularPath?: boolean,
    irregularPathUntagged?: boolean,
    tooBroad?: boolean,
    tooBroadUntagged?: boolean,
    pathContains?: string,
    skipUntil?: string,
    recent?: boolean,
    limit?: number,
    steam?: boolean,
}

async function main() {
    const args = minimist<Cli>(process.argv.slice(2), {
        boolean: [
            "cache",
            "manifest",
            "stats",
            "all",
            "existing",
            "missing",
            "unchecked",
            "unsupportedOs",
            "unsupportedPath",
            "irregularPath",
            "irregularPathUntagged",
            "tooBroad",
            "tooBroadUntagged",
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
    const steamCache = new SteamGameCacheFile(await getSteamClient());
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
        if (args.cache) {
            if (args.recent) {
                await wikiCache.flagRecentChanges(wikiMetaCache);
            } else {
                await wikiCache.addNewGames();
            }
        }

        if (args.steam) {
            await steamCache.refresh(
                {
                    all: args.all,
                    skipUntil: args.skipUntil,
                    irregularUntagged: args.irregularPathUntagged,
                },
                args.limit ?? 25,
            );
        }

        if (args.manifest) {
            await manifest.updateGames(
                wikiCache.data,
                {
                    all: args.all ?? false,
                    existing: args.existing ?? false,
                    missing: args.missing ?? false,
                    unchecked: args.unchecked ?? false,
                    unsupportedOs: args.unsupportedOs ?? false,
                    unsupportedPath: args.unsupportedPath ?? false,
                    tooBroad: args.tooBroad ?? false,
                    tooBroadUntagged: args.tooBroadUntagged ?? false,
                    irregularPath: args.irregularPath ?? false,
                    irregularPathUntagged: args.irregularPathUntagged ?? false,
                    pathContains: args.pathContains,
                    skipUntil: args.skipUntil,
                    games: args._,
                    recent: args.recent,
                },
                args.limit ?? 25,
                steamCache,
            );
        }

        wikiCache.save();
        wikiMetaCache.save();
        steamCache.save();
        manifest.save();
        saveMissingGames(wikiCache.data, manifest.data);
        steamCache.steamClient.logOff();
        process.exit(0);
    } catch (e) {
        wikiCache.save();
        wikiMetaCache.save();
        steamCache.save();
        manifest.save();
        saveMissingGames(wikiCache.data, manifest.data);
        steamCache.steamClient.logOff();
        throw e;
    }
}

main();
