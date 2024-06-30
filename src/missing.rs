use itertools::Itertools;

use crate::{
    manifest::{Manifest, ManifestOverride},
    wiki::WikiCache,
    REPO,
};

pub fn save_missing_games(wiki_cache: &WikiCache, manifest: &Manifest, overrides: &ManifestOverride) {
    let lines: Vec<String> = wiki_cache
        .0
        .iter()
        .sorted_by(|(k1, _), (k2, _)| k1.to_lowercase().cmp(&k2.to_lowercase()))
        .filter(|(k, _)| {
            manifest
                .0
                .get(*k)
                .map(|x| x.files.is_empty() && x.registry.is_empty())
                .unwrap_or(true)
        })
        .filter(|(k, _)| overrides.0.get(*k).map(|x| !x.omit).unwrap_or(true))
        .map(|(k, v)| format!("* [{}](https://www.pcgamingwiki.com/wiki/?curid={})", k, v.page_id))
        .collect();

    _ = std::fs::write(
        format!("{}/data/missing.md", REPO),
        if lines.is_empty() {
            "N/A".to_string()
        } else {
            lines.join("\n") + "\n"
        },
    );
}
