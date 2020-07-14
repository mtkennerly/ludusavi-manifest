import * as fs from "fs";
import { REPO } from ".";
import { Manifest } from "./manifest";
import { WikiGameCache } from "./wiki";

export function saveMissingGames(cache: WikiGameCache, manifest: Manifest): void {
    fs.writeFileSync(
        `${REPO}/data/missing.md`,
        Object.entries(cache)
            .sort((x, y) => x[0].localeCompare(y[0]))
            .filter(([k, _]) => (manifest[k]?.files ?? []).length === 0 && (manifest[k]?.registry ?? []).length === 0)
            .map(([k, v]) => `* [${k}](https://www.pcgamingwiki.com/wiki/?curid=${v.pageId})`)
            .join("\n") + "\n",
    );
}
