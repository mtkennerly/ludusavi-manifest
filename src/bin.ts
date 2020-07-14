import * as minimist from "minimist";

import { ManifestFile } from "./manifest";
import { SteamGameCacheFile, getSteamClient } from "./steam";
import { WikiGameCacheFile } from "./wiki";
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
    tooBroad?: boolean,
    tooBroadUntagged?: boolean,
    game?: string,
    limit?: number,
}

async function main() {
    const args = minimist<Cli>(process.argv.slice(2));

    const wikiCache = new WikiGameCacheFile();
    wikiCache.load();
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
            await wikiCache.addNewGames(manifest.data);
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
                    game: args.game,
                },
                args.limit ?? 25,
                steamCache,
            );
        }

        wikiCache.save();
        steamCache.save();
        manifest.save();
        saveMissingGames(wikiCache.data, manifest.data);
        steamCache.steamClient.logOff();
        process.exit(0);
    } catch (e) {
        wikiCache.save();
        steamCache.save();
        manifest.save();
        saveMissingGames(wikiCache.data, manifest.data);
        steamCache.steamClient.logOff();
        throw e;
    }
}

main();
